/**
 * memory-consolidation-scheduler.ts — the daemon-side driver that makes the
 * consolidation engine actually run.
 *
 * The engine (memory-consolidation.ts) was complete but had no production
 * wiring in this runtime — the only driver lived in the agent surface behind
 * an agent-local toggle, so consolidation effectively never ran. The DAEMON is
 * the memory store's single writer, so this scheduler runs the pass here, on
 * the two triggers the engine's enum already names:
 *
 * - `idle`: the runtime has been continuously idle for minIdleMs and at least
 *   intervalMs has passed since the last run (the preferred, cheap moment);
 * - `schedule`: the slow fallback — even a never-idle daemon consolidates once
 *   per SCHEDULE_FACTOR x intervalMs, so a busy host cannot starve the pass
 *   forever.
 *
 * Mechanical outcomes (reversible merges, never-referenced decay) just happen,
 * with the engine's own run receipts logged and retained on a bounded ring;
 * judgment outcomes stay PROPOSALS in the receipt, routed to the existing
 * confirmation-gated memory routes; nothing is ever auto-deleted (the engine
 * marks stale, never deletes — see its module contract).
 *
 * Timers are unref'd and injectable; `learning.consolidation.enabled: false`
 * remains the user's off switch, re-read live on every wake.
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  runMemoryConsolidation,
  type MemoryConsolidationRegistry,
  type MemoryConsolidationRunReceipt,
  type MemoryConsolidationUsageLookup,
} from './memory-consolidation.js';
import {
  resolveMemoryConsolidationConfig,
  type MemoryConsolidationConfigSource,
} from './memory-consolidation-config.js';

/** A never-idle daemon still consolidates once per SCHEDULE_FACTOR x intervalMs. */
const SCHEDULE_FACTOR = 4;
/** How many run receipts the scheduler retains for inspection. */
const RECEIPT_RING_SIZE = 20;

export interface MemoryConsolidationSchedulerOptions {
  readonly memoryRegistry: MemoryConsolidationRegistry;
  /** Live config source (ConfigManager.getRaw shape); re-read every wake. */
  readonly configSource: MemoryConsolidationConfigSource;
  /** True when the runtime is idle right now (e.g. no busy broker sessions). */
  readonly isIdle: () => boolean;
  /** Optional usage instrumentation; omit when no signal exists (kept honest in receipts). */
  readonly usageLookup?: MemoryConsolidationUsageLookup | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** Wake cadence for the due-ness check (5 minutes by default). */
  readonly checkIntervalMs?: number | undefined;
  /** Optional receipt sink invoked after every run (in addition to the log + ring). */
  readonly onReceipt?: ((receipt: MemoryConsolidationRunReceipt) => void) | undefined;
}

export class MemoryConsolidationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastRunAt = 0;
  /** First-tick timestamp: the schedule fallback baselines here, so a busy daemon consolidates SCHEDULE_FACTOR x intervalMs after start, not instantly. */
  private startedAt: number | null = null;
  private idleSince: number | null = null;
  private readonly receipts: MemoryConsolidationRunReceipt[] = [];

  constructor(private readonly options: MemoryConsolidationSchedulerOptions) {}

  private get checkIntervalMs(): number {
    return this.options.checkIntervalMs ?? 5 * 60 * 1000;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  /** The retained receipts, newest last (bounded ring). */
  listReceipts(): readonly MemoryConsolidationRunReceipt[] {
    return this.receipts;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.tick();
    }, this.checkIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * One wake: track continuous idleness, then run when due — the idle trigger
   * at intervalMs cadence, or the slow schedule fallback when the runtime has
   * not offered an idle window for SCHEDULE_FACTOR x intervalMs.
   */
  tick(): void {
    if (this.stopped) return;
    try {
      const now = (this.options.now ?? Date.now)();
      if (this.startedAt === null) this.startedAt = now;
      const config = resolveMemoryConsolidationConfig(this.options.configSource);
      if (!config.enabled) return;

      const idleNow = this.options.isIdle();
      if (idleNow && this.idleSince === null) this.idleSince = now;
      if (!idleNow) this.idleSince = null;
      const idleLongEnough = idleNow && this.idleSince !== null && now - this.idleSince >= config.minIdleMs;

      const dueForIdleRun = idleLongEnough && now - this.lastRunAt >= config.intervalMs;
      const dueForScheduleRun = now - Math.max(this.lastRunAt, this.startedAt) >= config.intervalMs * SCHEDULE_FACTOR;
      if (!dueForIdleRun && !dueForScheduleRun) return;

      const receipt = runMemoryConsolidation({
        memoryRegistry: this.options.memoryRegistry,
        config,
        now,
        trigger: dueForIdleRun ? 'idle' : 'schedule',
        idle: idleNow,
        ...(this.options.usageLookup ? { usageLookup: this.options.usageLookup } : {}),
      });
      this.lastRunAt = now;
      this.receipts.push(receipt);
      if (this.receipts.length > RECEIPT_RING_SIZE) this.receipts.splice(0, this.receipts.length - RECEIPT_RING_SIZE);
      logger.info('[memory] consolidation ran', {
        runId: receipt.runId,
        trigger: receipt.trigger,
        scanned: receipt.scanned,
        merged: receipt.merged.length,
        decayed: receipt.decayed.length,
        archived: receipt.archived.length,
        proposed: receipt.proposed.length,
      });
      try {
        this.options.onReceipt?.(receipt);
      } catch (error) {
        logger.warn('[memory] consolidation receipt sink failed', { error: summarizeError(error) });
      }
    } catch (error) {
      logger.warn('[memory] consolidation run failed', { error: summarizeError(error) });
    } finally {
      this.scheduleNext();
    }
  }
}
