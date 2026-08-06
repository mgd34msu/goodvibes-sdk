/**
 * sse-replay-poisons-next-turn.test.ts
 *
 * The defect, end to end: a hosted conversation opened a FRESH event stream per
 * turn and presented no `Last-Event-ID`, so the gateway's catch-up replay
 * handed the new stream the tail of the previous turn — that turn's
 * `TURN_COMPLETED` included. Two things went wrong with the same frame:
 *
 *  - The previous turn's final assistant message was appended a second time
 *    (the store-boundary dedupe in conversation.ts catches that symptom, and
 *    stays: an honest crash-replay produces it too).
 *  - Worse, the replayed terminal frame marked the NEW turn's renderer
 *    finished, so every real frame of the turn actually running was dropped as
 *    post-terminal noise. That turn had already been billed for.
 *
 * Both halves of the cause are covered here:
 *
 *  (a) The stream now SURFACES the position it reached, and the connector that
 *      composes it remembers that position across stream lifetimes, so the next
 *      stream presents `Last-Event-ID` and is replayed nothing it has seen. The
 *      gateway honours the header — and, where it used to silently fall back to
 *      the full catch-up window when it could not resolve the id, now replays
 *      nothing and says so.
 *
 *  (b) Defence in depth: turn frames carry a `turnId`, and the turn-lifecycle
 *      gate refuses to let a terminal frame finish a turn its consumer is not
 *      rendering. A consumer that passes no options gets this by default.
 */
import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '@pellux/goodvibes-sdk/platform/control-plane';
import { replayRecentTraffic, resolveReplayResume } from '../packages/sdk/src/platform/control-plane/gateway-utils.ts';
import type { ScopedControlPlaneRecentEvent } from '../packages/sdk/src/platform/control-plane/gateway-utils.ts';
import { createTurnLifecycleGate, readTurnLifecycleFrame } from '../packages/transport-realtime/src/turn-lifecycle-gate.ts';
import { openRawServerSentEventStream } from '../packages/transport-http/src/sse-stream.ts';
import { RuntimeEventBus } from './_helpers/runtime-seam.ts';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

async function readStreamText(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  stopWhen: (text: string) => boolean,
): Promise<string> {
  if (!reader) return '';
  let text = '';
  for (let index = 0; index < 8; index += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value ? new TextDecoder().decode(value) : '';
    if (stopWhen(text)) break;
  }
  return text;
}

// The recent-event ring the gateway replays from, newest-first, exactly as the
// gateway holds it. `turn-2` is the turn now running; everything before it is
// the previous turn's tail, terminal frame included.
function ring(): ScopedControlPlaneRecentEvent[] {
  return [
    { id: 'evt-4', event: 'turn', createdAt: 4, payload: { type: 'TURN_SUBMITTED', turnId: 'turn-2' } },
    { id: 'evt-3', event: 'turn', createdAt: 3, payload: { type: 'TURN_COMPLETED', turnId: 'turn-1' } },
    { id: 'evt-2', event: 'turn', createdAt: 2, payload: { type: 'STREAM_DELTA', turnId: 'turn-1' } },
    { id: 'evt-1', event: 'turn', createdAt: 1, payload: { type: 'TURN_SUBMITTED', turnId: 'turn-1' } },
  ];
}

function replayIds(sinceId?: string): string[] {
  const sent: string[] = [];
  replayRecentTraffic(
    ring(),
    (_event, _payload, id) => { if (id) sent.push(id); },
    { clientId: 'c1', domains: ['turn'] },
    null,
    sinceId,
  );
  return sent;
}

