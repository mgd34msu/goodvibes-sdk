/**
 * credentials.set / credentials.delete, writing a credential through the
 * daemon instead of into a client's own secret store.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `credentials.get` has existed since the config-sharing work: a surface can
 * ask the daemon, over the wire, which credentials are configured and usable.
 * There has never been a way to SET one. Every product wrote secrets through an
 * in-process SecretsManager against its own disk, which works exactly as long
 * as the client and the daemon share a filesystem, and produces the platform's
 * oldest recurring failure the moment they do not: a credential pasted into a
 * settings modal reports success, lands in a store the daemon never reads, and
 * the capability it configures stays dead with no error anywhere.
 *
 * ── What a write actually does, in order ───────────────────────────────────
 *
 * The same four steps the plaintext sweep uses, for the same reason:
 *
 *   1. Derive the secret-store name from the config path
 *      (`daemonSecretKeyFor`, one derivation, platform-wide).
 *   2. Write the value into the secret store at the scope the ownership rules
 *      resolve (`resolveSecretWriteScope`); a daemon-needed credential goes to
 *      the daemon tier no matter who asked.
 *   3. Read it BACK out of the store and compare.
 *   4. Only then replace the config value with its
 *      `goodvibes://secrets/goodvibes/<KEY>` reference.
 *
 * If step 3 does not match, the config value is left exactly as it was and the
 * call fails. A config key pointing at a reference that resolves to nothing is
 * worse than a key that was never written: every reader treats it as a
 * configured-but-broken credential, and the surface that wrote it was told the
 * write succeeded.
 *
 * ── What never comes back ──────────────────────────────────────────────────
 *
 * The value. Not on success, not in an error, not in a log line. The response
 * names the config key, the secret-store key, the scope it landed in and the
 * reference the config now holds, everything an operator needs to verify the
 * write, and nothing that repeats the credential. `credentials.get` remains the
 * only read, and it is secret-free by construction.
 *
 * ── Auth posture ───────────────────────────────────────────────────────────
 *
 * `access: 'admin'` and `write:config`, matching `config.set` and
 * `credentials.get`, a credential write is a config write whose value happens
 * to be secret, and it must not be reachable by a scoped-down token that was
 * only granted session access. Step-up rides the platform's existing rule
 * rather than a per-verb flag: these are MUTATING calls, so when
 * `relay.requireStepUpForMutations` is on, a call arriving over the relay is
 * refused without a fresh WebAuthn assertion by the same dispatch gate that
 * covers `config.set` (relay/daemon-wiring.ts). A second, verb-local step-up
 * mechanism would be a different control with different failure modes guarding
 * the same class of act.
 */

import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { configKeyScope, describeConfigOwnership } from '../../config/config-ownership.js';
import {
  isSecretBearingConfigKey,
  isSecretReferenceValue,
} from '../../config/secret-bearing-config-keys.js';
import { secretReferenceFor } from '../../config/plaintext-credential-sweep.js';
import {
  describeSecretWriteScope,
  resolveSecretWriteScope,
  type SecretScope,
} from '../../config/secrets.js';
import { logger } from '../../utils/logger.js';

/** The narrow config surface a credential write needs. Structural, so it is testable. */
export interface CredentialWriteConfig {
  get(key: string): unknown;
  setDynamic(key: string, value: unknown): void;
}

/** The narrow secret surface a credential write needs. */
export interface CredentialWriteSecrets {
  set(key: string, value: string, options?: { scope?: SecretScope | undefined }): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string, options?: { scope?: SecretScope | undefined }): Promise<void>;
}

export interface CredentialWriteDeps {
  readonly config: CredentialWriteConfig;
  readonly secrets: CredentialWriteSecrets;
  /**
   * Extra config paths this product treats as credential-bearing, beyond the
   * platform's declared set. Same escape hatch the sweep offers.
   */
  readonly additionalSecretKeys?: readonly string[] | undefined;
  /**
   * Where the audit line goes. Defaults to the platform logger at info. Never
   * receives a value, only key names, scope and outcome.
   */
  readonly audit?: ((entry: CredentialWriteAuditEntry) => void) | undefined;
}

/** One credential write or clear, as recorded. Contains no secret material. */
export interface CredentialWriteAuditEntry {
  readonly action: 'set' | 'delete';
  readonly configKey: string;
  readonly secretKey: string;
  readonly scope: SecretScope;
  readonly outcome: 'stored' | 'cleared' | 'refused';
  /** The authenticated principal the daemon observed, when there was one. */
  readonly principalId?: string | undefined;
  readonly principalKind?: string | undefined;
  readonly surface?: string | undefined;
  readonly detail?: string | undefined;
}

function invalid(message: string, field: string): GatewayVerbError {
  return new GatewayVerbError(message, 'INVALID_ARGUMENT', 400, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`Invalid ${field}: expected a non-empty string`, field);
  }
  return value;
}

/**
 * Refuse a key whose value is not credential material.
 *
 * Not politeness, routing. This verb stores its value in the secret store and
 * leaves a reference behind, and doing that to an ordinary setting would leave
 * a `goodvibes://secrets/…` string where a number or a boolean belongs, which
 * every reader of that key would then fail to parse. `config.set` is the verb
 * for those, and the refusal says so.
 */
function requireSecretBearingKey(key: string, additional: readonly string[]): void {
  if (isSecretBearingConfigKey(key) || additional.includes(key)) return;
  throw invalid(
    `${key} is not a credential-bearing setting, so it must not be stored as a secret: `
    + 'this verb replaces the config value with a goodvibes://secrets/ reference, which is not a '
    + 'readable value for an ordinary setting. Use config.set for it.',
    'key',
  );
}

