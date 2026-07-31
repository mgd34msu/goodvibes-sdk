import { afterEach, describe, expect, test } from 'bun:test';
import {
  POWER_KEEP_AWAKE_SET_PATH,
  forwardKeepAwakeToAdoptedDaemon,
  postPowerKeepAwakeSet,
  type PowerKeepAwakeRemoteConnection,
} from '../packages/sdk/src/platform/power/keep-awake-remote.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CONNECTION: PowerKeepAwakeRemoteConnection = {
  baseUrl: 'http://127.0.0.1:3421',
  token: 'daemon-token',
  tokenPath: '/home/user/.goodvibes/daemon/operator-tokens.json',
};

describe('postPowerKeepAwakeSet', () => {
  test('POSTs enabled to the power keep-awake route with a Bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await postPowerKeepAwakeSet(CONNECTION, true);

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe(`${CONNECTION.baseUrl}${POWER_KEEP_AWAKE_SET_PATH}`);
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>).authorization).toBe(`Bearer ${CONNECTION.token}`);
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ enabled: true });
  });

  test('no token on disk -> auth_required without a network call', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await postPowerKeepAwakeSet({ ...CONNECTION, token: null }, true);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('auth_required');
    expect(called).toBe(false);
  });

  test('404 -> connected_host_route_unavailable (a pre-power-verb daemon)', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const result = await postPowerKeepAwakeSet(CONNECTION, false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('connected_host_route_unavailable');
  });

  test('401 -> auth_required', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const result = await postPowerKeepAwakeSet(CONNECTION, false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('auth_required');
  });

  test('network failure -> connected_host_unavailable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await postPowerKeepAwakeSet(CONNECTION, true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('connected_host_unavailable');
  });
});

describe('forwardKeepAwakeToAdoptedDaemon (per-topology)', () => {
  test('no daemon adopted: reachability offline -> not attempted, no network call', async () => {
    let posted = false;
    const outcome = await forwardKeepAwakeToAdoptedDaemon(true, {
      probeReachability: async () => 'offline',
      resolveConnection: () => CONNECTION,
      post: async () => {
        posted = true;
        return { ok: true };
      },
    });
    expect(outcome.attempted).toBe(false);
    expect(posted).toBe(false);
  });

  test('reachability unknown -> not attempted', async () => {
    const outcome = await forwardKeepAwakeToAdoptedDaemon(true, {
      probeReachability: async () => 'unknown',
      resolveConnection: () => CONNECTION,
    });
    expect(outcome.attempted).toBe(false);
  });

  test('adopted-daemon topology: reachability online -> forwards the toggle to the daemon', async () => {
    let forwardedEnabled: boolean | undefined;
    let forwardedConnection: PowerKeepAwakeRemoteConnection | undefined;
    const outcome = await forwardKeepAwakeToAdoptedDaemon(true, {
      probeReachability: async () => 'online',
      resolveConnection: () => CONNECTION,
      post: async (connection, enabled) => {
        forwardedConnection = connection;
        forwardedEnabled = enabled;
        return { ok: true };
      },
    });
    expect(outcome.attempted).toBe(true);
    expect(outcome.attempted && outcome.result.ok).toBe(true);
    expect(forwardedEnabled).toBe(true);
    expect(forwardedConnection).toEqual(CONNECTION);
  });

  test('adopted-daemon topology, daemon call fails: attempted true, honest failure surfaced (never thrown)', async () => {
    const outcome = await forwardKeepAwakeToAdoptedDaemon(false, {
      probeReachability: async () => 'online',
      resolveConnection: () => CONNECTION,
      post: async () => ({ ok: false, kind: 'connected_host_unavailable', error: 'ECONNREFUSED' }),
    });
    expect(outcome.attempted).toBe(true);
    expect(outcome.attempted && !outcome.result.ok && outcome.result.kind).toBe('connected_host_unavailable');
  });

  test('a rejecting reachability probe degrades to not-attempted rather than throwing', async () => {
    const outcome = await forwardKeepAwakeToAdoptedDaemon(true, {
      probeReachability: async () => {
        throw new Error('probe exploded');
      },
      resolveConnection: () => CONNECTION,
    });
    expect(outcome.attempted).toBe(false);
  });
});
