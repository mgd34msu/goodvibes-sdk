import { afterEach, describe, expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.js';
import {
  createRoundtripSdk,
  createRoundtripServer,
  stopRoundtripServers,
} from './_helpers/live-roundtrip-fixtures.js';

afterEach(() => {
  stopRoundtripServers();
});

describe('sdk live roundtrip', () => {
  test('round-trips login and authenticated control calls through daemon routes', async () => {
    const { sdk, tokenStore } = createRoundtripSdk(createRoundtripServer());

    const login = await sdk.auth.login({ username: 'alice', password: 'secret' });
    expect(login.token).toBe('token-login');
    expect(await tokenStore.getToken()).toBe('token-login');

    const current = await sdk.auth.current();
    expect(current).toMatchObject({
      authenticated: true,
      principalId: 'alice',
      principalKind: 'token',
    });

    const snapshot = await sdk.operator.control.snapshot();
    expect(snapshot.server.enabled).toBe(true);
    expect(snapshot.totals.clients).toBe(0);
    expect(snapshot.clients).toEqual([]);
  });

  test('streams SSE runtime events through daemon routes', async () => {
    const { sdk } = createRoundtripSdk(createRoundtripServer());
    await sdk.auth.login({ username: 'alice', password: 'secret' });

    let unsubscribe: (() => void) | undefined;
    const event = await withTestTimeout(new Promise<unknown>((resolve) => {
      unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (payload) => {
        unsubscribe?.();
        resolve(payload);
      });
    }), 1_000, 'Timed out waiting for AGENT_COMPLETED SSE event.');
    unsubscribe?.();

    expect(event).toEqual({ agentId: 'agent-1' });
  });
});
