/**
 * knowledge-self-improve-scheduling.test.ts
 *
 * Guards for the governed background self-improvement scheduler: the minimum
 * floor (asserted at PRODUCTION defaults via injected clock/schedule seams —
 * never by overriding the floor down), burst coalescing per scope, the
 * distinct-scope cardinality bound (the incident's ~1,400-distinct-source burst
 * shape collapses into ONE global sweep), zero-gap backoff with new-gap
 * evidence clearing it and coalescing preserving later triggers' gapIds, the
 * governor pause being rechecked at fire time (a queued timer never runs a full
 * self-improve mid-pressure), and state-map eviction.
 */
import { describe, expect, test } from 'bun:test';
import { KnowledgeSemanticService } from '../packages/sdk/src/platform/knowledge/index.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from '../packages/sdk/src/platform/knowledge/semantic/types.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

const gapRepairer = {} as unknown as KnowledgeSemanticGapRepairer;

interface ScheduledTimer { cb: () => void; at: number }

/** Deterministic harness: fake clock + captured timers + counted runs. */
function harness(opts: {
  minDelayMs?: number | undefined;
  zeroGapBackoffMs?: number | undefined;
  candidateGaps?: number | ((input: KnowledgeSemanticSelfImproveInput) => number) | undefined;
  paused?: (() => boolean) | undefined;
  admit?: ((label: string) => { allowed: boolean; reason?: string }) | undefined;
} = {}) {
  const { store } = createStores();
  let clock = 0;
  const timers: ScheduledTimer[] = [];
  const runs: KnowledgeSemanticSelfImproveInput[] = [];
  const svc = new KnowledgeSemanticService(store, {
    gapRepairer,
    ...(opts.minDelayMs !== undefined ? { backgroundSelfImproveMinDelayMs: opts.minDelayMs } : {}),
    ...(opts.zeroGapBackoffMs !== undefined ? { backgroundSelfImproveZeroGapBackoffMs: opts.zeroGapBackoffMs } : {}),
    isBackgroundPaused: opts.paused,
    admitExpensiveWork: opts.admit,
    now: () => clock,
    scheduleSeam: (cb, delayMs) => { timers.push({ cb, at: clock + delayMs }); },
  });
  const internal = svc as unknown as {
    selfImprove(input: KnowledgeSemanticSelfImproveInput, runOptions?: unknown): Promise<KnowledgeSemanticSelfImproveResult>;
    backgroundScheduler: { state: Map<string, { pending: boolean; zeroGapUntil: number; pendingInput?: KnowledgeSemanticSelfImproveInput }> };
  };
  internal.selfImprove = async (input) => {
    runs.push(input);
    const gaps = typeof opts.candidateGaps === 'function' ? opts.candidateGaps(input) : (opts.candidateGaps ?? 1);
    return { candidateGaps: gaps } as unknown as KnowledgeSemanticSelfImproveResult;
  };
  /** Advance the fake clock and fire every timer that came due. */
  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    for (;;) {
      const due = timers.findIndex((t) => t.at <= clock);
      if (due < 0) break;
      const [timer] = timers.splice(due, 1);
      timer!.cb();
      await new Promise((r) => setTimeout(r, 1)); // let the run promise settle
    }
  };
  return { svc, runs, timers, advance, state: () => internal.backgroundScheduler.state };
}

describe('production defaults (no overrides — the values that guard the daemon)', () => {
  test('the floor is exactly 5000ms and the zero-gap backoff exactly 3600000ms', async () => {
    const h = harness({ candidateGaps: 0 }); // NO floor/backoff overrides
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-prod' }, 0);
    // The timer was scheduled with the REAL production floor.
    expect(h.timers.length).toBe(1);
    expect(h.timers[0]!.at).toBe(5000);
    // Not a millisecond earlier:
    await h.advance(4999);
    expect(h.runs.length).toBe(0);
    await h.advance(1);
    expect(h.runs.length).toBe(1);
    // Zero-gap run arms the REAL hourly backoff window.
    const state = h.state().get('space:space-prod|reindex')!;
    expect(state.zeroGapUntil).toBe(5000 + 3_600_000);
  });
});

