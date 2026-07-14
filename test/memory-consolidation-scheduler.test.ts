/**
 * memory-consolidation-scheduler.test.ts — consolidation actually runs.
 *
 * The engine (state/memory-consolidation.ts) was complete but had no production
 * wiring in this runtime. The daemon — the memory store's single writer — now
 * drives it through MemoryConsolidationScheduler on the engine's own triggers:
 * idle (preferred) and the slow schedule fallback. Mechanical outcomes just
 * happen with the engine's receipts; judgment outcomes stay proposals; nothing
 * is ever deleted without review. `learning.consolidation.enabled: false`
 * remains the off switch (now default-ON so the pass genuinely runs).
 */
import { describe, expect, test } from 'bun:test';
import { MemoryConsolidationScheduler } from '../packages/sdk/src/platform/state/memory-consolidation-scheduler.ts';
import type {
  MemoryConsolidationRegistry,
  MemoryRecord,
  MemoryReviewPatch,
} from '../packages/sdk/src/platform/state/index.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    scope: 'project',
    cls: 'fact',
    summary: 'a fact',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    ...overrides,
  };
}

class FakeRegistry implements MemoryConsolidationRegistry {
  public readonly records = new Map<string, MemoryRecord>();
  public deleteAttempts = 0;
  constructor(records: readonly MemoryRecord[]) {
    for (const r of records) this.records.set(r.id, r);
  }
  getAll(): readonly MemoryRecord[] {
    return [...this.records.values()];
  }
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: MemoryRecord = {
      ...existing,
      reviewState: patch.state ?? existing.reviewState,
      confidence: patch.confidence ?? existing.confidence,
    };
    this.records.set(id, updated);
    return updated;
  }
  update(id: string, patch: { tags?: string[] }): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...(patch.tags ? { tags: patch.tags } : {}) };
    this.records.set(id, updated);
    return updated;
  }
}

/** Config source shaped like ConfigManager.getRaw (enabled defaults true). */
function configSource(block: Record<string, unknown> = {}): { getRaw(): unknown } {
  return { getRaw: () => ({ learning: { consolidation: { enabled: true, ...block } } }) };
}

function makeScheduler(input: {
  registry: FakeRegistry;
  idle: boolean;
  now?: () => number;
  config?: Record<string, unknown>;
}) {
  let idle = input.idle;
  const receipts: unknown[] = [];
  const scheduler = new MemoryConsolidationScheduler({
    memoryRegistry: input.registry,
    configSource: configSource(input.config ?? {}),
    isIdle: () => idle,
    now: input.now ?? (() => NOW),
    // Timers never fire in tests — ticks are driven manually.
    setTimer: () => setTimeout(() => {}, 1_000_000),
    onReceipt: (receipt) => receipts.push(receipt),
  });
  return { scheduler, receipts, setIdle: (value: boolean) => { idle = value; } };
}

