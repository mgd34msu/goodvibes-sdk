/**
 * memory-governor.test.ts
 *
 * Item 4 (a–d) guard for the SDK-owned memory governance layer: the cache
 * registry's fail-closed membership gate, the pausable-job seam, and the
 * MemoryGovernor's tier machine + leak tripwire. Everything I/O is injected, so
 * the tiers and tripwire are exercised deterministically with fake clocks and
 * samplers.
 */
import { describe, expect, test } from 'bun:test';
import {
  CacheRegistry,
  KNOWN_MEMORY_CACHES,
  MemoryGovernor,
  PauseController,
  assertMemoryCacheRegistered,
  createMemoryGovernance,
  isMemoryCacheRegistered,
  type CacheTrimLevel,
  type MemoryPressureEvent,
  type MemorySample,
  type MemoryTripwireReceipt,
} from '../packages/sdk/src/platform/runtime/memory/index.js';

const MB = 1024 * 1024;

describe('CacheRegistry membership gate (fails loudly)', () => {
  test('RED: an unregistered cache id fails the membership check', () => {
    expect(() => assertMemoryCacheRegistered('mystery-cache', 'test'))
      .toThrow(/unknown memory cache id "mystery-cache".*KNOWN_MEMORY_CACHES/s);
    expect(isMemoryCacheRegistered('mystery-cache')).toBe(false);
    const reg = new CacheRegistry();
    expect(() => reg.register('mystery-cache' as never, { name: 'x', entryCount: () => 0, trim: () => {} }))
      .toThrow(/unknown memory cache id/);
  });

  test('every known cache id is registerable and enumerable', () => {
    const reg = new CacheRegistry();
    for (const id of KNOWN_MEMORY_CACHES) {
      expect(isMemoryCacheRegistered(id)).toBe(true);
      reg.register(id, { name: id, entryCount: () => 1, estimateBytes: () => 10, trim: () => {} });
    }
    expect(reg.registeredIds().sort()).toEqual([...KNOWN_MEMORY_CACHES].sort());
    expect(reg.totalEntries()).toBe(KNOWN_MEMORY_CACHES.length);
    expect(reg.footprints().length).toBe(KNOWN_MEMORY_CACHES.length);
  });

  test('trimAll drives every registered cache; a throwing cache never blocks the rest', () => {
    const reg = new CacheRegistry();
    const seen: Array<[string, CacheTrimLevel]> = [];
    reg.register('knowledge-store', { name: 'k', entryCount: () => 0, trim: (l) => { seen.push(['knowledge-store', l]); } });
    reg.register('session-union', { name: 's', entryCount: () => 0, trim: () => { throw new Error('boom'); } });
    reg.register('event-replay-ring', { name: 'e', entryCount: () => 0, trim: (l) => { seen.push(['event-replay-ring', l]); } });
    expect(() => reg.trimAll('flush')).not.toThrow();
    expect(seen).toEqual([['knowledge-store', 'flush'], ['event-replay-ring', 'flush']]);
  });
});

describe('PauseController seam', () => {
  test('pause/resume toggles state and resolves whenResumed waiters', async () => {
    const pc = new PauseController();
    const events: string[] = [];
    pc.register({ id: 'job-a', onPause: () => events.push('pause-a'), onResume: () => events.push('resume-a') });
    expect(pc.isPaused('job-a')).toBe(false);
    await pc.whenResumed('job-a'); // resolves immediately when not paused

    pc.pauseAll('pressure');
    expect(pc.isPaused('job-a')).toBe(true);
    expect(pc.pausedJobs()).toEqual(['job-a']);

    let resumed = false;
    const waiter = pc.whenResumed('job-a').then(() => { resumed = true; });
    expect(resumed).toBe(false);
    pc.resumeAll('recovered');
    await waiter;
    expect(resumed).toBe(true);
    expect(pc.isPaused('job-a')).toBe(false);
    expect(events).toEqual(['pause-a', 'resume-a']);
  });
});

