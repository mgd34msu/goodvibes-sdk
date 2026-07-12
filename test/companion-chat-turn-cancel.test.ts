/**
 * companion-chat-turn-cancel.test.ts
 *
 * The server-side turn stop (companion.chat.turns.cancel):
 * C1: cancel mid-stream persists the honest partial (deliveryState 'cancelled')
 *     and publishes the terminal turn.cancelled — never turn.completed
 * C2: the NEXT turn after a cancel runs normally (per-turn abort controller —
 *     a stop must never poison the session's future turns)
 * C3: refusal semantics — 404 NO_ACTIVE_TURN, 404 SESSION_NOT_FOUND,
 *     409 TURN_MISMATCH; repeat cancel is an idempotent success
 * C4: cancel before any content → partialPersisted false, no phantom message,
 *     terminal event still emitted
 * C5: a tool call announced but never resolved is closed with a synthetic
 *     error turn.tool_result BEFORE turn.cancelled (no wedged tool blocks)
 * C6: closing the session mid-turn finalizes as stoppedBy 'session-closed'
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

/** A gate the test opens to let the provider yield its next chunk. */
function makeGate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

/**
 * A provider that yields `firstChunks`, then blocks on the gate, then yields
 * `afterGateChunks`. The abort signal is deliberately NOT honored by the
 * provider itself — the manager's own per-chunk abort check is under test.
 */
function makeGatedProvider(
  gate: { wait: Promise<void> },
  firstChunks: CompanionProviderChunk[],
  afterGateChunks: CompanionProviderChunk[] = [{ type: 'done' }],
): CompanionLLMProvider {
  return {
    async *chatStream() {
      for (const chunk of firstChunks) yield chunk;
      await gate.wait;
      for (const chunk of afterGateChunks) yield chunk;
    },
  };
}

function makeManager(provider: CompanionLLMProvider, events: CapturedEvent[]): CompanionChatManager {
  return new CompanionChatManager({
    provider,
    eventPublisher: {
      publishEvent(name: string, payload: unknown) {
        events.push({ name, payload: payload as Record<string, unknown> });
      },
    },
    gcIntervalMs: 999_999,
  });
}

function eventTypes(events: CapturedEvent[]): string[] {
  return events.map((e) => e.name);
}

async function waitForEvent(events: CapturedEvent[], name: string, tries = 50): Promise<CapturedEvent> {
  for (let i = 0; i < tries; i++) {
    const found = events.find((e) => e.name === name);
    if (found) return found;
    await settleEvents();
  }
  throw new Error(`event ${name} never published; saw: ${eventTypes(events).join(', ')}`);
}

// ---------------------------------------------------------------------------
// C1: cancel mid-stream — honest partial + terminal turn.cancelled
// ---------------------------------------------------------------------------

