/**
 * hosted-session-render-grade-events.test.ts
 *
 * A daemon-hosted session runs the ordinary Orchestrator inside the daemon, so
 * a client that did not run the loop can only render the turn from what the
 * event stream hands it. These tests pin what that stream actually carries.
 *
 * The frames a renderer needs are emitted on TWO domains:
 *   - `turn`  — STREAM_DELTA (the text), LLM_RESPONSE_RECEIVED (the usage),
 *               TURN_COMPLETED (the end).
 *   - `tools` — TOOL_RECEIVED (the call), TOOL_SUCCEEDED / TOOL_FAILED (the
 *               result).
 *
 * `DEFAULT_DOMAINS` contains `turn` and NOT `tools`. A stream on the defaults
 * therefore delivered everything the model SAID and nothing it DID — the
 * "before" this file also pins, so the reason RENDER_GRADE_SESSION_DOMAINS
 * exists cannot quietly stop being true.
 */
import { describe, expect, test } from 'bun:test';
import {
  ControlPlaneGateway,
  DEFAULT_DOMAINS,
  RENDER_GRADE_SESSION_DOMAINS,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  emitStreamDelta,
  emitToolReceived,
  emitToolSucceeded,
  emitLlmResponseReceived,
  emitTurnCompleted,
} from '@pellux/goodvibes-sdk/platform/runtime/emitters';
import { RuntimeEventBus } from './_helpers/runtime-seam.ts';

const HOSTED_SESSION_ID = 'hosted-11111111-2222-3333-4444-555555555555';
const OTHER_SESSION_ID = 'hosted-99999999-8888-7777-6666-555555555555';

/** bus.emit dispatches asynchronously; let listeners run before asserting. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/** Read up to `maxReads` SSE chunks, stopping early once `stopWhen` is satisfied. */
async function readStreamText(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  stopWhen: (text: string) => boolean,
  maxReads = 12,
): Promise<string> {
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  for (let index = 0; index < maxReads; index += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value);
    if (stopWhen(text)) break;
  }
  return text;
}

/**
 * Emit one turn's worth of render-grade frames exactly as the hosted loop does:
 * the same emitter functions the Orchestrator calls, stamped with the hosted
 * session's id the way `createEmitterContext(sessionId, turnId)` stamps them.
 *
 * Using the real emitters is the point — a tool event that moved off the
 * `tools` domain, or a delta that stopped carrying its session id, has to break
 * this test rather than pass it.
 */
function emitHostedTurn(bus: RuntimeEventBus, sessionId: string): void {
  const ctx = { sessionId, traceId: `turn:${sessionId}`, source: 'orchestrator' };
  const turnId = `t-${sessionId}`;

  emitStreamDelta(bus, ctx, { turnId, content: 'Reading the file', accumulated: 'Reading the file' });
  emitToolReceived(bus, ctx, {
    callId: 'call-1',
    turnId,
    tool: 'read_file',
    args: { path: '/tmp/notes.md' },
  });
  emitToolSucceeded(bus, ctx, {
    callId: 'call-1',
    turnId,
    tool: 'read_file',
    durationMs: 12,
    result: { kind: 'text', byteSize: 5, preview: 'hello' },
  });
  emitLlmResponseReceived(bus, ctx, {
    turnId,
    provider: 'anthropic',
    model: 'claude-opus-5',
    contentSummary: 'done',
    toolCallCount: 1,
    inputTokens: 1200,
    outputTokens: 64,
  });
  emitTurnCompleted(bus, ctx, { turnId, response: 'Read it.', stopReason: 'completed' });
}

/** Parse an SSE body into its `data:` payloads. */
function parseFrames(body: string): { type: string; sessionId?: string }[] {
  return [...body.matchAll(/^data:\s*(.+)$/gm)]
    .map((match) => {
      try {
        return JSON.parse(match[1]!) as { type?: string; sessionId?: string };
      } catch {
        return null;
      }
    })
    .filter((value): value is { type: string; sessionId?: string } =>
      value !== null && typeof value.type === 'string');
}