/** A governor test harness with a controllable sampler + fake clock. */
function makeGovernor(over: Partial<{ budgetMb: number; rssMb: number }> = {}) {
  const reg = new CacheRegistry();
  const trims: CacheTrimLevel[] = [];
  reg.register('knowledge-store', { name: 'k', entryCount: () => 3, estimateBytes: () => 300, trim: (l) => trims.push(l) });
  const pc = new PauseController();
  const jobEvents: string[] = [];
  pc.register({ id: 'knowledge-self-improve', onPause: () => jobEvents.push('pause'), onResume: () => jobEvents.push('resume') });

  let rssBytes = (over.rssMb ?? 10) * MB;
  let clock = 0;
  let gcCount = 0;
  const opsEvents: MemoryPressureEvent[] = [];
  const receipts: MemoryTripwireReceipt[] = [];
  const shutdowns: MemoryTripwireReceipt[] = [];
  let exitReceipt: MemoryTripwireReceipt | null = null;
  let shutdownWasBeforeExit = false;

  const gov = new MemoryGovernor(
    { budgetMb: over.budgetMb ?? 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
    {
      caches: reg,
      pauses: pc,
      sampler: (): MemorySample => ({ rssBytes, heapUsedBytes: rssBytes / 2, heapTotalBytes: rssBytes }),
      now: () => clock,
      gc: () => { gcCount += 1; },
      emitOps: (e) => opsEvents.push(e),
      writeReceipt: (r) => receipts.push(r),
      shutdown: (r) => { shutdowns.push(r); shutdownWasBeforeExit = exitReceipt === null; },
      exit: (r) => { exitReceipt = r; },
    },
  );

  return {
    gov, trims, jobEvents, opsEvents, receipts, shutdowns,
    shutdownBeforeExit: () => shutdownWasBeforeExit,
    setRssMb: (mb: number) => { rssBytes = mb * MB; },
    advance: (ms: number) => { clock += ms; },
    gcCount: () => gcCount,
    exitReceipt: () => exitReceipt,
  };
}

describe('MemoryGovernor tier machine', () => {
  test('elevated tier trims caches to floor and runs gc', () => {
    const h = makeGovernor({ budgetMb: 100, rssMb: 10 });
    h.setRssMb(65); // 65% of 100MB → elevated
    h.gov.sampleOnce();
    expect(h.gov.currentTier()).toBe('elevated');
    expect(h.trims).toContain('floor');
    expect(h.gcCount()).toBeGreaterThanOrEqual(1);
  });

  test('high tier flushes caches and pauses deferrable jobs', () => {
    const h = makeGovernor({ budgetMb: 100 });
    h.setRssMb(85); // 85% → high
    h.gov.sampleOnce();
    expect(h.gov.currentTier()).toBe('high');
    expect(h.trims).toContain('flush');
    expect(h.jobEvents).toContain('pause');
    expect(h.opsEvents.at(-1)?.tier).toBe('high');
  });

  test('critical tier refuses new expensive work and emits an ops event', () => {
    const h = makeGovernor({ budgetMb: 100 });
    h.setRssMb(97); // 97% → critical
    h.gov.sampleOnce();
    expect(h.gov.currentTier()).toBe('critical');
    const decision = h.gov.admitExpensiveWork('reindex');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/critical memory pressure/i);
    expect(h.opsEvents.at(-1)?.tier).toBe('critical');
  });

  test('recovering below high resumes paused jobs and allows work again', () => {
    const h = makeGovernor({ budgetMb: 100 });
    h.setRssMb(97);
    h.gov.sampleOnce();
    expect(h.gov.admitExpensiveWork().allowed).toBe(false);
    h.setRssMb(10); // back to normal
    h.gov.sampleOnce();
    expect(h.gov.currentTier()).toBe('normal');
    expect(h.jobEvents).toContain('resume');
    expect(h.gov.admitExpensiveWork().allowed).toBe(true);
  });
});

describe('MemoryGovernor leak tripwire', () => {
  test('sustained post-flush growth writes a receipt, runs shutdown, then exits', async () => {
    const h = makeGovernor({ budgetMb: 100 });
    // Enter high → arms the tripwire against the post-flush baseline (85MB @ t0).
    h.setRssMb(85);
    h.gov.sampleOnce();
    // +40MB per 1s tick keeps rss above high and rate > 25MB/s sustained.
    for (let i = 0; i < 61; i++) {
      h.advance(1000);
      h.setRssMb(85 + (i + 1) * 40); // steep, sustained growth
      h.gov.sampleOnce();
      if (h.receipts.length > 0) break;
    }
    // The exit is GRACEFUL (shutdown hook + flush beat before exit) — await it.
    for (let i = 0; i < 50 && !h.exitReceipt(); i++) await new Promise((r) => setTimeout(r, 10));
    const receipt = h.exitReceipt();
    expect(receipt).not.toBeNull();
    // Shutdown ran BEFORE exit, with the same receipt.
    expect(h.shutdowns.length).toBe(1);
    expect(h.shutdownBeforeExit()).toBe(true);
    expect(receipt!.kind).toBe('memory-leak-tripwire');
    expect(receipt!.rateMbPerSec).toBeGreaterThan(25);
    expect(h.receipts.length).toBe(1);
    // The ops attention event carries the tripwire exit action.
    expect(h.opsEvents.at(-1)?.tripwire?.action).toBe('exit');
  });

  test('growth below the rate never trips', () => {
    const h = makeGovernor({ budgetMb: 100 });
    h.setRssMb(85);
    h.gov.sampleOnce();
    for (let i = 0; i < 120; i++) {
      h.advance(1000);
      h.setRssMb(85 + (i + 1) * 0.1); // +0.1MB/s — far below 25MB/s
      h.gov.sampleOnce();
    }
    expect(h.exitReceipt()).toBeNull();
  });
});

