/**
 * Best-of-N sibling attempts (platform/orchestration/attempts.ts).
 *
 * Covers expansion into N siblings (worktree only), the held-merge park instead
 * of auto-merge, group readiness, the winner pick (winner merges, losers are
 * cleaned), the model judge proposal + auto-accept, and the per-item budget
 * ceiling. Drives the coordinator directly with fakes — no git, no agents.
 */
import { describe, expect, test } from 'bun:test';
import {
  createAttemptsCoordinator,
  AttemptError,
  emptyWorkItemUsage,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
} from '../packages/sdk/src/platform/orchestration/index.js';
import { checkBudget } from '../packages/sdk/src/platform/orchestration/budget.js';
import { parseAttemptVerdict } from '../packages/sdk/src/platform/orchestration/judge.js';

function makeItem(spec: WorkItemSpec): WorkItem {
  return {
    id: spec.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    title: spec.title,
    task: spec.task,
    dependsOn: [],
    currentPhaseId: 'phase-1',
    state: 'pending',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: 0,
  };
}

function makeWorkstream(items: WorkItem[], isolation: 'worktree' | 'shared' = 'worktree'): Workstream {
  return { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items, isolation, createdAt: 0 };
}

interface Harness {
  events: OrchestrationEvent[];
  enqueued: string[];
  cleaned: string[];
  coordinator: ReturnType<typeof createAttemptsCoordinator>;
}

function harness(judge?: Parameters<typeof createAttemptsCoordinator>[0]['judge'], ws?: () => Workstream | null): Harness {
  const events: OrchestrationEvent[] = [];
  const enqueued: string[] = [];
  const cleaned: string[] = [];
  const coordinator = createAttemptsCoordinator({
    emit: (e) => events.push(e),
    getWorkstream: ws ?? (() => null),
    enqueueIntegration: (_w, item) => { enqueued.push(item.id); },
    cleanupWorktree: async (_w, item) => { cleaned.push(item.id); },
    diffItem: async (item) => ({ files: [`${item.id}.ts`], unifiedDiff: `diff for ${item.id}`, stat: '1 file' }),
    ...(judge ? { judge } : {}),
  });
  return { events, enqueued, cleaned, coordinator };
}

describe('expandItems', () => {
  test('expands attempts:3 into 3 grouped siblings under worktree isolation', () => {
    const h = harness();
    const items = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'do it', attempts: 3 }], makeItem);
    expect(items).toHaveLength(3);
    const groupIds = new Set(items.map((i) => i.attemptGroupId));
    expect(groupIds.size).toBe(1);
    expect(items.map((i) => i.attemptIndex)).toEqual([0, 1, 2]);
    expect(items.every((i) => i.attemptTotal === 3)).toBe(true);
    const spawned = h.events.find((e) => e.type === 'item-attempts-spawned');
    expect(spawned?.type).toBe('item-attempts-spawned');
  });

  test('ignores attempts under shared isolation (single item)', () => {
    const h = harness();
    const items = h.coordinator.expandItems('ws-1', 'shared', [{ title: 'T', task: 'x', attempts: 3 }], makeItem);
    expect(items).toHaveLength(1);
    expect(items[0]!.attemptGroupId).toBeUndefined();
  });

  test('clamps attempts above the cap and passes single items through', () => {
    const h = harness();
    const many = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 99 }], makeItem);
    expect(many.length).toBeLessThanOrEqual(5);
    const single = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'S', task: 'x' }], makeItem);
    expect(single).toHaveLength(1);
    expect(single[0]!.attemptGroupId).toBeUndefined();
  });
});

describe('hold-vs-merge and readiness', () => {
  test('a non-attempt passed item enqueues integration; an attempt is held', () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    const plain = makeItem({ title: 'P', task: 'y' });
    ws = makeWorkstream([...siblings, plain]);

    h.coordinator.onItemPassedTerminal(ws, plain);
    expect(h.enqueued).toEqual([plain.id]);

    h.coordinator.onItemPassedTerminal(ws, siblings[0]!);
    expect(siblings[0]!.state).toBe('held-merge');
    expect(h.events.some((e) => e.type === 'item-attempt-held')).toBe(true);
    // Not ready yet — sibling 1 is still pending.
    expect(h.events.some((e) => e.type === 'attempts-ready')).toBe(false);

    h.coordinator.onItemPassedTerminal(ws, siblings[1]!);
    const ready = h.events.find((e) => e.type === 'attempts-ready');
    expect(ready?.type).toBe('attempts-ready');
  });

  test('a failed sibling still counts toward readiness', () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    h.coordinator.onItemPassedTerminal(ws, siblings[0]!);
    siblings[1]!.state = 'failed';
    h.coordinator.onItemFailedTerminal(ws, siblings[1]!);
    expect(h.events.some((e) => e.type === 'attempts-ready')).toBe(true);
  });
});