describe('the gateway replays only what a client has not already seen', () => {
  test('a client presenting NO position gets the catch-up window (the reported defect)', () => {
    // This is what a fresh-stream-per-turn client used to look like on the wire,
    // and the previous turn's terminal frame is right there in the answer.
    expect(replayIds()).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
  });

  test('a client presenting its position is replayed only what came after it', () => {
    expect(replayIds('evt-3')).toEqual(['evt-4']);
    expect(resolveReplayResume(ring(), 'evt-3')).toEqual({ resume: 'resumed', sinceId: 'evt-3', replayed: 1 });
  });

  test('a position at the head of the ring replays nothing at all', () => {
    expect(replayIds('evt-4')).toEqual([]);
  });

  test('a position the ring no longer holds replays NOTHING, and says so', () => {
    // The id aged out of the ring, or the gateway restarted. Ids are random per
    // record, not ordered, so "everything after it" cannot be computed. Falling
    // back to the whole catch-up window is what re-sent turn-1's TURN_COMPLETED
    // into turn-2 — a client that states a position never gets that guess.
    expect(replayIds('evt-gone')).toEqual([]);
    expect(resolveReplayResume(ring(), 'evt-gone')).toEqual({ resume: 'unresolved', sinceId: 'evt-gone' });
  });

  test('no position at all is reported as such rather than as a resume', () => {
    expect(resolveReplayResume(ring(), undefined)).toEqual({ resume: 'none' });
  });

  test('the live gateway states the resume outcome on its ready frame', async () => {
    await flushMicrotasks();
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    gateway.publishEvent('agents', { type: 'AGENT_STARTED', payload: { id: 'a1' } });
    await flushMicrotasks();

    const abort = new AbortController();
    const response = gateway.createEventStream(
      new Request('http://127.0.0.1/api/control-plane/events?domains=agents', {
        signal: abort.signal,
        headers: { 'last-event-id': 'evt-not-in-this-ring' },
      }),
      { domains: ['agents'] },
    );
    const text = await readStreamText(response.body?.getReader(), (t) => t.includes('event: ready'));
    abort.abort();

    expect(text).toContain('"resume":{"resume":"unresolved","sinceId":"evt-not-in-this-ring"}');
    // And the unresolvable position bought silence, not the previous turn's tail.
    expect(text).not.toContain('AGENT_STARTED');
  });
});

