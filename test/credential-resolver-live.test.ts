/**
 * One request-time credential resolver — env -> secrets store -> subscription
 * accounts — and live re-registration on secrets changes.
 *
 * Acceptance bar:
 *   - write key to secrets store -> provider usable in the SAME process, no
 *     restart
 *   - env var absent + secrets present works
 *   - both absent -> honest unconfigured, consistent across resolver consumers
 *   - a provider registered with non-resolver auth is refused
 *   - badge state and chat availability derive from the same call
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.js';
import { resolveApiKeys } from '../packages/sdk/src/platform/config/api-keys.js';
import {
  assertProviderCredentialAuthority,
  verifyProviderCredentialAuthority,
} from '../packages/sdk/src/platform/providers/credential-authority-contract.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';

const GROQ_ENV = 'GROQ_API_KEY';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[GROQ_ENV];
  delete process.env[GROQ_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[GROQ_ENV];
  else process.env[GROQ_ENV] = savedEnv;
});

function makeSecrets(root: string): SecretsManager {
  return new SecretsManager({
    projectRoot: join(root, 'project'),
    globalHome: join(root, 'home'),
    surfaceRoot: 'testsurface',
    policy: 'plaintext_allowed',
  });
}

function makeRegistry(root: string, secretsManager: SecretsManager): ProviderRegistry {
  return new ProviderRegistry({
    configManager: {
      get: () => undefined,
      getCategory: () => ({}),
      getControlPlaneConfigDir: () => root,
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'],
    subscriptionManager: {
      get: () => null,
      getPending: () => null,
      saveSubscription: async () => {},
      resolveAccessToken: async () => null,
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'],
    capabilityRegistry: {
      getCapability: () => ({}),
      getRouteExplanation: () => ({ accepted: true }),
      invalidate: () => {},
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'],
    benchmarkStore: {
      getBenchmarks: () => undefined,
      getTopBenchmarkModelIds: () => [],
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'],
    secretsManager: secretsManager as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'],
    serviceRegistry: { getAll: () => [], inspect: () => null } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

describe('request-time credential resolution', () => {
  test('a key written to the secrets store makes the provider usable in the same process — no restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-cred-live-'));
    try {
      const secrets = makeSecrets(root);
      const registry = makeRegistry(root, secrets);
      // The composition-root wiring under test: change -> live refresh.
      secrets.onDidChange(() => void registry.refreshProviderCredentials());

      expect(registry.getRegistered('groq').isConfigured?.()).toBe(false);

      await secrets.set(GROQ_ENV, 'gsk_live_test_value');
      await Bun.sleep(20); // listener refresh is async

      expect(registry.getRegistered('groq').isConfigured?.()).toBe(true);

      // Delete/rotate likewise: removing the key de-configures live.
      await secrets.delete(GROQ_ENV);
      await Bun.sleep(20);
      expect(registry.getRegistered('groq').isConfigured?.()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('env var absent + secrets present works (boot refresh applies the stored key)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-cred-live-'));
    try {
      const secrets = makeSecrets(root);
      await secrets.set(GROQ_ENV, 'gsk_from_store');
      const registry = makeRegistry(root, secrets);
      expect(registry.getRegistered('groq').isConfigured?.()).toBe(false); // env-only construction
      await registry.refreshProviderCredentials(); // the boot pass services.ts runs
      expect(registry.getRegistered('groq').isConfigured?.()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('both absent -> honest unconfigured, consistent across resolver consumers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-cred-live-'));
    try {
      const secrets = makeSecrets(root);
      const registry = makeRegistry(root, secrets);
      await registry.refreshProviderCredentials();

      const provider = registry.getRegistered('groq');
      expect(provider.isConfigured?.()).toBe(false);
      // The status-snapshot consumer reads the SAME chain (resolveApiKeys).
      const resolved = await resolveApiKeys(secrets);
      expect(resolved['groq']).toBeUndefined();
      // Badge/runtime metadata derives from the same provider instance.
      const runtime = await registry.describeRuntime('groq');
      expect(runtime?.auth?.configured ?? false).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('badge state and chat availability derive from the same call after a live key write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-cred-live-'));
    try {
      const secrets = makeSecrets(root);
      const registry = makeRegistry(root, secrets);
      await secrets.set(GROQ_ENV, 'gsk_badge_test');
      await registry.refreshProviderCredentials();

      const provider = registry.getRegistered('groq');
      const runtime = await registry.describeRuntime('groq');
      // Green badge if and only if the chat path is configured — one source.
      expect(runtime?.auth?.configured).toBe(provider.isConfigured?.());
      expect(provider.isConfigured?.()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('credential-authority registration contract', () => {
  test('a provider whose auth path is not resolver-backed is refused at registration', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-cred-live-'));
    try {
      const registry = makeRegistry(root, makeSecrets(root));
      const rogue = {
        name: 'rogue-auth-provider',
        models: ['rogue-model'],
        chat: async () => { throw new Error('nope'); },
      } as unknown as LLMProvider;
      expect(() => registry.register(rogue)).toThrow(/credential authority/i);
      expect(registry.has('rogue-auth-provider')).toBe(false);

      const declared = {
        ...rogue,
        name: 'declared-auth-provider',
        credentialAuthority: 'anonymous',
      } as unknown as LLMProvider;
      expect(() => registry.register(declared)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the contract check itself: undefined or unsanctioned values are violations', () => {
    expect(verifyProviderCredentialAuthority({ name: 'x' })).not.toBeNull();
    expect(verifyProviderCredentialAuthority({ name: 'x', credentialAuthority: 'resolver' })).toBeNull();
    expect(verifyProviderCredentialAuthority({ name: 'x', credentialAuthority: 'anonymous' })).toBeNull();
    expect(verifyProviderCredentialAuthority({ name: 'x', credentialAuthority: 'subscription' })).toBeNull();
    expect(verifyProviderCredentialAuthority({ name: 'x', credentialAuthority: 'oauth' })).toBeNull();
    expect(() => assertProviderCredentialAuthority({ name: 'x' })).toThrow(/registration refused/i);
  });
});