describe('Cancel mid-stream', () => {
  test('persists the partial with deliveryState cancelled and emits terminal turn.cancelled', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const manager = makeManager(
      makeGatedProvider(gate, [{ type: 'text_delta', delta: 'partial answer ' }]),
      events,
    );
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'question');
    await waitForEvent(events, 'companion-chat.turn.delta');

    const cancelPromise = manager.cancelTurn(session.id);
    gate.open(); // provider yields; the manager's per-chunk abort check fires
    const result = await cancelPromise;

    expect(result.cancelled).toBe(true);
    expect(result.partialPersisted).toBe(true);
    expect(result.turnId).not.toBe('');

    const cancelled = await waitForEvent(events, 'companion-chat.turn.cancelled');
    expect(cancelled.payload['stoppedBy']).toBe('user');
    expect(cancelled.payload['partialPersisted']).toBe(true);
    const envelope = cancelled.payload['envelope'] as Record<string, unknown>;
    expect(envelope['body']).toBe('partial answer ');
    expect(envelope['source']).toBe('companion-chat-assistant');

    // Terminal means terminal: no turn.completed for this turn.
    expect(eventTypes(events)).not.toContain('companion-chat.turn.completed');

    // The transcript carries the honest partial, marked.
    const messages = manager.getMessages(session.id);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('partial answer ');
    expect(assistant?.deliveryState).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// C2: the next turn is unaffected (per-turn controller, not session-level)
// ---------------------------------------------------------------------------

describe('Next turn after a cancel', () => {
  test('a fresh turn completes normally after a cancelled one', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    let turnCount = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream() {
        turnCount += 1;
        if (turnCount === 1) {
          yield { type: 'text_delta', delta: 'doomed' } satisfies CompanionProviderChunk;
          await gate.wait;
        }
        yield { type: 'text_delta', delta: 'second answer' } satisfies CompanionProviderChunk;
        yield { type: 'done' } satisfies CompanionProviderChunk;
      },
    };
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'first');
    await waitForEvent(events, 'companion-chat.turn.delta');
    const cancelPromise = manager.cancelTurn(session.id);
    gate.open();
    await cancelPromise;
    await waitForEvent(events, 'companion-chat.turn.cancelled');

    // Second turn must stream and COMPLETE — a session-level abort would have
    // left the signal permanently aborted and killed this turn instantly.
    await manager.postMessage(session.id, 'second');
    const completed = await waitForEvent(events, 'companion-chat.turn.completed');
    const envelope = completed.payload['envelope'] as Record<string, unknown>;
    expect(envelope['body']).toBe('second answer');
  });
});

// ---------------------------------------------------------------------------
// C3: refusal semantics
// ---------------------------------------------------------------------------

