/**
 * best-of-n-non-leaf.test.ts
 *
 * Non-leaf best-of-N: an item with attempts:N that OTHER items depend on. The
 * source id is rewritten into sibling ids at expansion, so a dependent's
 * dependsOn no longer names a live item; the dependency gate resolves it back to
 * the group and holds the dependent until the group's winner is picked AND
 * merged (the losing attempts cleaned first). All attempts failing is a
 * recoverable 'failed' block, mirroring a failed ordinary dependency.
 */
import { describe, expect, test } from 'bun:test';
import {
  createAttemptsCoordinator,
  emptyWorkItemUsage,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
} from '../packages/sdk/src/platform/orchestration/index.js';
import { dependencyStatus } from '../packages/sdk/src/platform/orchestration/scheduler.js';

function makeItem(spec: WorkItemSpec): WorkItem {
  return {
    id: spec.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    title: spec.title,
    task: spec.task,
    dependsOn: spec.dependsOn ? [...spec.dependsOn] : [],
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

function setup(): { ws: Workstream; groupId: string; dependent: WorkItem; siblings: WorkItem[]; coordinator: ReturnType<typeof createAttemptsCoordinator> } {
  const events: OrchestrationEvent[] = [];
  const ws: Workstream = { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items: [], isolation: 'worktree', createdAt: 0 };
  const coordinator = createAttemptsCoordinator({
    emit: (e) => events.push(e),
    getWorkstream: (id) => (id === ws.id ? ws : null),
    enqueueIntegration: () => {},
    cleanupWorktree: async () => {},
    diffItem: async () => null,
  });
  // X is a best-of-N item (2 attempts) that D depends on.
  const specs: WorkItemSpec[] = [
    { id: 'X', title: 'build feature', task: 'do X', attempts: 2 },
    { id: 'D', title: 'ship feature', task: 'do D', dependsOn: ['X'] },
  ];
  ws.items = coordinator.expandItems(ws.id, ws.isolation, specs, makeItem);
  const siblings = ws.items.filter((i) => i.attemptSourceId === 'X');
  const dependent = ws.items.find((i) => i.id === 'D')!;
  const groupId = siblings[0]!.attemptGroupId!;
  return { ws, groupId, dependent, siblings, coordinator };
}

describe('non-leaf best-of-N expansion', () => {
  test('expands the source into siblings carrying attemptSourceId; the dependent survives', () => {
    const { ws, siblings, dependent } = setup();
    expect(siblings).toHaveLength(2);
    expect(siblings.every((s) => s.attemptSourceId === 'X')).toBe(true);
    // The original id "X" no longer names a live item — it was rewritten.
    expect(ws.items.find((i) => i.id === 'X')).toBeUndefined();
    expect(dependent.dependsOn).toEqual(['X']);
  });
});

describe('dependent gates on the group winner', () => {
  test('waits while attempts are running or held (no winner yet)', () => {
    const { ws, dependent, siblings } = setup();
    expect(dependencyStatus(ws, dependent).ready).toBe(false);
    for (const s of siblings) s.state = 'held-merge';
    const status = dependencyStatus(ws, dependent);
    expect(status.ready).toBe(false);
    expect(status.waiting[0]).toContain('build feature');
  });

  test('still waits when the winner is picked but its merge has not landed', async () => {
    const { ws, dependent, siblings, coordinator, groupId } = setup();
    for (const s of siblings) s.state = 'held-merge';
    await coordinator.pickWinner(groupId, siblings[0]!.id);
    expect(siblings[0]!.attemptWinner).toBe(true);
    expect(siblings[0]!.state).toBe('passed');
    // Winner not merged yet → dependent still blocked.
    expect(dependencyStatus(ws, dependent).ready).toBe(false);
  });

  test('is satisfied once the winner is merged onto base', async () => {
    const { ws, dependent, siblings, coordinator, groupId } = setup();
    for (const s of siblings) s.state = 'held-merge';
    await coordinator.pickWinner(groupId, siblings[0]!.id);
    siblings[0]!.mergeState = 'merged';
    const status = dependencyStatus(ws, dependent);
    expect(status.ready).toBe(true);
    expect(status.waiting).toEqual([]);
    expect(status.failed).toEqual([]);
  });

  test('is a recoverable failed-block when every attempt failed (no winner possible)', () => {
    const { ws, dependent, siblings } = setup();
    for (const s of siblings) s.state = 'failed';
    const status = dependencyStatus(ws, dependent);
    expect(status.ready).toBe(false);
    expect(status.failed[0]).toContain('build feature');
  });
});
