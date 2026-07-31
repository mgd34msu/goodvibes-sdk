/**
 * client-seam-session-dispatch.test.ts — work that arrives for a session a
 * surface hosts reaches the loop, and reaches it exactly once.
 *
 * ── Why this seam exists ──────────────────────────────────────────────────
 *
 * A surface composition used to own a persisting session broker, which was both
 * the register (who hosts what) and the dispatcher (deliver this to whoever
 * hosts it). As a client it owns neither: the daemon holds the register, and the
 * surface only needs to RECEIVE dispatch for the sessions it is running.
 *
 * The failure that matters is not "nothing arrives" — that is visible. It is a
 * message being CONSUMED without being run: acknowledged on the wire, removed
 * from the queue, and never answered. Whoever sent it sees delivered and waits
 * forever. So the ordering here is run-then-acknowledge, and a runner that
 * throws leaves the input queued for the next tick.
 *
 * Ported from the terminal app's suite when this module was hoisted, so the two
 * surface products inherit the pins rather than each writing their own.
 */
import { describe, expect, test } from 'bun:test';
import { createWireSessionDispatch, readSurfaceAgentOutcome } from '../packages/sdk/src/platform/runtime/client/session-dispatch.ts';
import type { SessionInputsWireClient, SurfaceAgentOutcome } from '../packages/sdk/src/platform/runtime/client/session-dispatch.ts';

interface QueuedInput { id: string; intent: string; body: string }

function fakeInputs(inputs: QueuedInput[]): { delivered: string[]; client: SessionInputsWireClient } {
  const delivered: string[] = [];
  return {
    delivered,
    client: {
      listInputs: async () => ({ inputs: inputs.filter((i) => !delivered.includes(i.id)) }) as never,
      deliverInput: async (_sessionId: string, inputId: string) => { delivered.push(inputId); },
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 15); });

describe('inbound continuation dispatch over the adopted daemon', () => {
  test('nothing is dispatched before a daemon is adopted', async () => {
    const ran: string[] = [];
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' } as never; });
    await tick();
    // Holding a runner with no wire is the honest offline posture, not a
    // missing dependency: this surface simply has nowhere to be dispatched from.
    expect(ran).toEqual([]);
    dispatch.stop();
  });

  test('a submitted message reaches the runner and is acknowledged after it runs', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' } as never; });
    dispatch.activate(wire.client);
    await tick();
    expect(ran).toEqual(['do the thing']);
    expect(wire.delivered).toEqual(['i1']);
    dispatch.stop();
  });

  test('a steer is left for the live-turn poller, not started as a new run', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'steer', body: 'actually, stop' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' } as never; });
    dispatch.activate(wire.client);
    await tick();
    // A steer belongs to the turn already in flight (the inbound steer poller
    // injects it). Starting a second run for it would answer the same message
    // twice, from two agents, into one conversation.
    expect(ran).toEqual([]);
    expect(wire.delivered).toEqual([]);
    dispatch.stop();
  });

  test('a runner that throws leaves the input queued rather than consuming it', async () => {
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(() => { throw new Error('spawn refused'); });
    dispatch.activate(wire.client);
    await tick();
    // Acknowledged-but-unanswered is the worst outcome available: the sender
    // sees delivered and waits forever. A transient failure must retry.
    expect(wire.delivered).toEqual([]);
    dispatch.stop();
  });

  test('detaching stops dispatch but keeps the runner for a re-adopted daemon', async () => {
    const ran: string[] = [];
    const wire = fakeInputs([{ id: 'i1', intent: 'submit', body: 'first' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' } as never; });
    dispatch.deactivate('daemon went away');
    await tick();
    expect(ran).toEqual([]);
    dispatch.activate(wire.client);
    await tick();
    expect(ran).toEqual(['first']);
    dispatch.stop();
  });

  test('every hosted session is drained, not just the first', async () => {
    const ran: string[] = [];
    const delivered: string[] = [];
    const bySession: Record<string, QueuedInput[]> = {
      s1: [{ id: 'i1', intent: 'submit', body: 'first' }],
      s2: [{ id: 'i2', intent: 'submit', body: 'second' }],
    };
    const client: SessionInputsWireClient = {
      listInputs: async (sessionId: string) =>
        ({ inputs: (bySession[sessionId] ?? []).filter((i) => !delivered.includes(i.id)) }) as never,
      deliverInput: async (_sessionId: string, inputId: string) => { delivered.push(inputId); },
    };
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1', 's2'], intervalMs: 5 });
    dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: 'a1' } as never; });
    dispatch.activate(client);
    await tick();
    // A surface running two sessions must answer for both; draining only the
    // first would strand every message posted into the second.
    expect(ran.sort()).toEqual(['first', 'second']);
    dispatch.stop();
  });
});