describe('memory consolidation scheduler — the daemon runs the engine', () => {
  test('the idle trigger runs consolidation with receipts (mechanical outcomes just happen)', () => {
    const dupA = rec({ id: 'surv', reviewState: 'reviewed', confidence: 80, updatedAt: NOW - 1000, summary: 'CI note', tags: ['ci'] });
    const dupB = rec({ id: 'lose', reviewState: 'fresh', confidence: 50, updatedAt: NOW - 2000, summary: 'CI note', tags: ['deploy'] });
    const registry = new FakeRegistry([dupA, dupB]);
    const { scheduler, receipts } = makeScheduler({ registry, idle: true });

    scheduler.tick();
    scheduler.stop();

    // One idle-triggered run, receipted.
    expect(receipts.length).toBe(1);
    const receipt = scheduler.listReceipts()[0]!;
    expect(receipt.trigger).toBe('idle');
    expect(receipt.idle).toBe(true);
    expect(receipt.merged.length).toBe(1);
    // Mechanical outcome happened: the loser is stale, NOT deleted.
    expect(registry.records.get('lose')!.reviewState).toBe('stale');
    expect(registry.records.size).toBe(2);
  });

  test('judgment outcomes land as proposals — never applied', () => {
    // Same summary, conflicting detail, no clearly-newer verified winner:
    // the engine must propose, not resolve.
    const one = rec({ id: 'c1', reviewState: 'fresh', confidence: 60, updatedAt: NOW - 1000, summary: 'conflicting fact', detail: 'version A' });
    const two = rec({ id: 'c2', reviewState: 'reviewed', confidence: 60, updatedAt: NOW - 2000, summary: 'conflicting fact', detail: 'version B entirely different' });
    const registry = new FakeRegistry([one, two]);
    const { scheduler } = makeScheduler({ registry, idle: true });

    scheduler.tick();
    scheduler.stop();

    const receipt = scheduler.listReceipts()[0]!;
    const contradiction = receipt.proposed.find((p) => p.kind === 'contradiction');
    expect(contradiction).toBeDefined();
    // Proposals route to the confirmation-gated memory path.
    expect(contradiction!.route).toContain('memory action:');
    // Neither record was force-resolved (both still present, both active).
    expect(registry.records.get('c1')!.reviewState).not.toBe('stale');
  });

  test('deletion never happens without review — stale-delete is only ever proposed', () => {
    const longStale = rec({ id: 'old-stale', reviewState: 'stale', updatedAt: NOW - 120 * DAY });
    const registry = new FakeRegistry([longStale]);
    const { scheduler } = makeScheduler({ registry, idle: true });

    scheduler.tick();
    scheduler.stop();

    const receipt = scheduler.listReceipts()[0]!;
    const staleDelete = receipt.proposed.find((p) => p.kind === 'stale-delete');
    expect(staleDelete).toBeDefined();
    expect(staleDelete!.route).toContain('action:"delete"');
    // The record is STILL THERE: proposals never delete.
    expect(registry.records.has('old-stale')).toBe(true);
    expect(receipt.note).toContain('never written silently');
  });

  test('a busy runtime skips the idle trigger but the slow schedule fallback still runs', () => {
    const registry = new FakeRegistry([rec()]);
    let clock = NOW;
    const { scheduler, receipts } = makeScheduler({ registry, idle: false, now: () => clock });

    // Never idle, but not yet past the slow-schedule window: no run.
    scheduler.tick();
    expect(receipts.length).toBe(0);

    // Past SCHEDULE_FACTOR x intervalMs (4 x 6h = 24h) with no idle window:
    // the schedule trigger fires so a busy host cannot starve the pass.
    clock = NOW + 25 * HOUR;
    scheduler.tick();
    scheduler.stop();
    expect(receipts.length).toBe(1);
    expect(scheduler.listReceipts()[0]!.trigger).toBe('schedule');
    expect(scheduler.listReceipts()[0]!.idle).toBe(false);
  });

  test('enabled:false is the off switch — nothing runs', () => {
    const registry = new FakeRegistry([rec()]);
    const receipts: unknown[] = [];
    const scheduler = new MemoryConsolidationScheduler({
      memoryRegistry: registry,
      configSource: { getRaw: () => ({ learning: { consolidation: { enabled: false } } }) },
      isIdle: () => true,
      now: () => NOW,
      setTimer: () => setTimeout(() => {}, 1_000_000),
      onReceipt: (r) => receipts.push(r),
    });
    scheduler.tick();
    scheduler.stop();
    expect(receipts.length).toBe(0);
    expect(scheduler.listReceipts().length).toBe(0);
  });

  test('minIdleMs requires CONTINUOUS idleness before the idle trigger fires', () => {
    const registry = new FakeRegistry([rec()]);
    let clock = NOW;
    const { scheduler, receipts, setIdle } = makeScheduler({
      registry,
      idle: true,
      now: () => clock,
      config: { minIdleMs: 10 * 60 * 1000 },
    });

    // First idle observation starts the continuous-idle window — not enough yet.
    scheduler.tick();
    expect(receipts.length).toBe(0);
    // Activity resets the window.
    clock += 9 * 60 * 1000;
    setIdle(false);
    scheduler.tick();
    setIdle(true);
    clock += 5 * 60 * 1000;
    scheduler.tick();
    expect(receipts.length).toBe(0); // only 0ms..5m of continuous idle since reset
    // Continuous idleness past minIdleMs: runs.
    clock += 11 * 60 * 1000;
    scheduler.tick();
    scheduler.stop();
    expect(receipts.length).toBe(1);
  });
});
