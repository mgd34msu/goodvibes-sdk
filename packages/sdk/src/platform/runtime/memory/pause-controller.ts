/**
 * pause-controller.ts — the backpressure seam the MemoryGovernor drives to
 * pause and resume deferrable background jobs (knowledge self-improvement,
 * memory consolidation, code-index reindex) when memory pressure is high.
 *
 * A job registers a {@link PausableJob} with a stable id. The governor calls
 * pauseAll()/resumeAll(); each transition emits a receipt-grade log line naming
 * the job and the new state, so a pause is never silent. A job that is asked to
 * start work while paused checks `isPaused(id)` (or awaits `whenResumed(id)`)
 * and defers instead of running.
 */
import { logger } from '../../utils/logger.js';

/** A deferrable background job the governor can pause/resume. */
export interface PausableJob {
  /** Stable id for logs and receipts. */
  readonly id: string;
  /** Called when the governor pauses the job. Best-effort; must not throw. */
  onPause?(reason: string): void;
  /** Called when the governor resumes the job. Best-effort; must not throw. */
  onResume?(reason: string): void;
}

/** Snapshot of a job's pause state. */
export interface PausableJobState {
  readonly id: string;
  readonly paused: boolean;
}

export class PauseController {
  private readonly jobs = new Map<string, PausableJob>();
  private readonly paused = new Set<string>();
  private readonly resumeWaiters = new Map<string, Array<() => void>>();

  /** Register a job. Returns a deregister fn. A job registered while paused stays paused. */
  register(job: PausableJob): () => void {
    this.jobs.set(job.id, job);
    return () => {
      this.jobs.delete(job.id);
      this.paused.delete(job.id);
      this.flushWaiters(job.id);
    };
  }

  /** Whether a job is currently paused. Unknown jobs are never paused. */
  isPaused(id: string): boolean {
    return this.paused.has(id);
  }

  /** Ids currently paused. */
  pausedJobs(): string[] {
    return [...this.paused];
  }

  /** State of every registered job. */
  states(): PausableJobState[] {
    return [...this.jobs.keys()].map((id) => ({ id, paused: this.paused.has(id) }));
  }

  /** Pause every registered job. Emits one receipt line per newly-paused job. */
  pauseAll(reason: string): void {
    for (const job of this.jobs.values()) this.pauseOne(job, reason);
  }

  /** Resume every registered job. Emits one receipt line per newly-resumed job. */
  resumeAll(reason: string): void {
    for (const job of this.jobs.values()) this.resumeOne(job, reason);
  }

  private pauseOne(job: PausableJob, reason: string): void {
    if (this.paused.has(job.id)) return;
    this.paused.add(job.id);
    logger.info('[memory] background job paused', { job: job.id, reason });
    try {
      job.onPause?.(reason);
    } catch (error) {
      logger.warn('[memory] job onPause hook threw', { job: job.id, error: String(error) });
    }
  }

  private resumeOne(job: PausableJob, reason: string): void {
    if (!this.paused.has(job.id)) return;
    this.paused.delete(job.id);
    logger.info('[memory] background job resumed', { job: job.id, reason });
    try {
      job.onResume?.(reason);
    } catch (error) {
      logger.warn('[memory] job onResume hook threw', { job: job.id, error: String(error) });
    }
    this.flushWaiters(job.id);
  }

  /**
   * Resolve when the job is not paused. Resolves immediately if already running.
   * A job's work loop can `await controller.whenResumed(id)` at a yield point to
   * apply governor backpressure without busy-waiting.
   */
  whenResumed(id: string): Promise<void> {
    if (!this.paused.has(id)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.resumeWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.resumeWaiters.set(id, waiters);
    });
  }

  private flushWaiters(id: string): void {
    const waiters = this.resumeWaiters.get(id);
    if (!waiters) return;
    this.resumeWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }
}
