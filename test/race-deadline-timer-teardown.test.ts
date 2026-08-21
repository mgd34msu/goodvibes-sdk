/**
 * race-deadline-timer-teardown.test.ts
 *
 * Two timers that were created and then forgotten.
 *
 * The losing side of a `Promise.race` is never settled, so a `setTimeout` used
 * as a deadline keeps its handle, and the closure it holds, until the delay
 * finally elapses, even though the result was decided long before. And a
 * one-shot timer held only in a local variable cannot be cancelled by the
 * owner's `dispose()`, because nothing outside that function ever had a
 * reference to it.
 *
 * Both were measured across a full suite run: 65 uncleared 15s lock deadlines,
 * 38 uncancellable WRFC chain-cleanup timers. Neither pins the event loop,
 * they are unref'd, but both retain their closures and both still fire.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { cancelActiveTurn, type ActiveCompanionTurn } from '../packages/sdk/src/platform/companion/companion-chat-turn-control.ts';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.ts';
import { AgentManager } from '../packages/sdk/src/platform/tools/agent/index.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

/** Delays the two subjects use, so an assertion names the timer it means. */
const CANCEL_SETTLE_TIMEOUT_MS = 3_000;
const CHAIN_CLEANUP_DELAY_MS = 60_000;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Delay -> count of handles created at that delay and not yet cleared or fired. */
let pending: Map<number, number>;

beforeEach(() => {
  pending = new Map<number, number>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const delay = ms ?? 0;
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => {
      pending.set(delay, (pending.get(delay) ?? 1) - 1);
      (fn as (...x: unknown[]) => void)(...a);
    };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    pending.set(delay, (pending.get(delay) ?? 0) + 1);
    (handle as { __delay?: number }).__delay = delay;
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: { __delay?: number }) => {
    if (handle?.__delay !== undefined) {
      pending.set(handle.__delay, (pending.get(handle.__delay) ?? 1) - 1);
    }
    return realClearTimeout(handle as never);
  }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

test('cancelActiveTurn clears its settle deadline when the turn settles first', async () => {
  const turn: ActiveCompanionTurn = {
    turnId: 'turn-1',
    controller: new AbortController(),
    cancelRequested: false,
    // Already settled: the deadline loses the race immediately, which is the
    // ordinary case and the one that used to strand a 3s handle every time.
    settled: Promise.resolve({ partialPersisted: true }),
  };

  const result = await cancelActiveTurn('session-1', turn, {});

  expect(result.cancelled).toBe(true);
  expect(result.partialPersisted).toBe(true);
  expect(pending.get(CANCEL_SETTLE_TIMEOUT_MS) ?? 0).toBe(0);
});

test('WrfcController.dispose() cancels a pending chain-cleanup timer', () => {
  const bus = new RuntimeEventBus();
  const controller = new WrfcController(bus, new AgentMessageBus(), {
    agentManager: new AgentManager(),
    configManager: new ConfigManager({ workingDir: '/tmp', homeDir: '/tmp', surfaceRoot: 'goodvibes' }),
    projectRoot: '/tmp/wrfc-timer-teardown',
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });

  // scheduleChainCleanup is private by design, it is an internal reaction to a
  // chain reaching a terminal state. What is under test is purely who owns the
  // handle it creates, so the test reaches it directly rather than driving a
  // whole chain to completion to provoke one setTimeout.
  const schedule = (controller as unknown as {
    scheduleChainCleanup(chain: { id: string; state: string }): void;
  }).scheduleChainCleanup.bind(controller);

  schedule({ id: 'chain-a', state: 'complete' });
  schedule({ id: 'chain-b', state: 'failed' });
  expect(pending.get(CHAIN_CLEANUP_DELAY_MS) ?? 0).toBe(2);

  controller.dispose();
  expect(pending.get(CHAIN_CLEANUP_DELAY_MS) ?? 0).toBe(0);
});
