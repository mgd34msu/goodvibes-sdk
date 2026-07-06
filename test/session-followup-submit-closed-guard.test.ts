/**
 * session-followup-submit-closed-guard.test.ts
 *
 * Final-batch fix — the closed-session guard in
 * SharedSessionBroker.handleIntent (session-broker.ts) covered ONLY
 * `intent === 'steer'`. `followUpMessage()` (intent='follow-up') and
 * `submitMessage()` (intent='submit', when the caller supplies a sessionId
 * that resolves to an EXISTING closed record) both skipped the guard,
 * mutated the closed record (message appended, input queued) and could bind
 * a fresh agent onto history via the spawn fallback — the exact zombie-agent
 * state the guard was supposed to eliminate, just reached through a different
 * intent. The guard now fires for all three intents whenever session
 * resolution lands on a pre-existing closed record; a MISSING session still
 * auto-creates for submit/follow-up exactly as before (creation always
 * yields an active session, so the guard never fires for that path).
 *
 * These are broker-level tests (real SharedSessionBroker + in-memory store),
 * mirroring the proof in session-steer-surface-routing.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';

function makeBroker(): SharedSessionBroker {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    getBinding: () => null,
    resolve: () => null,
    patchBinding: async () => null,
  } as unknown as RouteBindingManager;
  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null }, // never a live daemon agent
    messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

describe('follow-up to a closed session is rejected before any mutation', () => {
  test('followUpMessage throws SESSION_CLOSED/409 and mutates nothing', async () => {
    const broker = makeBroker();
    await broker.createSession({ id: 's-closed-followup' });
    await broker.closeSession('s-closed-followup');

    let caught: { code?: string; status?: number } | undefined;
    try {
      await broker.followUpMessage({
        sessionId: 's-closed-followup',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
        body: 'follow up on a closed session',
      });
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }

    expect(caught?.code).toBe('SESSION_CLOSED');
    expect(caught?.status).toBe(409);
    const session = broker.getSession('s-closed-followup');
    expect(session?.status).toBe('closed');
    expect(session?.activeAgentId).toBeUndefined();
    expect(broker.getMessages('s-closed-followup')).toHaveLength(0);
    expect(broker.getInputs('s-closed-followup')).toHaveLength(0);
  });

  test('follow-up to a MISSING session id still auto-creates (unchanged)', async () => {
    const broker = makeBroker();
    const submission = await broker.followUpMessage({
      sessionId: 'does-not-exist-yet',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'first message ever',
    });
    expect(submission.created).toBe(true);
    expect(submission.session.status).toBe('active');
    expect(broker.getMessages(submission.session.id)).toHaveLength(1);
  });

  test('a reopened session accepts follow-ups again', async () => {
    const broker = makeBroker();
    await broker.createSession({ id: 's-reopen-followup' });
    await broker.closeSession('s-reopen-followup');
    await broker.reopenSession('s-reopen-followup');
    expect(broker.getSession('s-reopen-followup')?.status).toBe('active');

    const submission = await broker.followUpMessage({
      sessionId: 's-reopen-followup',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'follow up after reopen',
    });
    expect(submission.session.status).toBe('active');
    expect(broker.getMessages('s-reopen-followup')).toHaveLength(1);
  });
});

describe('submit to an EXISTING closed session is rejected before any mutation', () => {
  test('submitMessage against an existing closed sessionId throws SESSION_CLOSED/409 and mutates nothing', async () => {
    const broker = makeBroker();
    await broker.createSession({ id: 's-closed-submit' });
    await broker.closeSession('s-closed-submit');

    let caught: { code?: string; status?: number } | undefined;
    try {
      await broker.submitMessage({
        sessionId: 's-closed-submit',
        surfaceKind: 'web',
        surfaceId: 'surface:web',
        body: 'submit into a closed session',
      });
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }

    expect(caught?.code).toBe('SESSION_CLOSED');
    expect(caught?.status).toBe(409);
    const session = broker.getSession('s-closed-submit');
    expect(session?.status).toBe('closed');
    expect(session?.activeAgentId).toBeUndefined();
    expect(broker.getMessages('s-closed-submit')).toHaveLength(0);
    expect(broker.getInputs('s-closed-submit')).toHaveLength(0);
  });

  test('submit to a MISSING session id still auto-creates (unchanged)', async () => {
    const broker = makeBroker();
    const submission = await broker.submitMessage({
      sessionId: 'does-not-exist-yet-submit',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'first submit ever',
    });
    expect(submission.created).toBe(true);
    expect(submission.session.status).toBe('active');
  });

  test('a reopened session accepts submits again', async () => {
    const broker = makeBroker();
    await broker.createSession({ id: 's-reopen-submit' });
    await broker.closeSession('s-reopen-submit');
    await broker.reopenSession('s-reopen-submit');

    const submission = await broker.submitMessage({
      sessionId: 's-reopen-submit',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'submit after reopen',
    });
    expect(submission.session.status).toBe('active');
  });
});
