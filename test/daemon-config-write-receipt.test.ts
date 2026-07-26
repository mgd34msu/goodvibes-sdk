/**
 * daemon-config-write-receipt.test.ts — POST /config reports what the host HOLDS.
 *
 * The route used to echo the request back, so it said `success: true` for any
 * write it managed to hand to the config manager. It could not distinguish a
 * value that took from one that was coerced, dropped, or overridden by another
 * tier, and it never named the store — which is the whole question when an agent
 * writes over the control plane into the DAEMON's settings and then reads the
 * key back out of its OWN settings file.
 *
 * Imported from packages/daemon-sdk/dist deliberately: `@pellux/goodvibes-daemon-sdk`
 * resolves to dist, so this also proves the change is in the artifact the
 * running daemon loads, not only in the source.
 */
import { describe, expect, test } from 'bun:test';
import { createDaemonSystemRouteHandlers } from '../packages/daemon-sdk/dist/index.js';

interface ConfigStub {
  readonly get: (key: string) => unknown;
  readonly getAll: () => Record<string, unknown>;
  readonly setDynamic: (key: string, value: unknown) => void;
  readonly getConfigPath?: () => string;
  readonly describeConfigKeySource?: (key: string) => {
    tier: string;
    daemonOwned: boolean;
    daemonTierPath?: string | null;
  };
}

function makeHandlers(configManager: ConfigStub, body: Record<string, unknown>): ReturnType<typeof createDaemonSystemRouteHandlers> {
  return createDaemonSystemRouteHandlers({
    approvalBroker: { claimApproval: async () => null, cancelApproval: async () => null, resolveApproval: async () => null },
    configManager,
    integrationHelpers: null,
    inspectInboundTls: (surface: string) => ({ surface, mode: 'off' }),
    inspectOutboundTls: () => ({ mode: 'system' }),
    isValidConfigKey: () => true,
    parseJsonBody: async () => body,
    parseOptionalJsonBody: async () => null,
    platformServiceManager: {
      status: () => ({ running: true }),
      install: () => ({ ok: true }),
      start: () => ({ ok: true }),
      stop: () => ({ ok: true }),
      restart: () => ({ ok: true }),
      uninstall: () => ({ ok: true }),
    },
    recordApiResponse: (_req: Request, _path: string, response: Response) => response,
    requireAdmin: () => null,
    requireAuthenticatedSession: () => ({ username: 'tester', roles: ['admin'] }),
    routeBindings: {
      listBindings: () => [],
      upsertBinding: async () => ({}),
      patchBinding: async () => ({}),
      removeBinding: async () => true,
    },
    watcherRegistry: {
      list: () => [],
      removeWatcher: () => true,
      registerWatcher: (input: unknown) => input,
      getWatcher: () => null,
      startWatcher: () => null,
      stopWatcher: () => null,
      runWatcherNow: async () => null,
    },
  } as never, new Request('http://127.0.0.1/config')) as ReturnType<typeof createDaemonSystemRouteHandlers>;
}

const DAEMON_PATH = '/home/tester/.goodvibes/daemon/settings.json';
const SURFACE_PATH = '/home/tester/.goodvibes/agent/settings.json';

describe('POST /config write receipt', () => {
  test('a daemon-owned key names the DAEMON store, not the caller\'s surface file', async () => {
    const stored = new Map<string, unknown>();
    const handlers = makeHandlers({
      get: (key) => stored.get(key),
      getAll: () => Object.fromEntries(stored),
      setDynamic: (key, value) => stored.set(key, value),
      getConfigPath: () => SURFACE_PATH,
      describeConfigKeySource: () => ({ tier: 'daemon', daemonOwned: true, daemonTierPath: DAEMON_PATH }),
    }, { key: 'surfaces.telegram.enabled', value: true });

    const response = await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }));
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.success).toBe(true);
    expect(payload.value).toBe(true);
    // The whole point: the file named is the one the runtime that ACTS on the
    // key will read.
    expect(payload.persistedTo).toBe(DAEMON_PATH);
    expect(payload.tier).toBe('daemon');
    expect(payload.daemonOwned).toBe(true);
  });

  test('a client-owned key names the surface settings file', async () => {
    const stored = new Map<string, unknown>();
    const handlers = makeHandlers({
      get: (key) => stored.get(key),
      getAll: () => Object.fromEntries(stored),
      setDynamic: (key, value) => stored.set(key, value),
      getConfigPath: () => SURFACE_PATH,
      describeConfigKeySource: () => ({ tier: 'global', daemonOwned: false, daemonTierPath: DAEMON_PATH }),
    }, { key: 'display.theme', value: 'vaporwave' });

    const payload = await (await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }))).json() as Record<string, unknown>;
    expect(payload.persistedTo).toBe(SURFACE_PATH);
    expect(payload.daemonOwned).toBe(false);
  });

  test('a write that does not take the requested value is a 409, not a success', async () => {
    // The failure this replaces: the write is accepted, another tier wins, and
    // the route still answers `success: true` with the value the caller asked
    // for. Here the host keeps holding the OLD value after setDynamic.
    const handlers = makeHandlers({
      get: () => 'shared-tier-wins',
      getAll: () => ({}),
      setDynamic: () => { /* accepted, but the effective value is unchanged */ },
      getConfigPath: () => SURFACE_PATH,
      describeConfigKeySource: () => ({ tier: 'shared', daemonOwned: false, daemonTierPath: null }),
    }, { key: 'tts.voice', value: 'my-voice' });

    const response = await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }));
    expect(response.status).toBe(409);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.code).toBe('CONFIG_SET_NOT_APPLIED');
    // Actionable: which key, which file, and what the host actually holds.
    expect(String(payload.error)).toContain('tts.voice');
    expect(String(payload.error)).toContain(SURFACE_PATH);
    expect(String(payload.error)).toContain('shared-tier-wins');
  });

  test('an object value that survives the write is reported as applied', async () => {
    const stored = new Map<string, unknown>();
    const handlers = makeHandlers({
      get: (key) => stored.get(key),
      getAll: () => Object.fromEntries(stored),
      setDynamic: (key, value) => stored.set(key, structuredClone(value)),
      getConfigPath: () => SURFACE_PATH,
      describeConfigKeySource: () => ({ tier: 'global', daemonOwned: false, daemonTierPath: null }),
    }, { key: 'pricing.modelPrices', value: { 'groq:llama': { input: 1, output: 2 } } });

    const response = await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }));
    // Structural comparison, because a fresh object is never `Object.is`-equal.
    expect(response.status).toBe(200);
  });

  test('a host without the ownership helpers still reports a usable receipt', async () => {
    const stored = new Map<string, unknown>();
    const handlers = makeHandlers({
      get: (key) => stored.get(key),
      getAll: () => Object.fromEntries(stored),
      setDynamic: (key, value) => stored.set(key, value),
    }, { key: 'display.theme', value: 'vaporwave' });

    const response = await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }));
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.success).toBe(true);
    expect(payload.value).toBe('vaporwave');
    expect(payload.persistedTo).toBeUndefined();
  });
});
