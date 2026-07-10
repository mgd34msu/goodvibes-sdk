/**
 * automation/checkin-execution.ts
 *
 * The execution path for a `kind: 'checkin'` automation job. When the shared
 * scheduler fires a check-in job, executeAutomationJob delegates here instead of
 * spawning a generic agent: the attached check-in evaluator runs its own
 * briefing→judgment→conditional-delivery loop (see checkin/service.ts) and
 * returns a terminal outcome, which this module records as a normal, terminal
 * AutomationRun using the same context idioms the main execution path uses
 * (set run, advance job counters, persist, emit queued/started/completed).
 *
 * The check-in run is SYNCHRONOUS and terminal — there is no fire-and-forget
 * agent to reconcile later — so the run it produces is already `completed` or
 * `failed`, and its `result` records what the check-in decided.
 */
import { randomUUID } from 'node:crypto';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationRunTrigger } from './types.js';
import type { AutomationManagerExecutionContext } from './manager-runtime-execution.js';

/** What a single check-in evaluation decided — the outcome the evaluator returns. */
export interface AutomationCheckinOutcome {
  /** delivered: contacted the user. quiet: judged nothing warranted contact. skipped: disabled/quiet-hours. error: evaluation failed. */
  readonly outcome: 'delivered' | 'quiet' | 'skipped' | 'error';
  /** A one-line human summary for the run receipt. */
  readonly summary: string;
  /** The channel delivery id when a message was delivered. */
  readonly deliveryId?: string | undefined;
  /** The error detail when outcome is 'error'. */
  readonly error?: string | undefined;
}

/** The check-in evaluator the CheckinService attaches to the AutomationManager. */
export type AutomationCheckinEvaluator = (job: AutomationJob) => Promise<AutomationCheckinOutcome>;

/**
 * Run a check-in job to a terminal AutomationRun via the attached evaluator.
 * Records the run through the same context methods executeAutomationJob uses so
 * the automation run history, persistence, and events are identical to any
 * other job — the run is simply terminal on return rather than pending an agent.
 */
export async function executeCheckinJob(
  context: AutomationManagerExecutionContext,
  evaluator: AutomationCheckinEvaluator,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt: number,
): Promise<AutomationRun> {
  const now = Date.now();
  const baseRun: AutomationRun = {
    id: `autorun-${job.id}-${now}-${randomUUID().slice(0, 6)}`,
    labels: trigger === 'manual' ? ['manual', 'checkin'] : ['scheduled', 'checkin'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    jobId: job.id,
    status: 'running',
    triggeredBy: { ...job.source, lastSeenAt: now, updatedAt: now },
    target: job.execution.target,
    execution: job.execution,
    scheduleKind: job.schedule.kind,
    queuedAt: now,
    startedAt: now,
    forceRun: trigger === 'manual',
    dueRun,
    attempt,
    deliveryIds: [],
  };

  const runningJob: AutomationJob = {
    ...job,
    lastRunAt: now,
    lastRunId: baseRun.id,
    runCount: job.runCount + 1,
    updatedAt: now,
  };
  context.runs.set(baseRun.id, baseRun);
  context.jobs.set(runningJob.id, runningJob);
  context.emitRunQueued(runningJob, baseRun);
  context.emitRunStarted(runningJob, baseRun);

  try {
    const evaluation = await evaluator(job);
    const end = Date.now();
    const failed = evaluation.outcome === 'error';
    const terminal: AutomationRun = {
      ...baseRun,
      status: failed ? 'failed' : 'completed',
      endedAt: end,
      durationMs: end - now,
      deliveryIds: evaluation.deliveryId ? [evaluation.deliveryId] : [],
      result: { checkin: evaluation.outcome, summary: evaluation.summary },
      ...(evaluation.error ? { error: evaluation.error } : {}),
    };
    const finalJob: AutomationJob = {
      ...runningJob,
      successCount: failed ? runningJob.successCount : runningJob.successCount + 1,
      failureCount: failed ? runningJob.failureCount + 1 : runningJob.failureCount,
      updatedAt: end,
    };
    context.runs.set(terminal.id, terminal);
    context.jobs.set(finalJob.id, finalJob);
    context.pruneRunHistory(finalJob.id);
    await Promise.all([context.saveJobs(), context.saveRuns()]);
    context.syncRunToRuntime(terminal, 'automation.checkin');
    context.syncJobToRuntime(finalJob, 'automation.checkin');
    context.emitRunCompleted(finalJob, terminal, failed ? 'failed' : 'success');
    return terminal;
  } catch (error) {
    const end = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const failedRun: AutomationRun = {
      ...baseRun,
      status: 'failed',
      endedAt: end,
      durationMs: end - now,
      error: message,
    };
    const finalJob: AutomationJob = {
      ...runningJob,
      failureCount: runningJob.failureCount + 1,
      updatedAt: end,
    };
    context.runs.set(failedRun.id, failedRun);
    context.jobs.set(finalJob.id, finalJob);
    context.pruneRunHistory(finalJob.id);
    await Promise.all([context.saveJobs(), context.saveRuns()]);
    context.syncRunToRuntime(failedRun, 'automation.checkin');
    context.syncJobToRuntime(finalJob, 'automation.checkin');
    context.emitRunFailed(finalJob, failedRun, message, false);
    return failedRun;
  }
}
