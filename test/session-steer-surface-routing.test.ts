import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';

// D3 — STEER ROUTING TO SURFACE-BACKED SESSIONS. A steer/follow-up to a
// surface-managed session with a live registered surface participant queues for
// the surface (no daemon executor spawn); the surface collects and marks
// delivery through the existing input lifecycle. A surfaceless session keeps the
// executor path.

interface Captured { readonly event: string; readonly payload: Record<string, unknown> }

function makeBroker(): { broker: SharedSessionBroker; events: Captured[] } {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    getBinding: () => null,
    resolve: () => null,
    patchBinding: async () => null,
  } as unknown as RouteBindingManager;
  const broker = new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null }, // never a live daemon agent
    messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
  const events: Captured[] = [];
  broker.setEventPublisher((_event, payload) => {
    const p = payload as { event: string; payload: Record<string, unknown> };
    events.push({ event: p.event, payload: p.payload });
  });
  return { broker, events };
}

function innerEvents(events: Captured[]): string[] {
  return events.map((e) => e.event);
}

describe('steer routing — surface-managed session queues for the surface', () => {
  test('steer to a session with a live registered surface participant queues (no spawn)', async () => {
    const { broker, events } = makeBroker();
    await broker.register({
      sessionId: 's-live',
      kind: 'tui',
      participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: Date.now() },
    });

    // A DIFFERENT surface (webui operator) steers the TUI-backed session.
    const submission = await broker.steerMessage({
      sessionId: 's-live',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'BROWSER-ORIGINATED STEER',
      allowSpawnFallback: true,
    });

    expect(submission.mode).toBe('queued-for-surface');
    expect(submission.input.state).toBe('queued');
    expect(submission.task).toBeUndefined(); // no executor task built
    expect(innerEvents(events)).toContain('session-input-queued-for-surface');
  });

  test('collection + delivery lifecycle round-trips through the input states', async () => {
    const { broker } = makeBroker();
    await broker.register({
      sessionId: 's-live',
      kind: 'tui',
      participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: Date.now() },
    });
    const submission = await broker.steerMessage({
      sessionId: 's-live',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'steer body',
      allowSpawnFallback: true,
    });
    const inputId = submission.input.id;

    // Surface collects PENDING inputs (state=queued, since a cursor of 0).
    const pending = broker.getInputsSince('s-live', { state: 'queued', since: 0 });
    expect(pending.map((p) => p.id)).toContain(inputId);

    // Surface picks it up → delivered.
    const delivered = await broker.markInputDelivered('s-live', inputId, { consumed: false });
    expect(delivered?.state).toBe('delivered');

    // Surface finished acting on it → completed.
    const completed = await broker.markInputDelivered('s-live', inputId, { consumed: true });
    expect(completed?.state).toBe('completed');

    // It is no longer pending.
    expect(broker.getInputsSince('s-live', { state: 'queued' }).map((p) => p.id)).not.toContain(inputId);
  });

  test('the `since` cursor only returns inputs created after it', async () => {
    const { broker } = makeBroker();
    await broker.register({
      sessionId: 's-live',
      kind: 'tui',
      participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: Date.now() },
    });
    const first = await broker.steerMessage({ sessionId: 's-live', surfaceKind: 'web', surfaceId: 'surface:web', body: 'a', allowSpawnFallback: true });
    const cursor = first.input.createdAt;
    // A second steer strictly after the cursor.
    await new Promise((r) => setTimeout(r, 2));
    const second = await broker.steerMessage({ sessionId: 's-live', surfaceKind: 'web', surfaceId: 'surface:web', body: 'b', allowSpawnFallback: true });
    const afterCursor = broker.getInputsSince('s-live', { state: 'queued', since: cursor });
    expect(afterCursor.map((p) => p.id)).toContain(second.input.id);
    expect(afterCursor.map((p) => p.id)).not.toContain(first.input.id);
  });
});

