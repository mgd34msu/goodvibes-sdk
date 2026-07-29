/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * surface-credential.ts — the credential an inbound adapter checks a caller against.
 *
 * ── What this exists to fix ─────────────────────────────────────────────────
 *
 * `sweepPlaintextCredentials` (config/plaintext-credential-sweep.ts) moves a
 * literal surface credential out of the config file into the encrypted store
 * and leaves a `goodvibes://secrets/goodvibes/<KEY>` reference in its place.
 * That is the correct at-rest shape and every DELIVERY path already resolves
 * it. The inbound adapters did not: each read its config value raw and compared
 * it byte-for-byte against what the caller presented, so once a surface had
 * been swept it answered 401 to every inbound POST.
 *
 * Telegram webhook mode was the worst of it, because the two halves disagreed
 * within one surface: the daemon registers the webhook with the RESOLVED secret
 * (channels/telegram/ingress.ts), so Telegram sends the real value and the
 * adapter rejected it against the unresolved reference text. Polling mode never
 * reads the config value, which is why this could sit unnoticed.
 *
 * ── Why one helper and not fifteen call sites ───────────────────────────────
 *
 * Fifteen read sites across twelve adapters had the same three-line shape, and
 * fifteen copies of a rule is how the thirteenth adapter gets it wrong. More
 * pointedly, the correct fix is NOT "wrap the read in `resolveSecretInput`" —
 * doing exactly that at each site introduces an authentication bypass (below).
 * A shared function is the only place that rule can be stated once and be true
 * for every adapter, including ones not written yet.
 *
 * ── The bypass this type exists to prevent ──────────────────────────────────
 *
 * `resolveSecretInput` returns `string | null`, and null means three different
 * things: nothing was configured, a reference failed to resolve, or a
 * reference-shaped value was refused. Seven of these adapters are written as
 *
 *     if (configuredToken && !constantTimeEquals(configuredToken, provided)) → 401
 *
 * — "no credential configured, so there is no check to run", which is a
 * deliberate and reasonable reading of an unconfigured surface. Collapse a
 * failed resolution into the same empty string and that line reads a BROKEN
 * credential as an ABSENT one: the comparison is skipped and the surface
 * authorises every caller. A locked surface would have become an open one, and
 * the only visible symptom would be that the 401s stopped.
 *
 * So the three outcomes stay distinguishable in the type, and an adapter cannot
 * accidentally treat the third as the first: `absent` is a surface with no
 * credential, `unresolvable` is a surface whose credential is broken, and only
 * `resolved` carries a value to compare.
 */

import { logger } from '../utils/logger.js';
import { resolveSecretInput, type SecretRefResolutionOptions } from '../config/secret-refs.js';
import type { SecretsManager } from '../config/secrets.js';

/**
 * The credential an adapter should check against, or the reason it has none.
 *
 * Deliberately not `string | null`. See the bypass note above: an adapter that
 * cannot tell "nothing configured" from "configured but broken" will read the
 * second as the first and stop authenticating.
 */
export type SurfaceCredential =
  /** A usable credential. This is the only shape carrying a value. */
  | { readonly state: 'resolved'; readonly value: string }
  /** No credential is configured anywhere. The surface is unconfigured. */
  | { readonly state: 'absent' }
  /**
   * A credential IS configured and could not be produced — a reference whose
   * secret is missing from the store, in a scope this process cannot read, or
   * malformed. Never authorise on this.
   */
  | { readonly state: 'unresolvable'; readonly configKey: string };

/** Where an adapter looks for its credential, in the order it looks. */
export type SurfaceCredentialSource =
  /** A config key. The only kind that can hold a `goodvibes://` reference. */
  | { readonly kind: 'config'; readonly key: string }
  /** A registered service secret. Already resolved by the registry. */
  | { readonly kind: 'registry'; readonly service: string; readonly field: ServiceSecretFieldName }
  /** An environment variable. Always a literal. */
  | { readonly kind: 'env'; readonly name: string };

/** The registry secret slots the adapters ask for. */
type ServiceSecretFieldName = 'primary' | 'password' | 'authToken' | 'signingSecret' | 'appToken';