describe('the reply half: what the surface reports back about the run it started', () => {
  /** A wire that records the full option payload of every acknowledgement. */
  function recordingWire(inputs: QueuedInput[]): {
    calls: { inputId: string; options: Record<string, unknown> | undefined }[];
    client: SessionInputsWireClient;
  } {
    const calls: { inputId: string; options: Record<string, unknown> | undefined }[] = [];
    const consumed: string[] = [];
    return {
      calls,
      client: {
        listInputs: async () => ({ inputs: inputs.filter((i) => !consumed.includes(i.id)) }) as never,
        deliverInput: async (_sessionId: string, inputId: string, options?: Record<string, unknown>) => {
          calls.push({ inputId, options });
          // Only a consumed acknowledgement takes the input out of the queue;
          // a collected one leaves it out of `queued` on the daemon side, which
          // this stub models the same way.
          consumed.push(inputId);
        },
      } as SessionInputsWireClient,
    };
  }

  test('with no way to read outcomes, the agent is still named so the reply binds', async () => {
    const wire = recordingWire([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5 });
    dispatch.setContinuationRunner(() => ({ agentId: 'a1' }) as never);
    dispatch.activate(wire.client);
    await tick();
    // One acknowledgement, carrying the pairing. Without the agent id the
    // daemon has nothing to route the answer to, which is precisely how a
    // channel message dispatched here used to be answered into nothing.
    expect(wire.calls).toEqual([{ inputId: 'i1', options: { consumed: true, agentId: 'a1' } }]);
    dispatch.stop();
  });

  test('with outcomes readable, the bind and the answer are two separate reports', async () => {
    const wire = recordingWire([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    let outcome: SurfaceAgentOutcome = { status: 'running' };
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => ['s1'],
      intervalMs: 5,
      readAgentOutcome: () => outcome,
    });
    dispatch.setContinuationRunner(() => ({ agentId: 'a1' }) as never);
    dispatch.activate(wire.client);
    await tick();
    // Collected, and the agent named — but not finished, so nothing claims an
    // answer that does not exist yet.
    expect(wire.calls).toEqual([{ inputId: 'i1', options: { agentId: 'a1' } }]);

    outcome = { status: 'completed', answer: 'the thing is done' };
    await tick();
    expect(wire.calls[1]).toEqual({
      inputId: 'i1',
      options: { consumed: true, agentId: 'a1', answer: 'the thing is done', status: 'completed' },
    });
    // Reported once: a second tick must not re-answer the same message.
    await tick();
    expect(wire.calls).toHaveLength(2);
    dispatch.stop();
  });

  test('a failed run reports its failure rather than going quiet', async () => {
    const wire = recordingWire([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    let outcome: SurfaceAgentOutcome = { status: 'running' };
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => ['s1'],
      intervalMs: 5,
      readAgentOutcome: () => outcome,
    });
    dispatch.setContinuationRunner(() => ({ agentId: 'a1' }) as never);
    dispatch.activate(wire.client);
    await tick();
    outcome = { status: 'failed', answer: 'the provider rejected the request' };
    await tick();
    expect(wire.calls[1]?.options).toEqual({
      consumed: true,
      agentId: 'a1',
      answer: 'the provider rejected the request',
      status: 'failed',
    });
    dispatch.stop();
  });

  test('a run this surface no longer knows about is acknowledged, not waited on forever', async () => {
    const wire = recordingWire([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    let known = true;
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => ['s1'],
      intervalMs: 5,
      readAgentOutcome: () => (known ? { status: 'running' } : null),
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    dispatch.setContinuationRunner(() => ({ agentId: 'a1' }) as never);
    dispatch.activate(wire.client);
    await tick();
    known = false;
    await tick();
    // The daemon must not hold the input open on account of a run that vanished
    // from this process, and must not be told an answer exists.
    expect(wire.calls[1]?.options).toEqual({ consumed: true, agentId: 'a1' });
    dispatch.stop();
  });

  test('a runner that started nothing here consumes the input without binding a reply', async () => {
    const wire = recordingWire([{ id: 'i1', intent: 'submit', body: 'do the thing' }]);
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => ['s1'],
      intervalMs: 5,
      readAgentOutcome: () => ({ status: 'completed', answer: 'never asked' }),
    });
    // What a conversation handed to daemon hosting, or refused by a build-floor
    // guard, returns. Naming an agent here would bind a reply to an id that
    // does not exist.
    dispatch.setContinuationRunner(() => null);
    dispatch.activate(wire.client);
    await tick();
    expect(wire.calls).toEqual([{ inputId: 'i1', options: { consumed: true } }]);
    dispatch.stop();
  });

  test('the outcome reader renders the same answer the daemon would', () => {
    expect(readSurfaceAgentOutcome(null)).toBeNull();
    expect(readSurfaceAgentOutcome({ status: 'running' })).toEqual({ status: 'running' });
    expect(readSurfaceAgentOutcome({ status: 'completed', fullOutput: '  the answer  ' }))
      .toEqual({ status: 'completed', answer: 'the answer' });
    // Nothing produced is silence, per the owner ruling the daemon's own
    // renderer follows.
    expect(readSurfaceAgentOutcome({ status: 'completed' })).toEqual({ status: 'completed', answer: '' });
    expect(readSurfaceAgentOutcome({ status: 'failed', error: 'boom' }))
      .toEqual({ status: 'failed', answer: 'boom' });
  });
});
