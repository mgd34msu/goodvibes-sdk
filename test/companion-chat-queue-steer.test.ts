/**
 * companion-chat-queue-steer.test.ts
 *
 * Queue-when-busy sends + the steer verb (companion.chat.messages.steer):
 * Q1: a send during an active turn QUEUES — transcript-visible immediately
 *     with deliveryState 'queued', answered after the current turn, marker
 *     cleared when its turn starts
 * Q2: steer jumps the queue AND cancels the active turn through the honest
 *     stop path; previously queued messages keep their places behind it
 * Q3: steer with no turn running is an ordinary send
 * Q4: turns are strictly sequential — never concurrent against one
 *     conversation, no matter how fast sends arrive
 */

import { describe, expect, test } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type { CompanionLLMProvider } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';

interface CapturedEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

function makeGate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

/**
 * A provider whose Nth chatStream call yields `reply-N `, then (if a gate is
 * registered for N) blocks until the gate opens, then finishes. Tracks the
 * maximum number of concurrently running streams — the sequential-turns
 * invariant under test.
 */
function makeSequencedProvider(gates: Record<number, { wait: Promise<void> }>) {
  let calls = 0;
  let active = 0;
  const stats = { maxActive: 0, calls: () => calls };
  const provider: CompanionLLMProvider = {
    async *chatStream() {
      const idx = calls++;
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        yield { type: 'text_delta' as const, delta: `reply-${idx} ` };
        const gate = gates[idx];
        if (gate) await gate.wait;
        yield { type: 'done' as const };
      } finally {
        active -= 1;
      }
    },
  };
  return { provider, stats };
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

async function waitForCount(events: CapturedEvent[], name: string, count: number, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (events.filter((e) => e.name === name).length >= count) return;
    await settleEvents();
  }
  throw new Error(`never saw ${count}x ${name}; saw: ${events.map((e) => e.name).join(', ')}`);
}

describe('Q1: queue-when-busy', () => {
  test('a send during an active turn queues, is marked honestly, and runs after', async () => {
    const events: CapturedEvent[] = [];
    const gate0 = makeGate();
    const { provider, stats } = makeSequencedProvider({ 0: gate0 });
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    const idA = await manager.postMessage(session.id, 'first');
    await waitForCount(events, 'companion-chat.turn.started', 1);
    const idB = await manager.postMessage(session.id, 'second');

    // B is transcript-visible immediately, honestly marked queued.
    const during = manager.getMessages(session.id);
    const queuedB = during.find((m) => m.id === idB);
    expect(queuedB?.deliveryState).toBe('queued');
    // Only ONE turn has started.
    expect(events.filter((e) => e.name === 'companion-chat.turn.started')).toHaveLength(1);

    gate0.open();
    await waitForCount(events, 'companion-chat.turn.completed', 2);

    // The transcript is append-ordered (queued user messages land before the
    // running turn's reply); pairing is carried by inReplyTo.
    const after = manager.getMessages(session.id);
    const order = after.map((m) => (m.role === 'user' ? m.content : m.content.trim()));
    expect(order).toEqual(['first', 'second', 'reply-0', 'reply-1']);
    const replyToA = after.find((m) => m.inReplyTo === idA);
    const replyToB = after.find((m) => m.inReplyTo === idB);
    expect(replyToA?.content.trim()).toBe('reply-0');
    expect(replyToB?.content.trim()).toBe('reply-1');
    // The queued marker cleared when its turn ran.
    expect(after.find((m) => m.id === idB)?.deliveryState).toBeUndefined();
    expect(after.find((m) => m.id === idA)?.deliveryState).toBeUndefined();
    expect(stats.maxActive).toBe(1);
  });
});

describe('Q2: steer jumps the queue and interrupts', () => {
  test('steer cancels the active turn honestly and runs before queued sends', async () => {
    const events: CapturedEvent[] = [];
    const gate0 = makeGate();
    const { provider, stats } = makeSequencedProvider({ 0: gate0 });
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await manager.postMessage(session.id, 'doomed');
    await waitForCount(events, 'companion-chat.turn.delta', 1);
    const idQueued = await manager.postMessage(session.id, 'patient');

    const steerPromise = manager.steerMessage(session.id, 'urgent');
    gate0.open(); // release the provider so the abort is observed
    const steer = await steerPromise;

    expect(steer.steered).toBe(true);
    expect(steer.cancelledTurnId).toBeDefined();

    await waitForCount(events, 'companion-chat.turn.completed', 2); // urgent + patient
    await waitForCount(events, 'companion-chat.turn.cancelled', 1);

    const messages = manager.getMessages(session.id);
    const contents = messages.map((m) => m.content.trim());
    // The cancelled partial is retained and marked.
    const cancelled = messages.find((m) => m.deliveryState === 'cancelled');
    expect(cancelled?.role).toBe('assistant');
    // The steer's turn ran BEFORE the earlier-queued message's turn: its
    // reply (reply-1) precedes patient's reply (reply-2), and pairing holds.
    const urgentReplyIdx = contents.indexOf('reply-1');
    const patientReplyIdx = contents.indexOf('reply-2');
    expect(urgentReplyIdx).toBeGreaterThan(-1);
    expect(patientReplyIdx).toBeGreaterThan(urgentReplyIdx);
    const urgentMsg = messages.find((m) => m.content === 'urgent');
    expect(messages.find((m) => m.inReplyTo === urgentMsg?.id)?.content.trim()).toBe('reply-1');
    expect(messages.find((m) => m.id === idQueued && m.deliveryState === undefined)).toBeDefined();
    expect(stats.maxActive).toBe(1);
  });
});

describe('Q3: steer with no active turn', () => {
  test('behaves as an ordinary send', async () => {
    const events: CapturedEvent[] = [];
    const { provider } = makeSequencedProvider({});
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    const result = await manager.steerMessage(session.id, 'hello');
    expect(result.steered).toBe(true);
    expect(result.cancelledTurnId).toBeUndefined();
    await waitForCount(events, 'companion-chat.turn.completed', 1);
    expect(events.filter((e) => e.name === 'companion-chat.turn.cancelled')).toHaveLength(0);
  });
});

describe('Q4: turns never run concurrently', () => {
  test('rapid-fire sends serialize', async () => {
    const events: CapturedEvent[] = [];
    const { provider, stats } = makeSequencedProvider({});
    const manager = makeManager(provider, events);
    const session = manager.createSession({ provider: 'p', model: 'm' });

    await Promise.all([
      manager.postMessage(session.id, 'one'),
      manager.postMessage(session.id, 'two'),
      manager.postMessage(session.id, 'three'),
    ]);
    await waitForCount(events, 'companion-chat.turn.completed', 3);
    expect(stats.maxActive).toBe(1);
    expect(stats.calls()).toBe(3);
  });
});
