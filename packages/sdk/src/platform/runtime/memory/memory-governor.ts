/**
 * memory-governor.ts — the daemon's self-defense against unbounded memory
 * growth. It samples RSS + heap on an interval, maps the footprint to a tier
 * against a configured budget, and drives the CacheRegistry and PauseController
 * so the daemon sheds memory BEFORE the OS OOM-kills it (the ~100GB SIGTRAP
 * incident this exists to end).
 *
 * Tiers (percentages of the budget, owner-confirmed defaults):
 *   normal   (< elevatedPct)  — nothing to do; resume any paused jobs.
 *   elevated (>= elevatedPct) — trim registered caches to their floor + gc.
 *   high     (>= highPct)     — flush all registered caches + pause deferrable
 *                               background jobs.
 *   critical (>= criticalPct) — everything `high` does, plus refuse new
 *                               expensive work with an honest structured outcome
 *                               and emit an ops attention event.
 *
 * Leak tripwire: if, AFTER a full flush, RSS keeps growing faster than
 * `tripwireRateMbPerSec` for `tripwireSustainSec` continuously, the flush did
 * not help — a genuine leak. The governor logs a diagnostic (top cache
 * footprints + heap stats), emits an ops attention event, writes a receipt, and
 * exits gracefully so a supervisor restarts clean — never a silent abort.
 *
 * Everything I/O (sampler, clock, gc, exit, receipt write, ops emit) is
 * injected, so the tier machine and tripwire are unit-testable with fake clocks
 * and samplers.
 */
import { totalmem } from 'node:os';
import { logger } from '../../utils/logger.js';
import type { CacheRegistry, CacheFootprint } from './cache-registry.js';
import type { PauseController } from './pause-controller.js';

export type MemoryTier = 'normal' | 'elevated' | 'high' | 'critical';

const TIER_RANK: Record<MemoryTier, number> = { normal: 0, elevated: 1, high: 2, critical: 3 };

/** One memory sample. Heap fields are best-effort (bun:jsc where available). */
export interface MemorySample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes?: number | undefined;
}

export type MemorySampler = () => MemorySample;

/** Owner-confirmed governor configuration. */
export interface MemoryGovernorConfig {
  /** Budget in MB. 0 or negative ⇒ auto: min(25% of system RAM, 4096). */
  readonly budgetMb: number;
  readonly elevatedPct: number;
  readonly highPct: number;
  readonly criticalPct: number;
  readonly tripwireRateMbPerSec: number;
  readonly tripwireSustainSec: number;
  /** Sampling cadence in ms (default 5000). */
  readonly sampleIntervalMs?: number | undefined;
}

/** Injectable collaborators (all default to real implementations). */
export interface MemoryGovernorDeps {
  readonly caches: CacheRegistry;
  readonly pauses: PauseController;
  readonly sampler?: MemorySampler | undefined;
  readonly now?: (() => number) | undefined;
  readonly gc?: (() => void) | undefined;
  readonly resolveSystemRamMb?: (() => number) | undefined;
  /** Emit the ops attention event (tier change to critical, tripwire). */
  readonly emitOps?: ((event: MemoryPressureEvent) => void) | undefined;
  /** Persist a tripwire receipt so a supervisor sees why the daemon exited. */
  readonly writeReceipt?: ((receipt: MemoryTripwireReceipt) => void) | undefined;
  /** Perform the graceful exit (default process.exit(1)). Injected in tests. */
  readonly exit?: ((receipt: MemoryTripwireReceipt) => void) | undefined;
}

/** The ops attention event payload the governor hands to {@link MemoryGovernorDeps.emitOps}. */
export interface MemoryPressureEvent {
  readonly tier: MemoryTier;
  readonly previousTier: MemoryTier;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly budgetMb: number;
  readonly usedPct: number;
  readonly tripwire?: { readonly rateMbPerSec: number; readonly sustainedSec: number; readonly action: 'exit' } | undefined;
  readonly note?: string | undefined;
}

