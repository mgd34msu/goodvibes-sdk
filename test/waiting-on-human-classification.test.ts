/**
 * waiting-on-human-classification.test.ts
 *
 * ONE waiting-on-human state class: an approval ask, a READY best-of-N pick,
 * and a merge conflict all classify as first-class attention in the fleet
 * snapshot, all fan out as FLEET_NODE_BLOCKED_ON_USER on the wire (via the
 * emit-bridge), and all push through the same needs-input source — so every
 * surface inherits glyph, count, jump key, and push from the classification.
 */
import { describe, expect, test } from 'bun:test';
import {
  adaptWorkItem,
  adaptWorkstream,
  readyAttemptGroupIds,
} from '../packages/sdk/src/platform/runtime/fleet/adapters/orchestration.ts';
import { deriveNeedsAttention } from '../packages/sdk/src/platform/runtime/fleet/adapters/agent.ts';
import { attachFleetEmitBridge } from '../packages/sdk/src/platform/runtime/fleet/emit-bridge.ts';
import type { FleetSnapshot, ProcessNode } from '../packages/sdk/src/platform/runtime/fleet/types.ts';
import { PushService } from '../packages/sdk/src/platform/push/index.ts';
import type { FleetNotice, PushMessage, PushSubscriptionStore, VapidManager } from '../packages/sdk/src/platform/push/index.ts';
import type { Phase, WorkItem, Workstream } from '../packages/sdk/src/platform/orchestration/types.ts';
import { emptyWorkItemUsage } from '../packages/sdk/src/platform/orchestration/types.ts';
import type { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { EventEmitter } from 'node:events';

const T0 = 1_750_000_000_000;

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: 'item', task: 'do work', currentPhaseId: null, state: 'pending',
    allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(),
    transportRetryCount: 0, createdAt: T0, ...overrides,
  };
}

function makeWorkstream(overrides: Partial<Workstream> & { id: string }): Workstream {
  return { title: 'ws', schemaVersion: 1, phases: [] as Phase[], items: [], createdAt: T0, ...overrides };
}

describe('snapshot classification — all three reasons are first-class', () => {
  test('approval: awaiting-approval derives the approval attention (unchanged)', () => {
    expect(deriveNeedsAttention('awaiting-approval')).toEqual({ reason: 'approval' });
  });

  test('a READY best-of-N group flags the workstream with reason "pick" and marks members ready', () => {
    const held1 = makeItem({ id: 'a#a0', state: 'held-merge', attemptGroupId: 'g1', attemptIndex: 0, attemptTotal: 2 });
    const failed = makeItem({ id: 'a#a1', state: 'failed', attemptGroupId: 'g1', attemptIndex: 1, attemptTotal: 2 });
    const ws = makeWorkstream({ id: 'ws1', items: [held1, failed] });

    const ready = readyAttemptGroupIds(ws);
    expect([...ready]).toEqual(['g1']);

    const wsNode = adaptWorkstream(ws, T0);
    expect(wsNode.needsAttention).toMatchObject({ reason: 'pick' });
    // Not 'done': the pick is parked on a human.
    expect(wsNode.state).toBe('paused');

    const memberNode = adaptWorkItem(held1, 'ws1', 'workstream:ws1', { steerable: false, readyGroups: ready });
    expect(memberNode.attemptGroup).toMatchObject({ groupId: 'g1', held: true, ready: true });
  });

  test('a group with an attempt still running is NOT ready and does not flag', () => {
    const held = makeItem({ id: 'b#a0', state: 'held-merge', attemptGroupId: 'g2', attemptIndex: 0, attemptTotal: 2 });
    const running = makeItem({ id: 'b#a1', state: 'in-phase', attemptGroupId: 'g2', attemptIndex: 1, attemptTotal: 2 });
    const ws = makeWorkstream({ id: 'ws2', items: [held, running] });
    expect(readyAttemptGroupIds(ws).size).toBe(0);
    expect(adaptWorkstream(ws, T0).needsAttention).toBeUndefined();
  });

  test('a merge conflict flags the item with reason "conflict" and an honest non-done state', () => {
    const conflicted = makeItem({
      id: 'c1', state: 'passed', mergeState: 'conflict', worktreeKept: true,
      worktreePath: '/tmp/kept', conflictFiles: ['src/a.ts', 'src/b.ts'],
      blockedReason: 'merge-conflict: src/a.ts, src/b.ts',
    });
    const node = adaptWorkItem(conflicted, 'ws1', 'workstream:ws1', { steerable: false });
    expect(node.needsAttention).toMatchObject({ reason: 'conflict' });
    expect(node.needsAttention?.detail).toContain('src/a.ts');
    expect(node.state).toBe('stalled'); // NOT 'done' — the work has not landed.

    const ws = makeWorkstream({ id: 'ws3', items: [conflicted] });
    expect(adaptWorkstream(ws, T0).state).toBe('stalled');
  });
});

