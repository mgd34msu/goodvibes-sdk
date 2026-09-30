/**
 * A failed fix cycle releases its remaining fix tasks (live-run 8, defect 5):
 * when one fix task is orphaned the chain fails, and its sibling fix tasks
 * must not keep running or merging for a chain that already failed. The runner
 * stops them through the engine and names them in the failure reason, and a
 * chain that fails or is cancelled mid-cycle can stop its cycle the same way.
 */
import { describe, expect, test } from 'bun:test';
import { createFixWorkstreamRunner, type FixWorkstreamEngine } from '../packages/sdk/src/platform/orchestration/fix-workstream-runner.js';
import type { OrchestrationEvent, Workstream } from '../packages/sdk/src/platform/orchestration/types.js';

const REVIEW = {
  version: 1, archetype: 'reviewer', summary: 'three problems', score: 3, passed: false, dimensions: [],
  issues: [
    { severity: 'major', description: 'src/a.ts: the delay is never capped.', pointValue: 2 },
    { severity: 'major', description: 'src/b.ts: jitter is applied twice.', pointValue: 2 },
    { severity: 'major', description: 'src/c.ts: the last attempt still sleeps.', pointValue: 2 },
  ],
} as never;

function fakeEngine() {
  const listeners = new Set<(event: OrchestrationEvent) => void>();
  const kills: Array<{ itemId: string; reason: string | undefined }> = [];
  let workstream: Workstream | null = null;
  const engine: Required<FixWorkstreamEngine> = {
    createWorkstream: (input) => {
      workstream = {
        id: 'ws-fix-1', title: input.title, phases: [], createdAt: 0,
        items: input.items.map((spec, index) => ({ id: `item-${index}`, title: spec.title, state: 'pending', touchedPaths: [] })),
      } as unknown as Workstream;
      return workstream;
    },
    start: () => {
      // Every task is picked up by the fleet.
      for (const item of workstream!.items) (item as { state: string }).state = 'in-phase';
    },
    getWorkstream: () => workstream,
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    kill: (itemId, reason) => {
      const item = workstream!.items.find((candidate) => candidate.id === itemId)!;
      if (item.state === 'passed' || item.state === 'failed') return false;
      (item as { state: string }).state = 'failed';
      kills.push({ itemId, reason });
      return true;
    },
  };
  const emit = (event: OrchestrationEvent): void => { for (const listener of listeners) listener(event); };
  return { engine, kills, emit, items: () => workstream!.items };
}

describe('fix workstream runner stops the remaining fix tasks of a failed cycle', () => {
  test('an orphaned fix task fails the cycle and its still-running siblings are stopped and named', async () => {
    const fake = fakeEngine();
    const runner = createFixWorkstreamRunner({ engine: fake.engine });
    const pending = runner.run({ chainId: 'wrfc-orphan', originalTask: 'cap the delay', review: REVIEW, attempt: 1, commitScope: 'scoped' });
    const [first, second, third] = fake.items();
    expect(fake.items().length).toBeGreaterThanOrEqual(3);
    // The first task hard-fails; the third is orphaned behind it; the second is still running.
    (first as { state: string }).state = 'failed';
    fake.emit({ type: 'item-orphaned', workstreamId: 'ws-fix-1', itemId: third!.id, blockerItemId: first!.id, reason: `blocked by failed task ${first!.title}` });

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.structured).toBe('orphaned');
    expect(fake.kills.map((kill) => kill.itemId)).toEqual([second!.id, third!.id]);
    expect(fake.kills.every((kill) => kill.reason === 'stopped because the fix cycle failed (orphaned)')).toBe(true);
    expect(outcome.reason).toContain(`stopped 2 remaining fix tasks: ${second!.title}, ${third!.title}`);
    expect(fake.items().some((item) => item.state === 'in-phase' || item.state === 'pending')).toBe(false);
  });

  test('stop(chainId) stops a running cycle, releases its tasks, and settles it failed', async () => {
    const fake = fakeEngine();
    const runner = createFixWorkstreamRunner({ engine: fake.engine });
    const pending = runner.run({ chainId: 'wrfc-stop', originalTask: 'cap the delay', review: REVIEW, attempt: 1, commitScope: 'scoped' });
    expect(runner.stop?.('wrfc-other', 'x')).toBe(0);
    const stopped = runner.stop?.('wrfc-stop', 'stopped because the chain failed');
    expect(stopped).toBe(fake.items().length);
    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toBe(`stopped because the chain failed; stopped ${fake.items().length} fix tasks`);
    expect(runner.stop?.('wrfc-stop', 'again')).toBe(0);
  });

  test('the fix workstream is rooted where the chain says (its isolated worktree)', async () => {
    const fake = fakeEngine();
    let rootDir: string | undefined;
    const engine = { ...fake.engine, createWorkstream: (input: Parameters<FixWorkstreamEngine['createWorkstream']>[0]) => { rootDir = input.rootDir; return fake.engine.createWorkstream(input); } };
    const runner = createFixWorkstreamRunner({ engine });
    void runner.run({ chainId: 'wrfc-root', originalTask: 'x', review: REVIEW, attempt: 1, commitScope: 'scoped', rootDir: '/repo/.goodvibes/.worktrees/wrfc/abc' });
    expect(rootDir).toBe('/repo/.goodvibes/.worktrees/wrfc/abc');
    runner.stop?.('wrfc-root', 'done');
  });
});
