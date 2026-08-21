/**
 * domain-events-listener-containment.test.ts
 *
 * A subscriber callback that throws is application code, not a transport
 * failure. The SSE read loop (transport-http's sse-stream.ts) has no catch
 * around its onEvent call and reconnect is off by default, so an exception that
 * escaped the domain-event dispatch unwound the read loop and killed the feed
 * permanently: every later event, for every other subscriber on that domain,
 * was silently lost. The WebSocket path already contained listener errors in
 * runtime-events.ts's onMessage; these pin the same containment for SSE.
 */
import { describe, expect, test } from 'bun:test';
import { createEventSourceConnector } from '../packages/transport-realtime/src/event-source-connector.ts';
import { createRemoteRuntimeEvents } from '../packages/transport-realtime/src/runtime-events.ts';
import { createRemoteDomainEvents, forSession } from '../packages/transport-realtime/src/domain-events.ts';

/** A stream that stays open, so the connector does not treat close as a drop. */
function openSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

/** A frame with no turnId, so the turn-lifecycle gate passes it straight through. */
function frame(id: string, type: string, seq: number): string {
  return `id: ${id}\nevent: turn\ndata: ${JSON.stringify({ type, sessionId: 's1', payload: { seq } })}\n\n`;
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 20)); };

describe('a throwing domain-event listener never reaches the transport', () => {
  test('the SSE feed keeps delivering after a listener throws on an earlier frame', async () => {
    const reported: string[] = [];
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      null,
      fetchStub(async () => openSseResponse([
        frame('evt-1', 'STREAM_DELTA', 1),
        frame('evt-2', 'STREAM_DELTA', 2),
        frame('evt-3', 'STREAM_DELTA', 3),
      ])),
      { reconnect: { enabled: false } },
    );
    const events = createRemoteRuntimeEvents(connector, {
      onError: (error) => { reported.push(error.message); },
    });

    const seen: number[] = [];
    events.turn.on('STREAM_DELTA' as never, ((payload: { seq: number }) => {
      if (payload.seq === 1) throw new Error('subscriber blew up');
      seen.push(payload.seq);
    }) as never);

    await settle();

    // Before the fix the frame-1 throw unwound the SSE read loop and frames 2
    // and 3 were never delivered.
    expect(seen).toEqual([2, 3]);
    expect(reported.some((message) => message.includes('subscriber blew up'))).toBe(true);
  });

  test('a throwing listener does not starve the other listeners on the same event', async () => {
    const ref: { dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null } = { dispatch: null };
    const errors: Error[] = [];
    const events = createRemoteDomainEvents(
      ['alpha'] as const,
      async (_domain, onEnvelope) => {
        ref.dispatch = onEnvelope as typeof ref.dispatch;
        return () => {};
      },
      { onConnectionError: (error) => { errors.push(error); } },
    );

    const delivered: string[] = [];
    events.alpha.on('ALPHA_READY', () => { throw new Error('first listener throws'); });
    events.alpha.on('ALPHA_READY', () => { delivered.push('second'); });
    events.alpha.onEnvelope('ALPHA_READY', () => { delivered.push('envelope'); });

    await Promise.resolve();
    expect(() => ref.dispatch?.({ type: 'ALPHA_READY', payload: {} })).not.toThrow();

    expect(delivered).toEqual(['second', 'envelope']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('first listener throws');
    expect((errors[0] as { cause?: unknown }).cause).toBeInstanceOf(Error);

    // The feed is still live: a second dispatch is delivered normally.
    ref.dispatch?.({ type: 'ALPHA_READY', payload: {} });
    expect(delivered).toEqual(['second', 'envelope', 'second', 'envelope']);
  });

  test('an onConnectionError handler that itself throws is contained too', async () => {
    const ref: { dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null } = { dispatch: null };
    const events = createRemoteDomainEvents(
      ['alpha'] as const,
      async (_domain, onEnvelope) => {
        ref.dispatch = onEnvelope as typeof ref.dispatch;
        return () => {};
      },
      { onConnectionError: () => { throw new Error('reporter throws too'); } },
    );

    events.alpha.on('ALPHA_READY', () => { throw new Error('listener throws'); });
    await Promise.resolve();

    expect(() => ref.dispatch?.({ type: 'ALPHA_READY', payload: {} })).not.toThrow();
  });

  test('forSession: one throwing subscriber does not skip the others sharing its slot', async () => {
    const ref: { dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null } = { dispatch: null };
    const errors: Error[] = [];
    const events = createRemoteDomainEvents(
      ['alpha'] as const,
      async (_domain, onEnvelope) => {
        ref.dispatch = onEnvelope as typeof ref.dispatch;
        return () => {};
      },
      { onConnectionError: (error) => { errors.push(error); } },
    );

    const scoped = forSession(events, 'session-A');
    const delivered: string[] = [];
    scoped.alpha.on('ALPHA_READY', () => { throw new Error('scoped listener throws'); });
    scoped.alpha.on('ALPHA_READY', () => { delivered.push('sibling'); });

    await Promise.resolve();
    expect(() => ref.dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} })).not.toThrow();

    expect(delivered).toEqual(['sibling']);
    expect(errors).toHaveLength(1);
  });
});
