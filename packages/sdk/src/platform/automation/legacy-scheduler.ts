import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import type { AutomationScheduleDefinition } from './schedules.js';
import type { AutomationRunStatus } from './types.js';

export interface LegacySchedulerTask {
  readonly id: string;
  readonly name?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly intervalMs?: number;
  readonly at?: number;
  readonly prompt?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly template?: string;
  readonly enabled?: boolean;
  readonly lastRun?: number;
  readonly nextRun?: number;
  readonly runCount?: number;
  readonly missedRuns?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface LegacySchedulerHistoryEntry {
  readonly taskId: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly agentId?: string;
  readonly status?: AutomationRunStatus | 'success' | 'error';
  readonly error?: string;
}

export interface LegacySchedulerSnapshot extends Record<string, unknown> {
  readonly tasks?: readonly LegacySchedulerTask[];
  readonly history?: readonly LegacySchedulerHistoryEntry[];
}

export interface LegacySchedulerMigrationResult {
  readonly jobs: readonly AutomationJob[];
  readonly runs: readonly AutomationRun[];
}

function normalizeSchedule(task: LegacySchedulerTask): AutomationScheduleDefinition {
  if (typeof task.cron === 'string' && task.cron.trim().length > 0) {
    return {
      kind: 'cron',
      expression: task.cron.trim(),
      ...(task.timezone ? { timezone: task.timezone } : {}),
    };
  }
  if (typeof task.intervalMs === 'number' && Number.isFinite(task.intervalMs) && task.intervalMs > 0) {
    return { kind: 'every', intervalMs: task.intervalMs };
  }
  if (typeof task.at === 'number' && Number.isFinite(task.at) && task.at > 0) {
    return { kind: 'at', at: task.at };
  }
  return { kind: 'at', at: task.nextRun ?? Date.now() };
}

function normalizeRunStatus(status: LegacySchedulerHistoryEntry['status']): AutomationRunStatus {
  switch (status) {
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    default:
      return 'completed';
  }
}

function migrationSource(now: number) {
  return {
    id: 'legacy-scheduler',
    kind: 'migration' as const,
    label: 'Legacy scheduler migration',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

export function migrateLegacySchedules(snapshot: LegacySchedulerSnapshot): LegacySchedulerMigrationResult {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const now = Date.now();
  const source = migrationSource(now);

  const jobs = tasks.map((task): AutomationJob => {
    const createdAt = task.createdAt ?? now;
    const updatedAt = task.updatedAt ?? createdAt;
    const enabled = task.enabled ?? true;
    const prompt = task.prompt ?? task.name ?? task.id;
    return {
      id: task.id,
      labels: [],
      createdAt,
      updatedAt,
      createdBy: 'legacy-scheduler-migration',
      updatedBy: 'legacy-scheduler-migration',
      name: task.name ?? task.id,
      description: prompt,
      status: enabled ? 'enabled' : 'paused',
      enabled,
      schedule: normalizeSchedule(task),
      execution: {
        prompt,
        target: { kind: 'isolated', createIfMissing: true },
        ...(task.model ? { modelId: task.model } : {}),
        ...(task.provider ? { modelProvider: task.provider } : {}),
        ...(task.template ? { template: task.template } : {}),
        sandboxMode: 'inherit',
      },
      delivery: {
        mode: 'none',
        targets: [],
        fallbackTargets: [],
        includeSummary: true,
        includeTranscript: false,
        includeLinks: true,
      },
      failure: {
        action: 'retry',
        maxConsecutiveFailures: 3,
        cooldownMs: 30_000,
        retryPolicy: {
          maxAttempts: 3,
          delayMs: 5_000,
          strategy: 'exponential',
          maxDelayMs: 60_000,
          jitterMs: 500,
        },
        disableAfterFailures: false,
      },
      source,
      ...(task.nextRun ? { nextRunAt: task.nextRun } : {}),
      ...(task.lastRun ? { lastRunAt: task.lastRun } : {}),
      runCount: task.runCount ?? 0,
      successCount: 0,
      failureCount: 0,
      deleteAfterRun: false,
    };
  });

  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const runs = history
    .filter((entry) => jobById.has(entry.taskId))
    .map((entry, index): AutomationRun => {
      const job = jobById.get(entry.taskId)!;
      const queuedAt = entry.startedAt ?? now;
      const status = normalizeRunStatus(entry.status);
      return {
        id: `legacy-run-${entry.taskId}-${queuedAt}-${index}`,
        labels: [],
        createdAt: queuedAt,
        updatedAt: entry.endedAt ?? queuedAt,
        createdBy: 'legacy-scheduler-migration',
        updatedBy: 'legacy-scheduler-migration',
        jobId: entry.taskId,
        status,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        triggeredBy: source,
        target: job.execution.target,
        execution: job.execution,
        scheduleKind: job.schedule.kind,
        queuedAt,
        ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
        ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        forceRun: false,
        dueRun: true,
        attempt: 1,
        deliveryIds: [],
        ...(job.execution.modelId ? { modelId: job.execution.modelId } : {}),
        ...(job.execution.modelProvider ? { providerId: job.execution.modelProvider } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      };
    });

  return { jobs, runs };
}
