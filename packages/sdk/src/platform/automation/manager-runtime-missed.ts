import { randomUUID } from 'node:crypto';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';

/**
 * Records a scheduled occurrence that never fired as a first-class `missed` run.
 *
 * A missed run is not a failure of execution — it is a run that never started
 * because the automation host was down or asleep when its planned time passed
 * the catch-up window. It is captured as a durable run record so it surfaces in
 * run history and flows the same delivery path as a failure, rather than being
 * silently swallowed by recomputing the next occurrence.
 */
export interface AutomationMissedRunContext {
  readonly runs: Map<string, AutomationRun>;
  readonly saveRuns: () => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly deliverFailureNotice: (job: AutomationJob, run: AutomationRun) => void;
  readonly pruneRunHistory: (jobId?: string) => void;
}

/**
 * An honest, observable description of why a run was missed. The scheduler
 * cannot positively distinguish a stopped daemon from a sleeping host, so the
 * reason states the fact it can vouch for — the host was not running the job at
 * its planned time — and how far past due the occurrence is.
 */
export function describeMissedRunReason(plannedRunAt: number, now: number): string {
  const overdueMinutes = Math.max(0, Math.round((now - plannedRunAt) / 60_000));
  return `Scheduled run missed: the automation host was not running at the planned time (overdue by ${overdueMinutes} min).`;
}

export function recordAutomationMissedRun(
  context: AutomationMissedRunContext,
  job: AutomationJob,
  plannedRunAt: number,
): AutomationRun {
  // A given planned slot is missed once. Repeated (re)scheduling passes — boot
  // then heartbeat — must not mint duplicate records for the same occurrence.
  for (const existing of context.runs.values()) {
    if (existing.jobId === job.id && existing.status === 'missed' && existing.queuedAt === plannedRunAt) {
      return existing;
    }
  }

  const now = Date.now();
  const run: AutomationRun = {
    id: `automiss-${job.id}-${plannedRunAt}-${randomUUID().slice(0, 6)}`,
    labels: ['scheduled', 'missed'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    jobId: job.id,
    status: 'missed',
    triggeredBy: { ...job.source, lastSeenAt: now, updatedAt: now },
    target: job.execution.target,
    execution: job.execution,
    scheduleKind: job.schedule.kind,
    queuedAt: plannedRunAt,
    startedAt: undefined,
    endedAt: now,
    durationMs: undefined,
    forceRun: false,
    dueRun: true,
    attempt: 0,
    deliveryIds: [],
    deliveryAttempts: undefined,
    result: undefined,
    error: describeMissedRunReason(plannedRunAt, now),
    cancelledReason: undefined,
  };

  context.runs.set(run.id, run);
  context.pruneRunHistory(job.id);
  context.syncRunToRuntime(run, 'automation.missed');
  context.deliverFailureNotice(job, run);
  void context.saveRuns();
  return run;
}