describe('the stream surfaces the position it reached', () => {
  test('the id of every frame is reported, and the handle carries the last one', async () => {
    const ids: string[] = [];
    const stop = await openRawServerSentEventStream(
      fetchStub(async () => sseResponse([
        'event: ready\ndata: {}\n\n',
        'id: evt-1\nevent: turn\ndata: {"type":"STREAM_DELTA"}\n\n',
        'id: evt-2\nevent: turn\ndata: {"type":"TURN_COMPLETED"}\n\n',
      ])),
      'http://127.0.0.1:3210/api/control-plane/events?domains=turn',
      { onEventId: (id) => { ids.push(id); } },
      { reconnect: { enabled: false } },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ids).toEqual(['evt-1', 'evt-2']);
    // A caller that closes this stream and opens the next one for the following
    // turn can read the position off the handle without holding a callback.
    expect(stop.lastEventId).toBe('evt-2');
    stop();
  });

  test('a stream that never saw an id reports no position rather than a stale one', async () => {
    const stop = await openRawServerSentEventStream(
      fetchStub(async () => sseResponse(['event: ready\ndata: {}\n\n'])),
      'http://127.0.0.1:3210/api/control-plane/events?domains=turn',
      {},
      { reconnect: { enabled: false } },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stop.lastEventId).toBeNull();
    stop();
  });

  test('a position handed in up front is presented on the very first request', async () => {
    const headers: Array<string | null> = [];
    const stop = await openRawServerSentEventStream(
      fetchStub(async (_input, init) => {
        headers.push(new Headers(init?.headers).get('last-event-id'));
        return sseResponse(['event: ready\ndata: {}\n\n']);
      }),
      'http://127.0.0.1:3210/api/control-plane/events?domains=turn',
      {},
      { reconnect: { enabled: false }, lastEventId: 'evt-7' },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(headers).toEqual(['evt-7']);
    stop();
  });
});

describe('a replayed terminal frame cannot finish a turn it does not belong to', () => {
  const frame = (type: string, turnId: string, sessionId = 's1') =>
    readTurnLifecycleFrame(sessionId, { type, turnId })!;

  test('the replayed tail of the previous turn is refused while a new turn runs', () => {
    const gate = createTurnLifecycleGate();
    // Turn 2 starts — this is the turn the consumer is rendering.
    expect(gate.accepts(frame('TURN_SUBMITTED', 'turn-2'))).toBe(true);
    // The replayed tail of turn 1 arrives. Under the defect this finished the
    // renderer and every subsequent turn-2 frame was dropped.
    expect(gate.accepts(frame('STREAM_DELTA', 'turn-1'))).toBe(false);
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-1'))).toBe(false);
    // Turn 2's real frames still land, including its own ending.
    expect(gate.accepts(frame('STREAM_DELTA', 'turn-2'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-2'))).toBe(true);
  });

  test('a terminal frame for a turn never seen to start is refused outright', () => {
    // The replay lands BEFORE the new turn is submitted — the exact ordering on
    // a fresh per-turn stream. Nothing is bound yet, and a consumer that never
    // saw a turn run has no turn to finish.
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-1'))).toBe(false);
    expect(gate.accepts(frame('TURN_ERROR', 'turn-1'))).toBe(false);
    expect(gate.accepts(frame('TURN_CANCEL', 'turn-1'))).toBe(false);
    expect(gate.accepts(frame('PREFLIGHT_FAIL', 'turn-1'))).toBe(false);
    expect(gate.boundTurnId('s1')).toBeUndefined();
    // The turn that actually starts afterwards renders normally.
    expect(gate.accepts(frame('TURN_SUBMITTED', 'turn-2'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-2'))).toBe(true);
  });

  test('a client attaching mid-turn still renders the turn already in flight', () => {
    // No TURN_SUBMITTED will ever arrive for this consumer, so a rule of "only
    // turns I saw start" would render nothing at all.
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('STREAM_DELTA', 'turn-9'))).toBe(true);
    expect(gate.boundTurnId('s1')).toBe('turn-9');
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-9'))).toBe(true);
  });

  test('bindings are per session, so one connection does not drop another session\'s turn', () => {
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('TURN_SUBMITTED', 'turn-a', 'session-a'))).toBe(true);
    expect(gate.accepts(frame('TURN_SUBMITTED', 'turn-b', 'session-b'))).toBe(true);
    expect(gate.accepts(frame('STREAM_DELTA', 'turn-a', 'session-a'))).toBe(true);
    expect(gate.accepts(frame('STREAM_DELTA', 'turn-b', 'session-b'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 'turn-a', 'session-b'))).toBe(false);
  });

  test('a consumer that states the turn it submitted accepts nothing else, ever', () => {
    const gate = createTurnLifecycleGate({ turnId: 'mine' });
    expect(gate.accepts(frame('STREAM_DELTA', 'mine'))).toBe(true);
    expect(gate.accepts(frame('TURN_COMPLETED', 'mine'))).toBe(true);
    // Not even a later TURN_SUBMITTED steals the binding from a stated turn.
    expect(gate.accepts(frame('TURN_SUBMITTED', 'someone-elses'))).toBe(false);
    expect(gate.accepts(frame('TURN_COMPLETED', 'someone-elses'))).toBe(false);
    expect(gate.boundTurnId('s1')).toBe('mine');
  });

  test('frames that name no turn are never withheld', () => {
    const gate = createTurnLifecycleGate();
    expect(gate.accepts(frame('TURN_SUBMITTED', 'turn-1'))).toBe(true);
    // Session, provider, agent and ops frames carry no turnId and are not the
    // gate's business.
    expect(gate.accepts(readTurnLifecycleFrame('s1', { type: 'SESSION_STARTED' })!)).toBe(true);
    expect(gate.accepts(readTurnLifecycleFrame('s1', { type: 'AGENT_COMPLETED', agentId: 'a1' })!)).toBe(true);
  });

  test('a payload that is not an event at all is read as no frame, not as a foreign one', () => {
    expect(readTurnLifecycleFrame('s1', null)).toBeNull();
    expect(readTurnLifecycleFrame('s1', 'text')).toBeNull();
    expect(readTurnLifecycleFrame('s1', { turnId: 't1' })).toBeNull();
  });

  test('the binding map is bounded, and an evicted session simply rebinds', () => {
    const gate = createTurnLifecycleGate({ maxTrackedSessions: 2 });
    expect(gate.accepts(frame('TURN_SUBMITTED', 't1', 's1'))).toBe(true);
    expect(gate.accepts(frame('TURN_SUBMITTED', 't2', 's2'))).toBe(true);
    expect(gate.accepts(frame('TURN_SUBMITTED', 't3', 's3'))).toBe(true);
    // s1 is gone, so it is unbound rather than wrong — its next start rebinds.
    expect(gate.boundTurnId('s1')).toBeUndefined();
    expect(gate.boundTurnId('s3')).toBe('t3');
    expect(gate.accepts(frame('TURN_SUBMITTED', 't4', 's1'))).toBe(true);
    expect(gate.boundTurnId('s1')).toBe('t4');
  });

  test('reset() forgets every binding', () => {
    const gate = createTurnLifecycleGate();
    gate.accepts(frame('TURN_SUBMITTED', 'turn-1'));
    gate.reset();
    expect(gate.boundTurnId('s1')).toBeUndefined();
  });
});