/** Written to disk when the leak tripwire fires. */
export interface MemoryTripwireReceipt {
  readonly kind: 'memory-leak-tripwire';
  readonly at: number;
  readonly rssMb: number;
  readonly budgetMb: number;
  readonly rateMbPerSec: number;
  readonly sustainedSec: number;
  readonly heap: MemorySample;
  readonly topCaches: readonly CacheFootprint[];
  readonly note: string;
}

/** The ops.memory verb payload — the full governor snapshot. */
export interface MemoryGovernorSnapshot {
  readonly tier: MemoryTier;
  readonly budgetMb: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb?: number | undefined;
  readonly usedPct: number;
  readonly refusingExpensiveWork: boolean;
  readonly caches: readonly CacheFootprint[];
  readonly pausedJobs: readonly string[];
  readonly tripwire: {
    readonly armed: boolean;
    readonly sustainedSec: number;
    readonly rateMbPerSec: number;
  };
  readonly thresholds: {
    readonly elevatedPct: number;
    readonly highPct: number;
    readonly criticalPct: number;
  };
}

/** Structured refusal returned when the governor is at the critical tier. */
export interface ExpensiveWorkDecision {
  readonly allowed: boolean;
  readonly tier: MemoryTier;
  readonly reason?: string | undefined;
}

const MB = 1024 * 1024;

function defaultSampler(): MemorySample {
  const mem = process.memoryUsage();
  return { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal };
}

function defaultGc(): void {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  if (bun?.gc) bun.gc(true);
  else if (typeof globalThis.gc === 'function') (globalThis.gc as () => void)();
}

export class MemoryGovernor {
  private readonly caches: CacheRegistry;
  private readonly pauses: PauseController;
  private readonly sampler: MemorySampler;
  private readonly now: () => number;
  private readonly gc: () => void;
  private readonly emitOps: ((event: MemoryPressureEvent) => void) | undefined;
  private readonly writeReceipt: ((receipt: MemoryTripwireReceipt) => void) | undefined;
  private readonly exit: (receipt: MemoryTripwireReceipt) => void;
  private readonly sampleIntervalMs: number;

  private readonly budgetMb: number;
  private readonly elevatedBytes: number;
  private readonly highBytes: number;
  private readonly criticalBytes: number;
  private readonly tripwireRateBytesPerSec: number;
  private readonly tripwireSustainMs: number;

  private tier: MemoryTier = 'normal';
  private refusing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private exited = false;

  // Tripwire state: armed after a full flush, tracks growth since the flush.
  private flushBaselineBytes: number | null = null;
  private flushBaselineAt = 0;
  private tripwireOverSince: number | null = null;
  private lastRateMbPerSec = 0;

  constructor(config: MemoryGovernorConfig, deps: MemoryGovernorDeps) {
    this.caches = deps.caches;
    this.pauses = deps.pauses;
    this.sampler = deps.sampler ?? defaultSampler;
    this.now = deps.now ?? Date.now;
    this.gc = deps.gc ?? defaultGc;
    this.emitOps = deps.emitOps;
    this.writeReceipt = deps.writeReceipt;
    this.exit = deps.exit ?? ((): void => { process.exit(1); });
    this.sampleIntervalMs = Math.max(250, config.sampleIntervalMs ?? 5_000);

    const resolveRam = deps.resolveSystemRamMb ?? ((): number => totalmem() / MB);
    this.budgetMb = config.budgetMb > 0
      ? config.budgetMb
      : Math.max(256, Math.min(Math.floor(resolveRam() * 0.25), 4096));
    const budgetBytes = this.budgetMb * MB;
    this.elevatedBytes = budgetBytes * (config.elevatedPct / 100);
    this.highBytes = budgetBytes * (config.highPct / 100);
    this.criticalBytes = budgetBytes * (config.criticalPct / 100);
    this.tripwireRateBytesPerSec = config.tripwireRateMbPerSec * MB;
    this.tripwireSustainMs = config.tripwireSustainSec * 1000;
  }