function principalFields(invocation: GatewayMethodInvocation): Pick<
  CredentialWriteAuditEntry, 'principalId' | 'principalKind' | 'surface'
> {
  return {
    ...(invocation.context.principalId ? { principalId: invocation.context.principalId } : {}),
    ...(invocation.context.principalKind ? { principalKind: invocation.context.principalKind } : {}),
    ...(invocation.context.clientKind ? { surface: invocation.context.clientKind } : {}),
  };
}

function record(deps: CredentialWriteDeps, entry: CredentialWriteAuditEntry): void {
  if (deps.audit) {
    deps.audit(entry);
    return;
  }
  logger.info('Credential write through the control plane', { ...entry });
}

/**
 * Store a credential for a secret-bearing config key.
 *
 * Returns key names, the resolved scope and the reference now in config, never
 * the value, and never a value-derived fingerprint either, which is a hash of a
 * short secret and therefore a way to confirm a guess.
 */
export function createCredentialSetHandler(deps: CredentialWriteDeps): GatewayMethodHandler {
  const additional = deps.additionalSecretKeys ?? [];
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const key = requireString(params['key'], 'key');
    const value = requireString(params['value'], 'value');
    requireSecretBearingKey(key, additional);
    if (isSecretReferenceValue(value)) {
      throw invalid(
        'Invalid value: this is a goodvibes://secrets/ reference, not a credential. Storing a '
        + 'reference as if it were the secret produces a pointer to a pointer, which resolves to '
        + 'nothing. Send the credential itself.',
        'value',
      );
    }

    const secretKey = daemonSecretKeyFor(key);
    const scope = resolveSecretWriteScope(secretKey);
    const audited = principalFields(invocation);

    try {
      // The scope is stated at the call site on purpose: it is the platform's
      // own answer for this key (resolveSecretWriteScope), so a reviewer can
      // see where a credential written through the wire lands, and the
      // credential-scope gate has a classified write to check.
      await deps.secrets.set(secretKey, value, { scope });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record(deps, { action: 'set', configKey: key, secretKey, scope, outcome: 'refused', ...audited, detail });
      throw new GatewayVerbError(
        `${key} was not stored: the secret store refused the write (${detail}). The setting was left exactly as it was.`,
        'CREDENTIAL_STORE_UNAVAILABLE',
        503,
        'key',
      );
    }

    const readBack = await deps.secrets.get(secretKey);
    if (readBack !== value) {
      record(deps, {
        action: 'set',
        configKey: key,
        secretKey,
        scope,
        outcome: 'refused',
        ...audited,
        detail: 'the secret store did not read back what was just written to it',
      });
      throw new GatewayVerbError(
        `${key} was not stored: the secret store did not read back what was just written to it. `
        + 'The setting was left exactly as it was, because a config key pointing at a reference that '
        + 'resolves to nothing reads as a configured-but-broken credential.',
        'CREDENTIAL_STORE_UNAVAILABLE',
        503,
        'key',
      );
    }

    const reference = secretReferenceFor(secretKey);
    deps.config.setDynamic(key, reference);
    record(deps, { action: 'set', configKey: key, secretKey, scope, outcome: 'stored', ...audited });

    return {
      success: true,
      key,
      secretKey,
      scope,
      reference,
      configScope: configKeyScope(key),
      // Both sentences are safe to display and neither contains a value: one
      // says where the SETTING is written, the other why the CREDENTIAL is
      // filed where it is. A surface shows them before or after asking.
      ownership: describeConfigOwnership(key),
      credentialScope: describeSecretWriteScope(secretKey),
    };
  };
}

/**
 * Remove a credential: the stored secret AND the config reference pointing at
 * it, in that order.
 *
 * Order matters and is the reverse of the write. Clearing the config first
 * would leave an orphaned secret in the store that nothing points at and
 * nothing reaps; clearing the secret first leaves, for an instant, a reference
 * that resolves to nothing, which every reader already treats as "configured
 * but broken", the honest state for a credential mid-removal.
 *
 * `cleared` is false when there was nothing to remove. That is a miss, not an
 * error: asking for a credential to be gone when it already is has succeeded.
 */
export function createCredentialDeleteHandler(deps: CredentialWriteDeps): GatewayMethodHandler {
  const additional = deps.additionalSecretKeys ?? [];
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const key = requireString(params['key'], 'key');
    requireSecretBearingKey(key, additional);

    const secretKey = daemonSecretKeyFor(key);
    const scope = resolveSecretWriteScope(secretKey);
    const audited = principalFields(invocation);
    const hadSecret = (await deps.secrets.get(secretKey)) !== null;
    const hadConfigValue = deps.config.get(key) !== undefined && deps.config.get(key) !== '';

    await deps.secrets.delete(secretKey);
    if (hadConfigValue) deps.config.setDynamic(key, '');

    const cleared = hadSecret || hadConfigValue;
    record(deps, {
      action: 'delete',
      configKey: key,
      secretKey,
      scope,
      outcome: cleared ? 'cleared' : 'refused',
      ...audited,
      ...(cleared ? {} : { detail: 'nothing was stored under this key' }),
    });
    return { success: true, key, secretKey, scope, cleared };
  };
}

/** Attach the credentials.set/.delete handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerCredentialWriteGatewayMethods(
  catalog: GatewayMethodCatalog,
  deps: CredentialWriteDeps,
): void {
  const setDescriptor = catalog.get('credentials.set');
  if (setDescriptor) catalog.register(setDescriptor, createCredentialSetHandler(deps), { replace: true });

  const deleteDescriptor = catalog.get('credentials.delete');
  if (deleteDescriptor) catalog.register(deleteDescriptor, createCredentialDeleteHandler(deps), { replace: true });
}