describe('steer routing — surfaceless session keeps the executor path', () => {
  test('steer to a session that was never surface-registered spawns (executor path)', async () => {
    const { broker } = makeBroker();
    // createSession does NOT mark the session surface-managed (only register does).
    await broker.createSession({
      id: 's-headless',
      participant: { surfaceKind: 'web', surfaceId: 'surface:web', lastSeenAt: Date.now() },
    });
    const submission = await broker.steerMessage({
      sessionId: 's-headless',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'steer body',
      allowSpawnFallback: true,
    });
    expect(submission.mode).toBe('spawn');
    expect(submission.task).toBeDefined(); // executor continuation task built
  });

  test('a surface-managed session whose only fresh participant is the sender falls back to spawn', async () => {
    const { broker } = makeBroker();
    // Register with the SAME surface that will steer, with a stale registration.
    await broker.register({
      sessionId: 's-selfonly',
      kind: 'tui',
      participant: { surfaceKind: 'web', surfaceId: 'surface:web', lastSeenAt: Date.now() - 10 * 60 * 1000 },
    });
    const submission = await broker.steerMessage({
      sessionId: 's-selfonly',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'steer body',
      allowSpawnFallback: true,
    });
    // The only participant is the sender (excluded) and it is stale → no live
    // surface → executor path.
    expect(submission.mode).toBe('spawn');
  });
});

// D-1 — Wave-2 acceptance re-replay: steering a CLOSED session must reject
// with SESSION_CLOSED/409 and cause NO side effects (closed sessions are
// history — no message recorded, no input queued, no activeAgentId touched).
// Open sessions (both the surface-collection path and the spawn fallback)
// keep working, and a legitimately reopened session accepts steers again.
describe('steer routing — closed session is rejected before any mutation (D-1)', () => {
  test('steer to a closed session throws SESSION_CLOSED/409 and mutates nothing', async () => {
    const { broker, events } = makeBroker();
    await broker.createSession({ id: 's-closed' });
    await broker.closeSession('s-closed');
    events.length = 0; // only the steer's own (lack of) side effects matter below

    let caught: { code?: string; status?: number } | undefined;
    try {
      await broker.steerMessage({
        sessionId: 's-closed',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
        body: 'should not spawn',
        allowSpawnFallback: true,
      });
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }

    expect(caught?.code).toBe('SESSION_CLOSED');
    expect(caught?.status).toBe(409);
    const session = broker.getSession('s-closed');
    expect(session?.status).toBe('closed');
    expect(session?.activeAgentId).toBeUndefined();
    expect(broker.getMessages('s-closed')).toHaveLength(0);
    expect(broker.getInputs('s-closed')).toHaveLength(0);
    expect(innerEvents(events)).toEqual([]);
  });

  test('steer to an open surface-managed session still queues for the surface (deliver-to-surface path)', async () => {
    const { broker } = makeBroker();
    await broker.register({
      sessionId: 's-open-live',
      kind: 'tui',
      participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: Date.now() },
    });
    const submission = await broker.steerMessage({
      sessionId: 's-open-live',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'still works',
      allowSpawnFallback: true,
    });
    expect(submission.mode).toBe('queued-for-surface');
  });

  test('steer to an open surfaceless session still falls back to spawn', async () => {
    const { broker } = makeBroker();
    await broker.createSession({
      id: 's-open-headless',
      participant: { surfaceKind: 'web', surfaceId: 'surface:web', lastSeenAt: Date.now() },
    });
    const submission = await broker.steerMessage({
      sessionId: 's-open-headless',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'still spawns',
      allowSpawnFallback: true,
    });
    expect(submission.mode).toBe('spawn');
  });

  test('closed-then-reopened (register reopen:true) session accepts steers again', async () => {
    const { broker } = makeBroker();
    await broker.createSession({
      id: 's-reopen',
      participant: { surfaceKind: 'web', surfaceId: 'surface:web', lastSeenAt: Date.now() },
    });
    await broker.closeSession('s-reopen');
    expect(broker.getSession('s-reopen')?.status).toBe('closed');

    const reopenResult = await broker.register({
      sessionId: 's-reopen',
      participant: { surfaceKind: 'web', surfaceId: 'surface:web', lastSeenAt: Date.now() },
      reopen: true,
    });
    expect(reopenResult.reopened).toBe(true);
    expect(broker.getSession('s-reopen')?.status).toBe('active');

    const submission = await broker.steerMessage({
      sessionId: 's-reopen',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'steer after reopen',
      allowSpawnFallback: true,
    });
    expect(submission.mode).toBe('spawn');
    expect(broker.getSession('s-reopen')?.status).toBe('active');
  });
});