describe('hosted-session event stream carries render-grade frames', () => {
  test('a render-grade stream delivers text deltas, tool call and tool result, and usage', async () => {
    const bus = new RuntimeEventBus();
    const gateway = new ControlPlaneGateway({ runtimeBus: bus });
    const abort = new AbortController();

    const response = gateway.createEventStream(
      new Request(`http://127.0.0.1/api/sessions/${HOSTED_SESSION_ID}/events`, { signal: abort.signal }),
      {
        clientId: `shared-session:${HOSTED_SESSION_ID}`,
        clientKind: 'web',
        sessionId: HOSTED_SESSION_ID,
        sessionScopedDelivery: true,
        domains: RENDER_GRADE_SESSION_DOMAINS,
      },
    );
    const reader = response.body?.getReader();
    await flushMicrotasks();

    emitHostedTurn(bus, HOSTED_SESSION_ID);
    await flushMicrotasks();

    const body = await readStreamText(reader, (text) => text.includes('TURN_COMPLETED'));
    abort.abort();

    const types = parseFrames(body).map((frame) => frame.type);

    // The text the model produced.
    expect(types).toContain('STREAM_DELTA');
    // What it DID — the frames DEFAULT_DOMAINS drops on the floor.
    expect(types).toContain('TOOL_RECEIVED');
    expect(types).toContain('TOOL_SUCCEEDED');
    // The accounting, so a remote renderer can show real token numbers.
    expect(types).toContain('LLM_RESPONSE_RECEIVED');
    expect(types).toContain('TURN_COMPLETED');

    // The delta must carry its content, not merely announce that one happened.
    const delta = parseFrames(body).find((frame) => frame.type === 'STREAM_DELTA') as
      { payload?: { content?: string; accumulated?: string } } | undefined;
    expect(delta?.payload?.content).toBe('Reading the file');
    expect(delta?.payload?.accumulated).toBe('Reading the file');

    // The tool frames must name the tool and correlate to one call id.
    const toolCall = parseFrames(body).find((frame) => frame.type === 'TOOL_RECEIVED') as
      { payload?: { tool?: string; callId?: string } } | undefined;
    const toolResult = parseFrames(body).find((frame) => frame.type === 'TOOL_SUCCEEDED') as
      { payload?: { tool?: string; callId?: string } } | undefined;
    expect(toolCall?.payload?.tool).toBe('read_file');
    expect(toolResult?.payload?.callId).toBe(toolCall?.payload?.callId);

    // Usage has to be real numbers a client can render.
    const usage = parseFrames(body).find((frame) => frame.type === 'LLM_RESPONSE_RECEIVED') as
      { payload?: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(usage?.payload?.inputTokens).toBe(1200);
    expect(usage?.payload?.outputTokens).toBe(64);
  });

  test('the default domain set carries the text but no tool frame — why the render-grade set exists', async () => {
    // Pins the defect this change fixes. DEFAULT_DOMAINS is the set every
    // un-configured subscriber gets; `tools` is absent from it by construction.
    expect(DEFAULT_DOMAINS).toContain('turn');
    expect(DEFAULT_DOMAINS).not.toContain('tools');
    expect(RENDER_GRADE_SESSION_DOMAINS).toContain('tools');
    // Additive: nothing a default subscriber already received is taken away.
    for (const domain of DEFAULT_DOMAINS) {
      expect(RENDER_GRADE_SESSION_DOMAINS).toContain(domain);
    }

    const bus = new RuntimeEventBus();
    const gateway = new ControlPlaneGateway({ runtimeBus: bus });
    const abort = new AbortController();

    const response = gateway.createEventStream(
      new Request(`http://127.0.0.1/api/sessions/${HOSTED_SESSION_ID}/events`, { signal: abort.signal }),
      {
        clientId: `defaults:${HOSTED_SESSION_ID}`,
        clientKind: 'web',
        sessionId: HOSTED_SESSION_ID,
        domains: DEFAULT_DOMAINS,
      },
    );
    const reader = response.body?.getReader();
    await flushMicrotasks();

    emitHostedTurn(bus, HOSTED_SESSION_ID);
    await flushMicrotasks();

    const body = await readStreamText(reader, (text) => text.includes('TURN_COMPLETED'));
    abort.abort();

    const types = parseFrames(body).map((frame) => frame.type);
    expect(types).toContain('STREAM_DELTA');
    expect(types).not.toContain('TOOL_RECEIVED');
    expect(types).not.toContain('TOOL_SUCCEEDED');
  });

  test('a session-scoped stream drops another session\'s frames and keeps unstamped ones', async () => {
    const bus = new RuntimeEventBus();
    const gateway = new ControlPlaneGateway({ runtimeBus: bus });
    const abort = new AbortController();

    const response = gateway.createEventStream(
      new Request(`http://127.0.0.1/api/sessions/${HOSTED_SESSION_ID}/events`, { signal: abort.signal }),
      {
        clientId: `scoped:${HOSTED_SESSION_ID}`,
        clientKind: 'web',
        sessionId: HOSTED_SESSION_ID,
        sessionScopedDelivery: true,
        domains: RENDER_GRADE_SESSION_DOMAINS,
      },
    );
    const reader = response.body?.getReader();
    await flushMicrotasks();

    // A second hosted session's turn must not land in this one's transcript.
    emitHostedTurn(bus, OTHER_SESSION_ID);
    // This session's own turn must.
    emitHostedTurn(bus, HOSTED_SESSION_ID);
    await flushMicrotasks();

    const body = await readStreamText(reader, (text) => text.includes('TURN_COMPLETED'));
    abort.abort();

    const frames = parseFrames(body).filter((frame) => frame.sessionId !== undefined);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.sessionId).toBe(HOSTED_SESSION_ID);
    }
    expect(frames.some((frame) => frame.type === 'STREAM_DELTA')).toBe(true);
    expect(frames.some((frame) => frame.type === 'TOOL_RECEIVED')).toBe(true);
  });
});