describe('coalescing and cardinality', () => {
  test('a same-scope burst coalesces to one run', async () => {
    const h = harness({ minDelayMs: 100, candidateGaps: 1 });
    for (let i = 0; i < 20; i++) h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-a' }, 0);
    await h.advance(200);
    expect(h.runs.length).toBe(1);
  });

  test('a burst across MANY DISTINCT scopes (the incident shape) collapses into one global sweep', async () => {
    const h = harness({ minDelayMs: 100, candidateGaps: 1 });
    // 1,400 distinct sources — the 2026-07-14 trigger class.
    for (let i = 0; i < 1400; i++) {
      h.svc.queueBackgroundSelfImprove({ reason: 'ingest', sourceIds: [`src-${i}`] }, 0);
    }
    // Pending keys are bounded: at most the cap + the one global sweep.
    const pending = [...h.state().values()].filter((s) => s.pending).length;
    expect(pending).toBeLessThanOrEqual(9); // MAX_PENDING_BACKGROUND_KEYS (8) + global sweep
    await h.advance(200);
    // The burst produced a bounded number of runs, one of them the global sweep.
    expect(h.runs.length).toBeLessThanOrEqual(9);
    expect(h.runs.some((r) => !r.knowledgeSpaceId && !r.sourceIds?.length && !r.gapIds?.length)).toBe(true);
  });

  test('settled state entries are evicted — no monotonic key leak', async () => {
    const h = harness({ minDelayMs: 10, zeroGapBackoffMs: 50, candidateGaps: 0 });
    for (let i = 0; i < 8; i++) {
      h.svc.queueBackgroundSelfImprove({ reason: 'ingest', sourceIds: [`s-${i}`] }, 0);
      await h.advance(20);
    }
    // Let every backoff window lapse, then trigger one more schedule (prunes).
    await h.advance(200);
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'fresh' }, 0);
    expect(h.state().size).toBeLessThanOrEqual(2);
  });
});

describe('zero-gap backoff with gap evidence', () => {
  test('zero-gap results do not self-perpetuate', async () => {
    const h = harness({ minDelayMs: 10, zeroGapBackoffMs: 10_000, candidateGaps: 0 });
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-z' }, 0);
    await h.advance(20);
    expect(h.runs.length).toBe(1);
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-z' }, 0);
    await h.advance(20);
    expect(h.runs.length).toBe(1); // suppressed — backed off
  });

  test('a trigger carrying concrete gapIds CLEARS the backoff instead of being dropped', async () => {
    const h = harness({ minDelayMs: 10, zeroGapBackoffMs: 10_000, candidateGaps: 0 });
    h.svc.queueBackgroundSelfImprove({ reason: 'answer', knowledgeSpaceId: 'space-g' }, 0);
    await h.advance(20);
    expect(h.runs.length).toBe(1); // armed the backoff
    // New answer discovers a concrete gap — evidence the scope is not gap-free.
    h.svc.queueBackgroundSelfImprove({ reason: 'answer', knowledgeSpaceId: 'space-g', gapIds: ['gap-7'] }, 0);
    await h.advance(20);
    expect(h.runs.length).toBe(2);
    expect(h.runs[1]!.gapIds).toEqual(['gap-7']);
  });

  test('coalescing merges a later trigger gapIds into the queued run (payload preserved)', async () => {
    const h = harness({ minDelayMs: 100, candidateGaps: 1 });
    h.svc.queueBackgroundSelfImprove({ reason: 'answer', knowledgeSpaceId: 'space-m', gapIds: ['g1'] }, 0);
    h.svc.queueBackgroundSelfImprove({ reason: 'answer', knowledgeSpaceId: 'space-m', gapIds: ['g2', 'g3'] }, 0);
    await h.advance(200);
    expect(h.runs.length).toBe(1);
    expect([...(h.runs[0]!.gapIds ?? [])].sort()).toEqual(['g1', 'g2', 'g3']);
  });

  test('runs that find gaps keep rescheduling normally', async () => {
    const h = harness({ minDelayMs: 10, zeroGapBackoffMs: 10_000, candidateGaps: 3 });
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-k' }, 0);
    await h.advance(20);
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-k' }, 0);
    await h.advance(20);
    expect(h.runs.length).toBe(2);
  });
});

describe('governor pause + admission at fire time', () => {
  test('a timer queued BEFORE the pause does not execute while paused; it runs after resume', async () => {
    let paused = false;
    const h = harness({ minDelayMs: 10, candidateGaps: 1, paused: () => paused });
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-p' }, 0);
    paused = true; // pressure lands during the floor window
    await h.advance(50);
    expect(h.runs.length).toBe(0); // re-armed, never ran
    paused = false;
    await h.advance(2_000);
    expect(h.runs.length).toBe(1); // ran after resume
  });

  test('critical-tier admission refusal drops the run with an honest log, not an execution', async () => {
    const h = harness({
      minDelayMs: 10,
      candidateGaps: 1,
      admit: () => ({ allowed: false, reason: 'critical memory pressure' }),
    });
    h.svc.queueBackgroundSelfImprove({ reason: 'reindex', knowledgeSpaceId: 'space-c' }, 0);
    await h.advance(50);
    expect(h.runs.length).toBe(0);
    // The slot is released — a later trigger can schedule again.
    expect([...h.state().values()].some((s) => s.pending)).toBe(false);
  });
});
