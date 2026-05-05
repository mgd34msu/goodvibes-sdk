import { describe, expect, test } from 'bun:test';
import { loadSessionBrokerState } from '../packages/sdk/src/platform/control-plane/session-broker-state.js';

describe('shared session store loading', () => {
  test('normalizes persisted session records to the current required shape', () => {
    const state = loadSessionBrokerState({
      sessions: [{
        id: 'sess-existing',
        title: 'Existing session',
        status: 'active',
        createdAt: 100,
        updatedAt: 200,
        lastMessageAt: 300,
        messageCount: 1,
        metadata: { source: 'existing-store' },
      }],
      messages: [{
        id: 'msg-1',
        sessionId: 'sess-existing',
        role: 'user',
        body: 'hello',
        createdAt: 300,
      }],
      inputs: [{
        id: 'input-1',
        sessionId: 'sess-existing',
        intent: 'follow-up',
        state: 'queued',
        correlationId: 'corr-1',
        body: 'continue',
        createdAt: 350,
        updatedAt: 400,
      }],
    } as never);

    const session = state.sessions.get('sess-existing');

    expect(session).toBeDefined();
    expect(session?.kind).toBe('tui');
    expect(session?.lastActivityAt).toBe(400);
    expect(session?.pendingInputCount).toBe(1);
    expect(session?.messageCount).toBe(1);
    expect(session?.routeIds).toEqual([]);
    expect(session?.surfaceKinds).toEqual([]);
    expect(session?.participants).toEqual([]);
    expect(session?.metadata).toEqual({ source: 'existing-store' });
    expect(state.messages.get('sess-existing')?.[0]?.metadata).toEqual({});
    expect(state.inputs.get('sess-existing')?.[0]?.metadata).toEqual({});
  });
});