  /** Begin interval sampling. Idempotent. The timer is unref'd so it never pins the loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sampleOnce(), this.sampleIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop sampling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The current tier. */
  currentTier(): MemoryTier {
    return this.tier;
  }

  /**
   * Consult the governor before starting expensive work. At the critical tier
   * the daemon refuses with an honest structured outcome rather than piling on
   * more allocation.
   */
  admitExpensiveWork(label = 'expensive operation'): ExpensiveWorkDecision {
    if (this.refusing) {
      return {
        allowed: false,
        tier: this.tier,
        reason: `Daemon is under critical memory pressure (RSS >= ${this.budgetMb}MB budget); ${label} refused. Retry once pressure clears.`,
      };
    }
    return { allowed: true, tier: this.tier };
  }

  /** The full governor snapshot served by the ops.memory verb. */
  snapshot(): MemoryGovernorSnapshot {
    const sample = this.sampler();
    const usedPct = (sample.rssBytes / (this.budgetMb * MB)) * 100;
    return {
      tier: this.tier,
      budgetMb: this.budgetMb,
      rssMb: round1(sample.rssBytes / MB),
      heapUsedMb: round1(sample.heapUsedBytes / MB),
      ...(sample.heapTotalBytes !== undefined ? { heapTotalMb: round1(sample.heapTotalBytes / MB) } : {}),
      usedPct: round1(usedPct),
      refusingExpensiveWork: this.refusing,
      caches: this.caches.footprints(),
      pausedJobs: this.pauses.pausedJobs(),
      tripwire: {
        armed: this.flushBaselineBytes !== null,
        sustainedSec: this.tripwireOverSince !== null ? round1((this.now() - this.tripwireOverSince) / 1000) : 0,
        rateMbPerSec: round1(this.lastRateMbPerSec),
      },
      thresholds: {
        elevatedPct: round1((this.elevatedBytes / (this.budgetMb * MB)) * 100),
        highPct: round1((this.highBytes / (this.budgetMb * MB)) * 100),
        criticalPct: round1((this.criticalBytes / (this.budgetMb * MB)) * 100),
      },
    };
  }

  /** Take one sample and apply tier actions + tripwire. Exposed for deterministic tests. */
  sampleOnce(): void {
    if (this.exited) return;
    const sample = this.sampler();
    const rss = sample.rssBytes;
    const nextTier = this.tierFor(rss);
    if (nextTier !== this.tier) {
      const previousTier = this.tier;
      this.tier = nextTier;
      this.applyTier(nextTier, previousTier, sample);
    }
    this.checkTripwire(sample);
  }

  private tierFor(rssBytes: number): MemoryTier {
    if (rssBytes >= this.criticalBytes) return 'critical';
    if (rssBytes >= this.highBytes) return 'high';
    if (rssBytes >= this.elevatedBytes) return 'elevated';
    return 'normal';
  }

  private applyTier(tier: MemoryTier, previousTier: MemoryTier, sample: MemorySample): void {
    const rank = TIER_RANK[tier];
    this.receipt('info', `memory tier ${previousTier} -> ${tier}`, {
      rssMb: round1(sample.rssBytes / MB),
      budgetMb: this.budgetMb,
    });

    if (rank >= TIER_RANK.elevated) {
      // Elevated: shrink to floor and reclaim.
      this.caches.trimAll('floor');
      this.gc();
    }
    if (rank >= TIER_RANK.high) {
      // High/critical: full flush + pause deferrable jobs, and arm the tripwire
      // against the post-flush baseline.
      this.caches.trimAll('flush');
      this.pauses.pauseAll(`memory-pressure:${tier}`);
      this.armTripwire(sample);
    } else {
      // Dropped below high: disarm the tripwire and resume jobs.
      this.disarmTripwire();
      this.pauses.resumeAll(`memory-recovered:${tier}`);
    }

    this.refusing = rank >= TIER_RANK.critical;

    if (rank >= TIER_RANK.critical || (previousTier !== tier && rank >= TIER_RANK.high)) {
      this.emitPressure(tier, previousTier, sample);
    }
  }