describe('MemoryGovernor budget resolution + snapshot', () => {
  test('budgetMb=0 auto-resolves to min(25% of system RAM, 4096)', () => {
    const reg = new CacheRegistry();
    const pc = new PauseController();
    const gov = new MemoryGovernor(
      { budgetMb: 0, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
      { caches: reg, pauses: pc, sampler: () => ({ rssBytes: 0, heapUsedBytes: 0 }), resolveSystemRamMb: () => 64 * 1024 },
    );
    // 25% of 64GB = 16GB, capped to 4096MB.
    expect(gov.snapshot().budgetMb).toBe(4096);

    const gov2 = new MemoryGovernor(
      { budgetMb: 0, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
      { caches: reg, pauses: pc, sampler: () => ({ rssBytes: 0, heapUsedBytes: 0 }), resolveSystemRamMb: () => 8 * 1024 },
    );
    // 25% of 8GB = 2048MB, under the cap.
    expect(gov2.snapshot().budgetMb).toBe(2048);
  });

  test('createMemoryGovernance registers all known caches + jobs and drives them (item 4f/4e)', () => {
    let rss = 10 * MB;
    let clock = 0;
    const { cacheRegistry, pauseController, memoryGovernor } = createMemoryGovernance({
      config: { budgetMb: 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
      caches: KNOWN_MEMORY_CACHES.map((id) => ({ id, cache: { name: id, entryCount: () => 1, trim: () => {} } })),
      jobIds: ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'],
      start: false,
      deps: { sampler: () => ({ rssBytes: rss, heapUsedBytes: rss / 2 }), now: () => clock, gc: () => {}, exit: () => {} },
    });
    expect(cacheRegistry.registeredIds().sort()).toEqual([...KNOWN_MEMORY_CACHES].sort());
    expect(pauseController.states().map((s) => s.id).sort()).toEqual(['code-index-reindex', 'knowledge-self-improvement', 'memory-consolidation']);
    // High pressure pauses every deferrable job — the seam scheduler gates read.
    rss = 85 * MB;
    memoryGovernor.sampleOnce();
    expect(pauseController.isPaused('knowledge-self-improvement')).toBe(true);
    // The ops.memory verb serves this snapshot.
    const snap = memoryGovernor.snapshot();
    expect(snap.caches.length).toBe(KNOWN_MEMORY_CACHES.length);
    expect(snap.pausedJobs.length).toBe(3);
    expect(snap.tier).toBe('high');
  });

  test('snapshot serves tier, budget, rss, heap, caches, paused jobs, tripwire state', () => {
    const h = makeGovernor({ budgetMb: 100 });
    h.setRssMb(50);
    const snap = h.gov.snapshot();
    expect(snap.budgetMb).toBe(100);
    expect(snap.rssMb).toBe(50);
    expect(snap.caches.length).toBe(1);
    expect(snap.caches[0]!.id).toBe('knowledge-store');
    expect(snap.thresholds).toEqual({ elevatedPct: 60, highPct: 80, criticalPct: 95 });
    expect(snap.pausedJobs).toEqual([]);
    expect(snap.tripwire.armed).toBe(false);
  });
});

describe('fix-round hardening (reviewer scenarios)', () => {
  const baseConfig = { budgetMb: 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 };
  const noopDeps = { sampler: () => ({ rssBytes: 0, heapUsedBytes: 0 }) };

  test('inverted tier thresholds are refused loudly at construction (criticalPct=10 typo)', () => {
    const reg = new CacheRegistry();
    const pc = new PauseController();
    expect(() => new MemoryGovernor({ ...baseConfig, criticalPct: 10 }, { caches: reg, pauses: pc, ...noopDeps }))
      .toThrow(/memory\.tier\.elevatedPct.*memory\.tier\.highPct.*memory\.tier\.criticalPct/s);
    expect(() => new MemoryGovernor({ ...baseConfig, elevatedPct: 90, highPct: 50 }, { caches: reg, pauses: pc, ...noopDeps }))
      .toThrow(/must hold/);
  });

  test('budget auto-resolution honors the cgroup v2/v1 limit below physical RAM', async () => {
    const { resolveEffectiveSystemRamMb } = await import('../packages/sdk/src/platform/runtime/memory/index.ts');
    // v2 limit 2GB on a 64GB host -> 2048MB effective.
    expect(resolveEffectiveSystemRamMb((p) => {
      if (p === '/sys/fs/cgroup/memory.max') return String(2 * 1024 * 1024 * 1024);
      throw new Error('ENOENT');
    }, 64 * 1024)).toBe(2048);
    // v2 'max' (unlimited) falls through to v1; v1 huge sentinel ignored -> physical RAM.
    expect(resolveEffectiveSystemRamMb((p) => {
      if (p === '/sys/fs/cgroup/memory.max') return 'max';
      if (p === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return '9223372036854771712';
      throw new Error('ENOENT');
    }, 64 * 1024)).toBe(64 * 1024);
    // No cgroup files at all -> physical RAM.
    expect(resolveEffectiveSystemRamMb(() => { throw new Error('ENOENT'); }, 8 * 1024)).toBe(8 * 1024);
  });

  test('sliding-window rate: a late-onset leak after LONG high-tier residency still trips in ~sustain time', async () => {
    const h = makeGovernor({ budgetMb: 100_000 }); // large budget: high at 80GB
    h.setRssMb(81_000); // enter high, arm tripwire
    h.gov.sampleOnce();
    // 10 HOURS of flat residency at high tier (the lifetime-average dilution case).
    for (let i = 0; i < 7200; i++) {
      h.advance(5_000);
      h.gov.sampleOnce();
    }
    expect(h.exitReceipt()).toBeNull();
    // NOW a genuine 140MB/s leak starts: with a lifetime average this would stay
    // diluted below 25MB/s for ~2.2 hours; the sliding window sees it in ~60s.
    let rss = 81_000;
    let receiptAtTick = -1;
    for (let i = 0; i < 40; i++) {
      h.advance(5_000);
      rss += 700; // 140MB/s * 5s
      h.setRssMb(rss);
      h.gov.sampleOnce();
      if (h.receipts.length > 0) { receiptAtTick = i; break; }
    }
    expect(receiptAtTick).toBeGreaterThanOrEqual(0);
    expect(receiptAtTick).toBeLessThanOrEqual(30); // ~within a couple of sustain windows, not hours
  });

  test('the tripwire receipt directory is created on a fresh install (no ENOENT swallow)', async () => {
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'gv-receipt-'));
    const receiptPath = join(root, 'surface', 'memory', 'tripwire-receipt.json'); // parent dirs DO NOT exist
    let rss = 10 * MB;
    let clock = 0;
    const handles = createMemoryGovernance({
      config: { ...baseConfig, tripwireSustainSec: 10 },
      caches: [],
      jobIds: [],
      receiptPath,
      start: false,
      deps: { sampler: () => ({ rssBytes: rss, heapUsedBytes: rss }), now: () => clock, gc: () => {}, exit: () => {} },
    });
    rss = 85 * MB; handles.memoryGovernor.sampleOnce(); // arm
    for (let i = 0; i < 20; i++) {
      clock += 1000; rss += 40 * MB;
      handles.memoryGovernor.sampleOnce();
      if (existsSync(receiptPath)) break;
    }
    expect(existsSync(receiptPath)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('wireDaemonMemoryGovernance registers REAL adapters: counts reflect stores and trims reclaim', async () => {
    const jobRunCounts = [120, 60, 30];
    const pruned: number[] = [];
    const brokerTrims: string[] = [];
    let rss = 10 * MB;
    const { memoryGovernor, cacheRegistry } = (await import('../packages/sdk/src/platform/runtime/memory/index.ts')).wireDaemonMemoryGovernance({
      config: baseConfig,
      cacheRegistry: new CacheRegistry(),
      pauseController: new PauseController(),
      jobIds: ['knowledge-self-improvement'],
      receiptPath: '/tmp/unused-receipt.json',
      knowledgeStores: jobRunCounts.map((_count, i) => ({
        retainedEntryCount: () => jobRunCounts[i]!,
        pruneJobRuns: (keep: number) => { pruned.push(keep); jobRunCounts[i] = Math.min(jobRunCounts[i]!, keep); return 0; },
      })),
      sessionBroker: {
        retainedRecordCount: () => 42,
        trimRetained: (level: 'floor' | 'flush') => { brokerTrims.push(level); },
      },
    });
    memoryGovernor.stop(); // no interval in tests
    // Real counts:
    const foot = cacheRegistry.footprints();
    expect(foot.find((f) => f.id === 'knowledge-store')!.entries).toBe(210);
    expect(foot.find((f) => f.id === 'session-union')!.entries).toBe(42);
    // Real trims: flush prunes job runs to the flush floor and flushes the broker.
    cacheRegistry.trimAll('flush');
    expect(pruned).toEqual([0, 0, 0]);
    expect(brokerTrims).toEqual(['flush']);
    expect(cacheRegistry.footprints().find((f) => f.id === 'knowledge-store')!.entries).toBe(0);
    void rss;
  });
});
