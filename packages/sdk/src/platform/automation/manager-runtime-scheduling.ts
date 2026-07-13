import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationRunTrigger } from './types.js';
import { computeNextRun } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AutomationHeartbeatWake {
  readonly jobId: string;
  readonly jobName: string;
  readonly trigger: AutomationRunTrigger;
  readonly dueRun: boolean;
  readonly attempt: number;
  readonly queuedAt: number;
  readonly reason: string;
}

interface AutomationSchedulingContext {
  readonly configManager: ConfigManager;
  readonly jobs: Map<string, AutomationJob>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  readonly heartbeatWakes: Map<string, AutomationHeartbeatWake>;
  readonly running: () => boolean;
  readonly saveJobs: () => Promise<void>;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly executeJob: (job: AutomationJob, trigger: AutomationRunTrigger, dueRun: boolean, attempt?: number) => Promise<AutomationRun>;
  /**
   * Record that a scheduled occurrence was missed — the planned run time is now
   * further in the past than the catch-up window, so the run never fired (the
   * daemon was down, or the host was asleep). Optional so callers that only
   * (re)schedule live jobs need not wire it. When present it is invoked with the
   * planned-but-missed run time before the next occurrence is recomputed.
   */
  readonly recordMissedRun?: ((job: AutomationJob, plannedRunAt: number) => void) | undefined;
}

function saveJobsAsync(context: Pick<AutomationSchedulingContext, 'saveJobs'>, reason: string, jobId?: string): void {
  void context.saveJobs().catch((error: unknown) => {
    logger.warn('AutomationManager: job persistence failed', {
      reason,
      jobId,
      error: summarizeError(error),
    });
  });
}

export function scheduleAutomationJob(context: AutomationSchedulingContext, job: AutomationJob): void {
  cancelAutomationTimer(context.timers, job.id);
  if (!context.running() || !job.enabled) return;

  const now = Date.now();
  const catchUpWindowMs = Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000;
  const nextRunAtCandidate = job.nextRunAt ?? computeNextRun(job.schedule, now, job.id);
  // A planned occurrence older than the catch-up window never fired. Record it
  // as a missed run (a first-class outcome that flows the same delivery path as
  // a failure) instead of silently recomputing the next occurrence.
  const missedPlannedRunAt = nextRunAtCandidate !== undefined && nextRunAtCandidate < (now - catchUpWindowMs)
    ? nextRunAtCandidate
    : undefined;
  if (missedPlannedRunAt !== undefined) {
    context.recordMissedRun?.(job, missedPlannedRunAt);
  }
  const nextRunAt = missedPlannedRunAt !== undefined
    ? computeNextRun(job.schedule, now, job.id)
    : nextRunAtCandidate;
  if (nextRunAt === undefined) return;

  const refreshed: AutomationJob = {
    ...job,
    nextRunAt,
  };
  context.jobs.set(job.id, refreshed);
  saveJobsAsync(context, 'schedule', job.id);

  const delayMs = Math.max(0, nextRunAt - Date.now());
  if (delayMs > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => scheduleAutomationJob(context, refreshed), MAX_TIMEOUT_MS);
    timer.unref?.();
    context.timers.set(job.id, timer);
    return;
  }

  const timer = setTimeout(() => {
    const latest = context.jobs.get(job.id);
    if (!latest?.enabled) return;
    if (latest.execution.wakeMode === 'next-heartbeat') {
      queueHeartbeatWake(context.heartbeatWakes, latest, 'scheduled', true, 1, 'scheduled-due');
      return;
    }
    if (context.activeRunCount() >= context.maxConcurrentRuns()) {
      const deferred: AutomationJob = {
        ...latest,
        nextRunAt: Date.now() + 15_000,
        updatedAt: Date.now(),
      };
      context.jobs.set(latest.id, deferred);
      saveJobsAsync(context, 'defer-capacity', latest.id);
      scheduleAutomationJob(context, deferred);
      return;
    }
    void context.executeJob(latest, 'scheduled', true)
      .catch((error) => {
        logger.error('AutomationManager: scheduled execution failed', {
          jobId: latest.id,
          error: summarizeError(error),
        });
      })
      .finally(() => {
        const current = context.jobs.get(job.id);
        if (!current?.enabled) return;
        const next = computeNextRun(current.schedule, Date.now(), current.id);
        if (next !== undefined) {
          const updated: AutomationJob = {
            ...current,
            nextRunAt: next,
            updatedAt: Date.now(),
          };
          context.jobs.set(current.id, updated);
          saveJobsAsync(context, 'advance-next-run', current.id);
          scheduleAutomationJob(context, updated);
          return;
        }
        const completedOneShot: AutomationJob = {
          ...current,
          enabled: false,
          status: 'paused',
          pausedReason: 'one-shot-complete',
          nextRunAt: undefined,
          updatedAt: Date.now(),
        };
        context.jobs.set(current.id, completedOneShot);
        cancelAutomationTimer(context.timers, current.id);
        saveJobsAsync(context, 'complete-one-shot', current.id);
      });
  }, delayMs);
  timer.unref?.();
  context.timers.set(job.id, timer);
}

export function cancelAutomationTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
): void {
  const timer = timers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(jobId);
  }
}

export function queueDueHeartbeatAutomationJobs(
  jobs: Iterable<AutomationJob>,
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  reason: string,
): void {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || job.execution.wakeMode !== 'next-heartbeat') continue;
    if (job.nextRunAt === undefined || job.nextRunAt > now) continue;
    queueHeartbeatWake(heartbeatWakes, job, 'scheduled', true, 1, reason);
  }
}

export function queueHeartbeatWake(
  heartbeatWakes: Map<string, AutomationHeartbeatWake>,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt: number,
  reason: string,
): void {
  if (heartbeatWakes.has(job.id)) return;
  heartbeatWakes.set(job.id, {
    jobId: job.id,
    jobName: job.name,
    trigger,
    dueRun,
    attempt,
    queuedAt: Date.now(),
    reason,
  });
}

export function advanceScheduledHeartbeatAutomationJob(
  context: Pick<AutomationSchedulingContext, 'jobs' | 'saveJobs'>,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  jobId: string,
  reschedule: (job: AutomationJob) => void,
): void {
  const current = context.jobs.get(jobId);
  if (!current?.enabled) return;
  const next = computeNextRun(current.schedule, Date.now(), current.id);
  if (next !== undefined) {
    const updated: AutomationJob = {
      ...current,
      nextRunAt: next,
      updatedAt: Date.now(),
    };
    context.jobs.set(current.id, updated);
    saveJobsAsync(context, 'heartbeat-advance', current.id);
    reschedule(updated);
    return;
  }
  const completedOneShot: AutomationJob = {
    ...current,
    enabled: false,
    status: 'paused',
    pausedReason: 'one-shot-complete',
    nextRunAt: undefined,
    updatedAt: Date.now(),
  };
  context.jobs.set(current.id, completedOneShot);
  cancelAutomationTimer(timers, current.id);
  saveJobsAsync(context, 'heartbeat-complete-one-shot', current.id);
}