  private armTripwire(sample: MemorySample): void {
    // Re-baseline only when not already armed, so growth is measured from the
    // FIRST flush, not reset on every high sample.
    if (this.flushBaselineBytes === null) {
      this.flushBaselineBytes = sample.rssBytes;
      this.flushBaselineAt = this.now();
      this.tripwireOverSince = null;
    }
  }

  private disarmTripwire(): void {
    this.flushBaselineBytes = null;
    this.tripwireOverSince = null;
    this.lastRateMbPerSec = 0;
  }

  private checkTripwire(sample: MemorySample): void {
    if (this.flushBaselineBytes === null) return;
    const elapsedSec = (this.now() - this.flushBaselineAt) / 1000;
    if (elapsedSec <= 0) return;
    const growthBytes = sample.rssBytes - this.flushBaselineBytes;
    const rateBytesPerSec = growthBytes / elapsedSec;
    this.lastRateMbPerSec = rateBytesPerSec / MB;
    if (rateBytesPerSec > this.tripwireRateBytesPerSec) {
      if (this.tripwireOverSince === null) this.tripwireOverSince = this.now();
      const sustainedMs = this.now() - this.tripwireOverSince;
      if (sustainedMs >= this.tripwireSustainMs) {
        this.fireTripwire(sample);
      }
    } else {
      this.tripwireOverSince = null;
    }
  }

  private fireTripwire(sample: MemorySample): void {
    if (this.exited) return;
    this.exited = true;
    this.stop();
    const sustainedSec = this.tripwireOverSince !== null ? (this.now() - this.tripwireOverSince) / 1000 : this.tripwireSustainMs / 1000;
    const topCaches = [...this.caches.footprints()]
      .sort((a, b) => (b.estimatedBytes ?? b.entries) - (a.estimatedBytes ?? a.entries))
      .slice(0, 5);
    const receipt: MemoryTripwireReceipt = {
      kind: 'memory-leak-tripwire',
      at: this.now(),
      rssMb: round1(sample.rssBytes / MB),
      budgetMb: this.budgetMb,
      rateMbPerSec: round1(this.lastRateMbPerSec),
      sustainedSec: round1(sustainedSec),
      heap: sample,
      topCaches,
      note: 'RSS kept growing after a full cache flush — a genuine leak. Exiting so a supervisor restarts clean.',
    };
    logger.error('[memory] leak tripwire fired — exiting for a clean restart', {
      rssMb: receipt.rssMb,
      rateMbPerSec: receipt.rateMbPerSec,
      sustainedSec: receipt.sustainedSec,
      topCaches: topCaches.map((c) => ({ id: c.id, entries: c.entries, bytes: c.estimatedBytes })),
    });
    this.emitPressure('critical', this.tier, sample, {
      rateMbPerSec: receipt.rateMbPerSec,
      sustainedSec: receipt.sustainedSec,
      action: 'exit',
    });
    try {
      this.writeReceipt?.(receipt);
    } catch (error) {
      logger.warn('[memory] tripwire receipt write failed', { error: String(error) });
    }
    this.exit(receipt);
  }

  private emitPressure(
    tier: MemoryTier,
    previousTier: MemoryTier,
    sample: MemorySample,
    tripwire?: { rateMbPerSec: number; sustainedSec: number; action: 'exit' },
  ): void {
    this.emitOps?.({
      tier,
      previousTier,
      rssMb: round1(sample.rssBytes / MB),
      heapMb: round1(sample.heapUsedBytes / MB),
      budgetMb: this.budgetMb,
      usedPct: round1((sample.rssBytes / (this.budgetMb * MB)) * 100),
      ...(tripwire ? { tripwire } : {}),
    });
  }

  private receipt(level: 'info' | 'warn', message: string, fields: Record<string, unknown>): void {
    if (level === 'warn') logger.warn(`[memory] ${message}`, fields);
    else logger.info(`[memory] ${message}`, fields);
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
