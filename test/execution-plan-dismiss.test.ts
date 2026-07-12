/**
 * execution-plan-dismiss.test.ts
 *
 * ExecutionPlanManager.dismiss() — the archive verb behind /plan dismiss.
 *
 * Rulings under test:
 *   - No active plan            → { outcome: 'no-active-plan' }, nothing written.
 *   - Proposal/awaiting-approval → archived: retained with status 'dismissed'
 *                                  + dismissedAt/dismissedFrom, active pointer cleared.
 *   - Mid-execution ('active')   → REFUSED: { outcome: 'requires-cancel' }, no mutation.
 *   - Terminal (complete/failed) → archived (record preserved via dismissedFrom).
 *   - Dismiss retains, never deletes: the plan still appears in list().
 *   - A dismissed plan is not resurrected by a later updateItem().
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ExecutionPlanManager, type PlanItem } from '../packages/sdk/src/platform/core/execution-plan.ts';

const roots: string[] = [];
function createTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const items: Array<Omit<PlanItem, 'id' | 'status'>> = [
  { phase: 'Phase 1', description: 'first step' },
  { phase: 'Phase 1', description: 'second step' },
];

describe('ExecutionPlanManager.dismiss', () => {
  test('no active plan → no-op, nothing mutated', () => {
    const manager = new ExecutionPlanManager(createTmpRoot('plan-dismiss-none-'));
    const result = manager.dismiss('session-1');
    expect(result.outcome).toBe('no-active-plan');
    expect(result.plan).toBeUndefined();
    expect(manager.getActive('session-1')).toBeNull();
  });

  test('proposal (draft) is archived, retained with dismissed status + timestamp', () => {
    const root = createTmpRoot('plan-dismiss-draft-');
    const manager = new ExecutionPlanManager(root);
    const plan = manager.create('Proposal plan', items, 'session-1');
    expect(plan.status).toBe('draft');

    const result = manager.dismiss('session-1');
    expect(result.outcome).toBe('dismissed');
    expect(result.plan?.status).toBe('dismissed');
    expect(result.plan?.dismissedFrom).toBe('draft');
    expect(typeof result.plan?.dismissedAt).toBe('string');

    // Active pointer cleared — a later /plan starts fresh.
    expect(manager.getActive('session-1')).toBeNull();

    // Retained on disk, not deleted: reloadable + still in list().
    const reloaded = manager.load(plan.id);
    expect(reloaded?.status).toBe('dismissed');
    expect(reloaded?.dismissedAt).toBe(result.plan?.dismissedAt);
    expect(manager.list().map((p) => p.id)).toContain(plan.id);
  });

  test('mid-execution (active) is refused — requires workstream cancel first', () => {
    const root = createTmpRoot('plan-dismiss-active-');
    const manager = new ExecutionPlanManager(root);
    const plan = manager.create('Running plan', items, 'session-1');
    // Drive an item in_progress so the plan derives status 'active'.
    manager.updateItem(plan.id, plan.items[0]!.id, 'in_progress');
    expect(manager.load(plan.id)?.status).toBe('active');

    const result = manager.dismiss('session-1');
    expect(result.outcome).toBe('requires-cancel');
    expect(result.blockedBy?.id).toBe(plan.id);

    // No mutation: still active, still the active plan.
    const after = manager.load(plan.id);
    expect(after?.status).toBe('active');
    expect(after?.dismissedAt).toBeUndefined();
    expect(manager.getActive('session-1')?.id).toBe(plan.id);
  });

  test('terminal (complete) is archived but its prior status is preserved', () => {
    const root = createTmpRoot('plan-dismiss-complete-');
    const manager = new ExecutionPlanManager(root);
    const plan = manager.create('Finished plan', items, 'session-1');
    for (const item of plan.items) manager.updateItem(plan.id, item.id, 'complete');
    expect(manager.load(plan.id)?.status).toBe('complete');

    const result = manager.dismiss('session-1');
    expect(result.outcome).toBe('dismissed');
    expect(result.plan?.status).toBe('dismissed');
    expect(result.plan?.dismissedFrom).toBe('complete');
    expect(manager.getActive('session-1')).toBeNull();
  });

  test('a dismissed plan is not resurrected by a later updateItem', () => {
    const root = createTmpRoot('plan-dismiss-resurrect-');
    const manager = new ExecutionPlanManager(root);
    const plan = manager.create('Proposal plan', items, 'session-1');
    manager.dismiss('session-1');

    // Editing an item of a dismissed plan persists the item but keeps it dismissed.
    manager.updateItem(plan.id, plan.items[0]!.id, 'complete');
    const reloaded = manager.load(plan.id);
    expect(reloaded?.status).toBe('dismissed');
    expect(reloaded?.items.find((i) => i.id === plan.items[0]!.id)?.status).toBe('complete');
  });

  test('dismiss is scoped to the active session pointer', () => {
    const root = createTmpRoot('plan-dismiss-session-');
    const manager = new ExecutionPlanManager(root);
    manager.create('Session A plan', items, 'session-A');
    // A different session has no active plan of its own.
    expect(manager.dismiss('session-B').outcome).toBe('no-active-plan');
    // The owning session can dismiss.
    expect(manager.dismiss('session-A').outcome).toBe('dismissed');
  });
});
