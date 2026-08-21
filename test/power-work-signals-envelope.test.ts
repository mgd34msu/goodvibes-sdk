/**
 * power-work-signals-envelope.test.ts, regression test for the work-signals
 * envelope-shape defect.
 *
 * bindPowerWorkSignals (packages/sdk/src/platform/power/work-signals.ts) used
 * to declare its bus slice with a hand-written envelope shape,
 * `{ event: Record<string, unknown> }`, that has never matched the real
 * `EventEnvelope` (packages/transport-core/src/event-envelope.ts:
 * `type`/`ts`/optional trace-and-id fields/`payload`, never `event`). Every
 * handler read `envelope.event[key]`, i.e. `undefined[key]`, which throws.
 * RuntimeEventBus.emit() catches per-listener errors
 * (events/index.ts:_recordListenerError) rather than propagating them, so the
 * observable effect was silent: the sleep inhibitor was simply never taken,
 * PowerManager.holdWork/releaseWork were never called, and the host could
 * suspend mid-run.
 *
 * This test drives REAL envelopes through a REAL RuntimeEventBus, using the
 * real typed emitters (emitTurnSubmitted, emitAgentSpawning/Completed,
 * emitAutomationRunQueued/Completed) exactly as the orchestrator/agents/
 * automation subsystems call them, never a hand-shaped `{ event: ... }`
 * stub, which would pass against the bug just as happily as against the fix.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { EmitterContext } from '../packages/sdk/src/platform/runtime/emitters/index.ts';
import { emitTurnSubmitted, emitTurnCompleted } from '../packages/sdk/src/platform/runtime/emitters/turn.ts';
import { emitAgentSpawning, emitAgentCompleted } from '../packages/sdk/src/platform/runtime/emitters/agents.ts';
import { emitAutomationRunQueued, emitAutomationRunCompleted } from '../packages/sdk/src/platform/runtime/emitters/automation.ts';
import { bindPowerWorkSignals, type PowerWorkSignalBus } from '../packages/sdk/src/platform/power/work-signals.ts';
import type { PowerManager } from '../packages/sdk/src/platform/power/manager.ts';

/**
 * work-signals.ts's own doc comment on `PowerWorkSignalBus` claims
 * "RuntimeEventBus.on is generic ... so it structurally satisfies this
 * non-generic signature without a cast at the call site", the compiler
 * disagrees: `AnyRuntimeEvent`'s member payloads have no index signature, so
 * `EventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>` is not assignable
 * to `EventEnvelope<string, Record<string, unknown>>`. This test intentionally
 * drives a REAL RuntimeEventBus (not a duck-typed stub) through
 * bindPowerWorkSignals, so the cast below only affects what the type checker
 * believes about `bus`'s static type, the exact same real bus instance is
 * still passed and used at runtime.
 */
function bindOverRealBus(
  bus: RuntimeEventBus,
  manager: Pick<PowerManager, 'holdWork' | 'releaseWork'>,
): ReturnType<typeof bindPowerWorkSignals> {
  return bindPowerWorkSignals(bus as unknown as PowerWorkSignalBus, manager);
}

const ctx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

/** A recording stand-in for PowerManager's hold/release surface. */
function fakeManager() {
  const holds: Array<{ id: string; reason: string }> = [];
  const releases: string[] = [];
  return {
    manager: {
      holdWork: (id: string, reason: string): void => { holds.push({ id, reason }); },
      releaseWork: (id: string): void => { releases.push(id); },
    },
    holds,
    releases,
  };
}

/** RuntimeEventBus.emit() dispatches via queueMicrotask; let those settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('bindPowerWorkSignals over a REAL RuntimeEventBus + REAL envelopes', () => {
  test('a real TURN_SUBMITTED/TURN_COMPLETED pair holds and releases by turnId', async () => {
    const bus = new RuntimeEventBus();
    const { manager, holds, releases } = fakeManager();
    bindOverRealBus(bus, manager);

    emitTurnSubmitted(bus, ctx, { turnId: 't-1', prompt: 'hello' });
    await settle();
    expect(holds).toEqual([{ id: 'turnId:t-1', reason: 'a turn is running' }]);

    emitTurnCompleted(bus, ctx, { turnId: 't-1', response: 'hi', stopReason: 'completed' });
    await settle();
    expect(releases).toEqual(['turnId:t-1']);
  });

  test('a real AGENT_SPAWNING/AGENT_COMPLETED pair holds and releases by agentId', async () => {
    const bus = new RuntimeEventBus();
    const { manager, holds, releases } = fakeManager();
    bindOverRealBus(bus, manager);

    emitAgentSpawning(bus, ctx, { agentId: 'a-9', task: 'do the thing' });
    await settle();
    expect(holds).toEqual([{ id: 'agentId:a-9', reason: 'agent a-9 is active' }]);

    emitAgentCompleted(bus, ctx, { agentId: 'a-9', durationMs: 12 });
    await settle();
    expect(releases).toEqual(['agentId:a-9']);
  });

  test('a real AUTOMATION_RUN_QUEUED/AUTOMATION_RUN_COMPLETED pair holds and releases by runId', async () => {
    const bus = new RuntimeEventBus();
    const { manager, holds, releases } = fakeManager();
    bindOverRealBus(bus, manager);

    emitAutomationRunQueued(bus, ctx, { jobId: 'job-1', runId: 'run-7', scheduledAt: Date.now(), forced: false });
    await settle();
    expect(holds).toEqual([{ id: 'runId:run-7', reason: 'scheduled run run-7 is due' }]);

    emitAutomationRunCompleted(bus, ctx, {
      jobId: 'job-1', runId: 'run-7', startedAt: Date.now(), completedAt: Date.now(), durationMs: 5, outcome: 'success',
    });
    await settle();
    expect(releases).toEqual(['runId:run-7']);
  });

  test('overlapping work refcounts correctly: the inhibitor-equivalent hold list is non-empty until the last piece drains', async () => {
    const bus = new RuntimeEventBus();
    const { manager, holds, releases } = fakeManager();
    bindOverRealBus(bus, manager);

    emitTurnSubmitted(bus, ctx, { turnId: 't-2', prompt: 'x' });
    emitAgentSpawning(bus, ctx, { agentId: 'a-1', task: 'y' });
    await settle();
    expect(holds).toHaveLength(2);

    emitTurnCompleted(bus, ctx, { turnId: 't-2', response: '', stopReason: 'completed' });
    await settle();
    expect(releases).toEqual(['turnId:t-2']);

    emitAgentCompleted(bus, ctx, { agentId: 'a-1', durationMs: 1 });
    await settle();
    expect(releases).toEqual(['turnId:t-2', 'agentId:a-1']);
  });
});