describe('wire events — all three reasons emit FLEET_NODE_BLOCKED_ON_USER', () => {
  function nodeWith(id: string, reason: 'approval' | 'input' | 'pick' | 'conflict' | undefined, state: ProcessNode['state']): ProcessNode {
    return {
      id, kind: 'work-item', label: id, state, elapsedMs: 0, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
      ...(reason ? { needsAttention: { reason } } : {}),
    } as ProcessNode;
  }

  test('approval, pick, and conflict all cross the wire with their own reason', () => {
    let listener: ((s: FleetSnapshot) => void) | null = null;
    const registry = { subscribe: (l: (s: FleetSnapshot) => void) => { listener = l; return () => {}; } };
    const ee = new EventEmitter();
    const events: Array<{ type: string; reason?: string; nodeId?: string }> = [];
    ee.on('fleet', (envelope: { payload: { type: string; reason?: string; nodeId?: string } }) => events.push(envelope.payload));
    const bus = { emit: ee.emit.bind(ee) } as unknown as RuntimeEventBus;
    attachFleetEmitBridge({ registry, bus, traceId: () => 't' });

    // Seed with no attention…
    listener!({ capturedAt: T0, nodes: [nodeWith('n-appr', undefined, 'thinking'), nodeWith('n-pick', undefined, 'paused'), nodeWith('n-conf', undefined, 'executing-tool')] });
    // …then all three become waiting-on-human.
    listener!({ capturedAt: T0 + 1, nodes: [nodeWith('n-appr', 'approval', 'awaiting-approval'), nodeWith('n-pick', 'pick', 'paused'), nodeWith('n-conf', 'conflict', 'stalled')] });

    const blocked = events.filter((e) => e.type === 'FLEET_NODE_BLOCKED_ON_USER');
    expect(blocked.map((e) => [e.nodeId, e.reason]).sort()).toEqual([
      ['n-appr', 'approval'], ['n-conf', 'conflict'], ['n-pick', 'pick'],
    ]);
  });
});

describe('push — a ready pick and a conflict both push through the needs-input source', () => {
  function makeService(): { service: PushService; delivered: PushMessage[] } {
    const service = new PushService({ vapid: {} as VapidManager, store: {} as PushSubscriptionStore });
    const delivered: PushMessage[] = [];
    (service as unknown as { deliver: (m: PushMessage) => Promise<unknown[]> }).deliver = async (m) => { delivered.push(m); return []; };
    return { service, delivered };
  }

  test('pick and conflict notices fan out as pushes with honest wording', async () => {
    const { service, delivered } = makeService();
    let listener: ((n: FleetNotice) => void) | null = null;
    service.attachFleetNeedsInputSource({ subscribe: (l) => { listener = l; return () => {}; } });

    listener!({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'ws-node', label: 'checkout flow', reason: 'pick', sessionId: 's1' });
    listener!({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'item-node', label: 'payment refactor', reason: 'conflict', sessionId: 's1' });
    await Promise.resolve();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.body).toBe('checkout flow has a best-of-N pick ready for you.');
    expect(delivered[1]?.body).toBe('payment refactor has a merge conflict waiting on you.');
    expect(delivered.every((m) => m.urgency === 'high')).toBe(true);
  });
});