describe('pickWinner', () => {
  async function readyGroup(): Promise<{ h: Harness; ws: Workstream; groupId: string; siblings: WorkItem[] }> {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 3 }], makeItem);
    for (const s of siblings) { s.worktreePath = `/wt/${s.id}`; s.worktreeBranch = `ws/1/${s.id}`; }
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    const groupId = siblings[0]!.attemptGroupId!;
    return { h, ws, groupId, siblings };
  }

  test('merges the winner and cleans the losers, removing the group', async () => {
    const { h, groupId, siblings } = await readyGroup();
    const winner = siblings[1]!;
    const result = await h.coordinator.pickWinner(groupId, winner.id);
    expect(result.winnerItemId).toBe(winner.id);
    expect(result.auto).toBe(false);
    expect(h.enqueued).toEqual([winner.id]);
    expect(h.cleaned.sort()).toEqual([siblings[0]!.id, siblings[2]!.id].sort());
    expect(winner.state).toBe('passed');
    expect(h.events.some((e) => e.type === 'attempt-winner-picked')).toBe(true);
    // Group is resolved — a second pick is an honest error.
    await expect(h.coordinator.pickWinner(groupId, winner.id)).rejects.toBeInstanceOf(AttemptError);
  });

  test('rejects an invalid winner and a not-ready group', async () => {
    const { h, groupId } = await readyGroup();
    await expect(h.coordinator.pickWinner(groupId, 'nonexistent')).rejects.toBeInstanceOf(AttemptError);
    await expect(h.coordinator.pickWinner('bogus-group', 'x')).rejects.toBeInstanceOf(AttemptError);
  });

  test('listGroups exposes candidates with their diffs', async () => {
    const { h } = await readyGroup();
    const groups = await h.coordinator.listGroups('ws-1');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ready).toBe(true);
    expect(groups[0]!.candidates).toHaveLength(3);
    expect(groups[0]!.candidates[0]!.diff?.unifiedDiff).toContain('diff for');
  });
});

describe('judge', () => {
  test('proposeWinner stamps a model judgment and emits a proposal', async () => {
    let ws!: Workstream;
    const judge = async () => ({ winnerItemId: ws.items[0]!.id, reasons: ['clearest diff'], model: 'test-model' });
    const h = harness(judge, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    const judgment = await h.coordinator.proposeWinner(siblings[0]!.attemptGroupId!);
    expect(judgment.scoredBy).toBe('model');
    expect(judgment.proposedWinnerItemId).toBe(siblings[0]!.id);
    expect(judgment.reasons).toContain('clearest diff');
    expect(h.events.some((e) => e.type === 'attempt-judge-proposed')).toBe(true);
  });

  test('proposeWinner without a judge is an honest error', async () => {
    let ws!: Workstream;
    const h = harness(undefined, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2 }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    await expect(h.coordinator.proposeWinner(siblings[0]!.attemptGroupId!)).rejects.toBeInstanceOf(AttemptError);
  });

  test('auto-accept picks the judge-proposed winner once the group is ready', async () => {
    let ws!: Workstream;
    const judge = async () => ({ winnerItemId: ws.items[1]!.id, reasons: ['best'] });
    const h = harness(judge, () => ws);
    const siblings = h.coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: 2, autoAcceptWinner: true }], makeItem);
    ws = makeWorkstream(siblings);
    for (const s of siblings) h.coordinator.onItemPassedTerminal(ws, s);
    // Auto judge-and-pick runs async off the readiness event; let microtasks flush.
    await new Promise((r) => setTimeout(r, 0));
    const picked = h.events.find((e) => e.type === 'attempt-winner-picked');
    expect(picked?.type).toBe('attempt-winner-picked');
    if (picked?.type === 'attempt-winner-picked') expect(picked.auto).toBe(true);
    expect(h.enqueued).toEqual([siblings[1]!.id]);
  });
});

describe('per-item budget', () => {
  test('refuses a claim once the item reaches its own token ceiling', () => {
    const item = makeItem({ title: 'T', task: 'x' });
    item.itemBudget = { maxTokens: 100 };
    item.usage = { ...emptyWorkItemUsage(), inputTokens: 80, outputTokens: 40 };
    const ws = makeWorkstream([item]);
    const check = checkBudget(ws, item);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('item token usage');
  });

  test('allows a claim under the item ceiling', () => {
    const item = makeItem({ title: 'T', task: 'x' });
    item.itemBudget = { maxTokens: 1000 };
    item.usage = { ...emptyWorkItemUsage(), inputTokens: 10, outputTokens: 10 };
    expect(checkBudget(makeWorkstream([item]), item).allowed).toBe(true);
  });
});

describe('parseAttemptVerdict', () => {
  const input = { task: 't', candidates: [{ itemId: 'a', attemptIndex: 0, state: 'held-merge' as const, diff: null, usage: emptyWorkItemUsage() }] };
  test('keeps only a winnerItemId that is a real candidate', () => {
    const ok = parseAttemptVerdict('{"winnerItemId":"a","reasons":["r"]}', input, 'm');
    expect(ok.winnerItemId).toBe('a');
    const bogus = parseAttemptVerdict('{"winnerItemId":"zzz","reasons":[]}', input, 'm');
    expect(bogus.winnerItemId).toBeNull();
  });
  test('malformed output proposes no winner with an honest reason', () => {
    const v = parseAttemptVerdict('not json', input, null);
    expect(v.winnerItemId).toBeNull();
    expect(v.reasons[0]).toContain('could not be parsed');
  });
});