/**
 * The slice of an adapter context this needs.
 *
 * Structural, so both `SurfaceAdapterContext` and
 * `GenericWebhookAdapterContext` satisfy it without either importing the other,
 * and so a test can supply three fields instead of thirty.
 */
export interface SurfaceCredentialContext {
  readonly configManager: { get(key: string): unknown };
  readonly serviceRegistry?: {
    resolveSecret(service: string, field: ServiceSecretFieldName): Promise<string | null>;
  } | undefined;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
}

function secretRefOptions(context: SurfaceCredentialContext): SecretRefResolutionOptions {
  const secrets = context.secretsManager;
  return {
    resolveLocalSecret: secrets ? (key) => secrets.get(key) : undefined,
    homeDirectory: secrets?.getGlobalHome?.() ?? undefined,
  };
}

/**
 * Read the first source that has a credential, resolving config references.
 *
 * ── Ordering, and why a broken config value does not fall through ───────────
 *
 * Sources are tried in the order given, which is the order each adapter already
 * used. A source that holds nothing is skipped. But a CONFIG source that holds
 * something and fails to resolve stops the walk and returns `unresolvable`
 * rather than continuing to the next source.
 *
 * That is deliberate. Falling through would mean an operator whose swept
 * reference broke gets quietly authenticated by a stale environment variable
 * instead — the surface keeps working, against a credential nobody chose, and
 * the broken reference is never noticed. A refusal that names the key in the
 * log is worse for one request and better for the operator, which is the same
 * trade `acceptRefShapedLiteral` already makes one layer down.
 *
 * Only config values are resolved. Registry values arrive already resolved, and
 * an environment variable is a literal by construction.
 */
export async function resolveSurfaceCredential(
  context: SurfaceCredentialContext,
  ...sources: readonly SurfaceCredentialSource[]
): Promise<SurfaceCredential> {
  for (const source of sources) {
    if (source.kind === 'config') {
      // Stringified before resolution, exactly as the raw reads did, so a
      // non-string literal in config behaves as it always has.
      //
      // Emptiness is tested on the UNTRIMMED string, so that a value which is
      // only whitespace counts as PRESENT and goes on to resolve (to nothing,
      // hence `unresolvable`). Trimming first would make "   " indistinguishable
      // from "not configured", and on the adapters that skip the comparison when
      // nothing is configured that reads a broken setting as an open door — the
      // same fail-open this whole module exists to prevent.
      const raw = String(context.configManager.get(source.key) ?? '');
      if (raw.length === 0) continue;
      const resolved = await resolveSecretInput(raw, secretRefOptions(context));
      if (resolved !== null && resolved.length > 0) return { state: 'resolved', value: resolved };
      return { state: 'unresolvable', configKey: source.key };
    }

    if (source.kind === 'registry') {
      const value = (await context.serviceRegistry?.resolveSecret(source.service, source.field)) ?? '';
      if (value.length > 0) return { state: 'resolved', value };
      continue;
    }

    const value = process.env[source.name] ?? '';
    if (value.length > 0) return { state: 'resolved', value };
  }

  return { state: 'absent' };
}

/**
 * The response for a credential that is configured and cannot be produced.
 *
 * 503, not 401: nothing is wrong with the caller, and answering 401 sends
 * whoever debugs it hunting for a wrong token — which is precisely the wild
 * goose chase this whole defect caused.
 *
 * The body names no config key. The caller is a third party (Telegram, Twilio,
 * an operator's own script) and has no business learning which of this
 * daemon's settings is broken; the operator learns that from the log line,
 * which names the key and never the value.
 */
export function surfaceCredentialUnavailable(
  surface: string,
  credential: Extract<SurfaceCredential, { state: 'unresolvable' }>,
): Response {
  logger.error('Refusing inbound surface traffic: the configured credential could not be resolved', {
    surface,
    configKey: credential.configKey,
    action: 'the config value is a secret reference that resolved to nothing — re-save the credential for this surface',
  });
  return Response.json({
    error: 'Surface credential is configured but could not be resolved',
    reason: 'credential-unresolvable',
  }, { status: 503 });
}
