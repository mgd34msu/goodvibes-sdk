import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../packages/sdk/src/_internal/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../packages/sdk/src/_internal/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/_internal/platform/channels/index.ts';

// ---------------------------------------------------------------------------
// Minimal stubs for broker construction
// ---------------------------------------------------------------------------

function makeBroker(): SharedSessionBroker {
  // Use an in-memory PersistentStore (no path, so we pass a dummy store)
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;

  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

// ---------------------------------------------------------------------------
// B6 — Reserved-ID rejection tests
// ---------------------------------------------------------------------------

describe('SharedSessionBroker — reserved session ID validation', () => {
  test('createSession with id="" throws with code INVALID_SESSION_ID', async () => {
    const broker = makeBroker();
    await expect(broker.createSession({ id: '' })).rejects.toMatchObject({
      code: 'INVALID_SESSION_ID',
    });
  });

  test('createSession with id="system" throws with code INVALID_SESSION_ID', async () => {
    const broker = makeBroker();
    await expect(broker.createSession({ id: 'system' })).rejects.toMatchObject({
      code: 'INVALID_SESSION_ID',
    });
  });

  test('createSession with a normal id succeeds', async () => {
    const broker = makeBroker();
    const session = await broker.createSession({ id: 'normal-session-id' });
    expect(session.id).toBe('normal-session-id');
  });
});