describe('Refusals are honest machine codes', () => {
  test('no turn in flight → 404 NO_ACTIVE_TURN', async () => {
    const events: CapturedEvent[] = [];
    const manager = makeManager(makeGatedProvider(makeGate(), [{ type: 'done' }]), events);
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await expect(manager.cancelTurn(session.id)).rejects.toMatchObject({
      code: 'NO_ACTIVE_TURN',
      status: 404,
    });
  });

  test('unknown session → 404 SESSION_NOT_FOUND', async () => {
    const events: CapturedEvent[] = [];
    const manager = makeManager(makeGatedProvider(makeGate(), [{ type: 'done' }]), events);
    await expect(manager.cancelTurn('no-such-session')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
  });

  test('turnId guard mismatch → 409 TURN_MISMATCH, and the turn keeps running', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const manager = makeManager(
      makeGatedProvider(gate, [{ type: 'text_delta', delta: 'x' }]),
      events,
    );
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'q');
    await waitForEvent(events, 'companion-chat.turn.started');

    await expect(manager.cancelTurn(session.id, { turnId: 'stale-turn-id' })).rejects.toMatchObject({
      code: 'TURN_MISMATCH',
      status: 409,
    });

    // The guard refusal must not have touched the turn — it completes.
    gate.open();
    await waitForEvent(events, 'companion-chat.turn.completed');
  });

  test('repeat cancel is an idempotent success, never a 500', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const manager = makeManager(
      makeGatedProvider(gate, [{ type: 'text_delta', delta: 'partial' }]),
      events,
    );
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'q');
    await waitForEvent(events, 'companion-chat.turn.delta');

    const first = manager.cancelTurn(session.id);
    const second = manager.cancelTurn(session.id); // before finalization
    gate.open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.cancelled).toBe(true);
    expect(r2.cancelled).toBe(true);
    expect(r2.alreadyCancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4: cancel with no content yet
// ---------------------------------------------------------------------------

describe('Cancel before any content', () => {
  test('no phantom assistant message; terminal event still emitted', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    // No first chunks: the provider blocks before yielding anything.
    const manager = makeManager(makeGatedProvider(gate, []), events);
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'q');
    await waitForEvent(events, 'companion-chat.turn.started');

    const cancelPromise = manager.cancelTurn(session.id);
    gate.open();
    const result = await cancelPromise;

    expect(result.cancelled).toBe(true);
    expect(result.partialPersisted).toBe(false);
    const cancelled = await waitForEvent(events, 'companion-chat.turn.cancelled');
    expect(cancelled.payload['partialPersisted']).toBe(false);
    expect(cancelled.payload['assistantMessageId']).toBeUndefined();

    const messages = manager.getMessages(session.id);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C5: dangling tool calls are closed before the terminal event
// ---------------------------------------------------------------------------

describe('Announced-but-unresolved tool calls', () => {
  test('get a synthetic error turn.tool_result before turn.cancelled', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const manager = makeManager(
      makeGatedProvider(gate, [
        { type: 'text_delta', delta: 'let me check ' },
        { type: 'tool_call', toolCallId: 'tc-1', toolName: 'lookup', toolInput: {} },
      ]),
      events,
    );
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'q');
    await waitForEvent(events, 'companion-chat.turn.tool_call');

    const cancelPromise = manager.cancelTurn(session.id);
    gate.open();
    await cancelPromise;
    await waitForEvent(events, 'companion-chat.turn.cancelled');

    const types = eventTypes(events);
    const resultIdx = types.indexOf('companion-chat.turn.tool_result');
    const cancelledIdx = types.indexOf('companion-chat.turn.cancelled');
    expect(resultIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeLessThan(cancelledIdx);
    const toolResult = events[resultIdx]!.payload;
    expect(toolResult['toolCallId']).toBe('tc-1');
    expect(toolResult['isError']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C6: session close mid-turn
// ---------------------------------------------------------------------------

describe('Session close mid-turn', () => {
  test('finalizes the turn as stoppedBy session-closed', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const manager = makeManager(
      makeGatedProvider(gate, [{ type: 'text_delta', delta: 'partial' }]),
      events,
    );
    const session = manager.createSession({ provider: 'p', model: 'm' });
    await manager.postMessage(session.id, 'q');
    await waitForEvent(events, 'companion-chat.turn.delta');

    manager.closeSession(session.id);
    gate.open();
    const cancelled = await waitForEvent(events, 'companion-chat.turn.cancelled');
    expect(cancelled.payload['stoppedBy']).toBe('session-closed');
  });
});

// ---------------------------------------------------------------------------
// C7: the interrupted partial is visible to the model on later turns
// ---------------------------------------------------------------------------

describe('Partial-in-history', () => {
  test('the next turn sees the interrupted partial plus the interruption note', async () => {
    const events: CapturedEvent[] = [];
    const gate = makeGate();
    const seenByModel: string[][] = [];
    let turnCount = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream(messages) {
        seenByModel.push(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
        turnCount += 1;
        if (turnCount === 1) {
          yield { type: 'text_delta', delta: 'the answer is being computed and' } satisfies CompanionProviderChunk;
          await gate.wait;
        }
        yield { type: 'text_delta', delta: 'second reply' } satisfies CompanionProviderChunk;
        yield { type: 'done' } satisfies CompanionProviderChunk;
      },
    };
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'long question');
    await waitForEvent(events, 'companion-chat.turn.delta');
    const cancelPromise = manager.cancelTurn(session.id);
    gate.open();
    await cancelPromise;
    await waitForEvent(events, 'companion-chat.turn.cancelled');

    await manager.postMessage(session.id, 'hello???');
    await waitForEvent(events, 'companion-chat.turn.completed');

    // The second turn's provider messages include the interrupted partial AND
    // an explicit interruption marker — the model can reason about the true
    // chain of events ("hello???" refers to the visible interruption).
    const secondTurnMessages = seenByModel[1]!;
    const joined = secondTurnMessages.join('\n');
    expect(joined).toContain('the answer is being computed and');
    expect(joined).toContain('[Interrupted: the user stopped this response here, before it was complete.]');
    // And the follow-up question comes after it.
    expect(joined.indexOf('hello???')).toBeGreaterThan(joined.indexOf('[Interrupted:'));
  });
});
