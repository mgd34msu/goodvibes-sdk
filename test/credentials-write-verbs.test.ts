/**
 * credentials-write-verbs.test.ts
 *
 * The secret-write verb family (credentials.set / credentials.delete): a
 * credential written THROUGH the daemon rather than into whichever client's
 * secret store happened to be on the same disk.
 *
 * What is actually asserted here, rather than "it returned success":
 *   - the value lands in the SECRET store and the config key holds only a
 *     goodvibes://secrets/ reference — the two-value check, since a write that
 *     did one and not the other is the failure this verb exists to prevent;
 *   - a store that does not read back what was just written leaves the config
 *     value EXACTLY as it was and fails the call;
 *   - nothing the verb returns, at any point, contains the credential;
 *   - a non-credential key is refused rather than turned into a reference;
 *   - the descriptors' auth posture (admin + write:config, mutating) matches
 *     config.set, which is what puts these calls inside the existing relay
 *     step-up gate.
 */

import { describe, expect, test } from 'bun:test';
import {
  createCredentialDeleteHandler,
  createCredentialSetHandler,
  type CredentialWriteAuditEntry,
  type CredentialWriteDeps,
} from '../packages/sdk/src/platform/control-plane/routes/credentials-write.ts';
import { isGatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { builtinGatewayAdminMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-admin.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

const SECRET_CONFIG_KEY = 'surfaces.telegram.botToken';
const SECRET_STORE_KEY = 'GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN';
const TOKEN = 'a-real-looking-bot-token-value';

interface Harness {
  readonly deps: CredentialWriteDeps;
  readonly config: Map<string, unknown>;
  readonly secrets: Map<string, string>;
  readonly audit: CredentialWriteAuditEntry[];
}

function harness(options: { readonly breakReadBack?: boolean; readonly refuseWrite?: boolean } = {}): Harness {
  const config = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const audit: CredentialWriteAuditEntry[] = [];
  return {
    config,
    secrets,
    audit,
    deps: {
      config: {
        get: (key) => config.get(key),
        setDynamic: (key, value) => { config.set(key, value); },
      },
      secrets: {
        set: async (key, value) => {
          if (options.refuseWrite) throw new Error('the secret store is unavailable');
          // A store that "succeeds" and stores something else is the exact
          // shape the read-back check exists for.
          secrets.set(key, options.breakReadBack ? `${value}-corrupted` : value);
        },
        get: async (key) => secrets.get(key) ?? null,
        delete: async (key) => { secrets.delete(key); },
      },
      audit: (entry) => { audit.push(entry); },
    },
  };
}

function invocation(params: Record<string, unknown>): GatewayMethodInvocation {
  return {
    body: params,
    context: { principalId: 'operator', principalKind: 'user', clientKind: 'web', admin: true },
  };
}

/** Every string anywhere in a returned value, flattened, for leak assertions. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, out);
  else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) allStrings(entry, out);
  }
  return out;
}

describe('credentials.set — the value goes to the store, the config gets a reference', () => {
  test('stores the credential and leaves only a reference in config', async () => {
    const h = harness();
    const result = await createCredentialSetHandler(h.deps)(
      invocation({ key: SECRET_CONFIG_KEY, value: TOKEN }),
    ) as Record<string, unknown>;

    // Both halves, because either one alone is the defect.
    expect(h.secrets.get(SECRET_STORE_KEY)).toBe(TOKEN);
    expect(h.config.get(SECRET_CONFIG_KEY)).toBe(`goodvibes://secrets/goodvibes/${SECRET_STORE_KEY}`);

    expect(result['success']).toBe(true);
    expect(result['secretKey']).toBe(SECRET_STORE_KEY);
    // Telegram is daemon-run, so its credential is filed in the daemon tier no
    // matter which surface sent it.
    expect(result['scope']).toBe('daemon');
    expect(result['configScope']).toBe('daemon');
  });

  test('the response never contains the credential', async () => {
    const h = harness();
    const result = await createCredentialSetHandler(h.deps)(
      invocation({ key: SECRET_CONFIG_KEY, value: TOKEN }),
    );
    expect(allStrings(result).some((text) => text.includes(TOKEN))).toBe(false);
  });

  test('the audit entry names the key, the scope and the principal — and no value', async () => {
    const h = harness();
    await createCredentialSetHandler(h.deps)(invocation({ key: SECRET_CONFIG_KEY, value: TOKEN }));
    expect(h.audit).toHaveLength(1);
    const entry = h.audit[0]!;
    expect(entry).toMatchObject({
      action: 'set',
      configKey: SECRET_CONFIG_KEY,
      secretKey: SECRET_STORE_KEY,
      scope: 'daemon',
      outcome: 'stored',
      principalId: 'operator',
      surface: 'web',
    });
    expect(allStrings(entry).some((text) => text.includes(TOKEN))).toBe(false);
  });
});

describe('credentials.set — refusals leave the setting exactly as it was', () => {
  test('a store that does not read back what was written fails and does NOT rewrite config', async () => {
    const h = harness({ breakReadBack: true });
    h.config.set(SECRET_CONFIG_KEY, 'the-previous-literal');

    await expect(
      createCredentialSetHandler(h.deps)(invocation({ key: SECRET_CONFIG_KEY, value: TOKEN })),
    ).rejects.toThrow(/did not read back/);

    // The old value survives: a reference resolving to nothing would be worse.
    expect(h.config.get(SECRET_CONFIG_KEY)).toBe('the-previous-literal');
    expect(h.audit[0]?.outcome).toBe('refused');
  });

  test('a store that refuses the write reports 503 and does not touch config', async () => {
    const h = harness({ refuseWrite: true });
    let status: number | undefined;
    try {
      await createCredentialSetHandler(h.deps)(invocation({ key: SECRET_CONFIG_KEY, value: TOKEN }));
    } catch (error) {
      if (isGatewayVerbError(error)) status = error.status;
    }
    expect(status).toBe(503);
    expect(h.config.has(SECRET_CONFIG_KEY)).toBe(false);
  });

  test('a key whose value is not credential material is refused, naming the field', async () => {
    const h = harness();
    let field: string | undefined;
    let status: number | undefined;
    try {
      await createCredentialSetHandler(h.deps)(invocation({ key: 'provider.model', value: 'sonnet' }));
    } catch (error) {
      if (isGatewayVerbError(error)) {
        field = error.field;
        status = error.status;
      }
    }
    expect(status).toBe(400);
    expect(field).toBe('key');
    expect(h.secrets.size).toBe(0);
    expect(h.config.size).toBe(0);
  });

  test('a value that is itself a goodvibes:// reference is refused (pointer to a pointer)', async () => {
    const h = harness();
    await expect(
      createCredentialSetHandler(h.deps)(invocation({
        key: SECRET_CONFIG_KEY,
        value: `goodvibes://secrets/goodvibes/${SECRET_STORE_KEY}`,
      })),
    ).rejects.toThrow(/reference/);
    expect(h.secrets.size).toBe(0);
  });

  test('an empty value is refused rather than stored as a blank credential', async () => {
    const h = harness();
    await expect(
      createCredentialSetHandler(h.deps)(invocation({ key: SECRET_CONFIG_KEY, value: '' })),
    ).rejects.toThrow(/value/);
    expect(h.secrets.size).toBe(0);
  });
});

describe('credentials.delete', () => {
  test('removes the stored secret AND the config reference', async () => {
    const h = harness();
    await createCredentialSetHandler(h.deps)(invocation({ key: SECRET_CONFIG_KEY, value: TOKEN }));

    const result = await createCredentialDeleteHandler(h.deps)(
      invocation({ key: SECRET_CONFIG_KEY }),
    ) as Record<string, unknown>;

    expect(result['cleared']).toBe(true);
    expect(h.secrets.has(SECRET_STORE_KEY)).toBe(false);
    expect(h.config.get(SECRET_CONFIG_KEY)).toBe('');
  });

  test('clearing something that was never stored is a miss, not an error', async () => {
    const h = harness();
    const result = await createCredentialDeleteHandler(h.deps)(
      invocation({ key: SECRET_CONFIG_KEY }),
    ) as Record<string, unknown>;
    expect(result['success']).toBe(true);
    expect(result['cleared']).toBe(false);
  });
});

describe('auth posture — the descriptors put these calls where config.set already is', () => {
  const byId = new Map(builtinGatewayAdminMethodDescriptors.map((descriptor) => [descriptor.id, descriptor]));

  test('credentials.set and credentials.clear are admin + write:config, like config.set', () => {
    const configSet = byId.get('config.set');
    for (const id of ['credentials.set', 'credentials.delete']) {
      const descriptor = byId.get(id);
      expect(descriptor).toBeDefined();
      expect(descriptor?.access).toBe('admin');
      expect(descriptor?.access).toBe(configSet?.access);
      expect(descriptor?.scopes).toEqual(['write:config']);
      expect(descriptor?.scopes).toEqual(configSet?.scopes as string[]);
      // Flagged dangerous: a credential write is not a display preference.
      expect(descriptor?.dangerous).toBe(true);
    }
  });

  test('both are ws-only invoke verbs (no advertised REST path to leave unserved)', () => {
    for (const id of ['credentials.set', 'credentials.delete']) {
      const descriptor = byId.get(id);
      expect(descriptor?.transport).toEqual(['ws']);
      expect(descriptor?.http).toBeUndefined();
    }
  });

  test('the read verb stays read-scoped, so a read grant cannot write a credential', () => {
    expect(byId.get('credentials.get')?.scopes).toEqual(['read:config']);
  });
});
