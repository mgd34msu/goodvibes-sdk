import { randomUUID } from 'node:crypto';
import { SharedSessionBroker } from '../control-plane/index.js';
import type { SharedSessionRecord, SharedSessionSubmission } from '../control-plane/index.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRouteBinding } from './routes.js';
import type { AutomationRun, AutomationRunContinuationMode } from './runs.js';
import type { AutomationSessionTarget } from './session-targets.js';
import type { AutomationRunTrigger } from './types.js';
import type { ConfigManager } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import {
  buildAutomationExecutionIntent,
  buildAutomationExecutionContext,
} from './manager-runtime-helpers.js';

export interface AutomationManagerExecutionContext {
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly defaultSurfaceKind?: AutomationSessionTarget['surfaceKind'] | undefined;
  readonly defaultSurfaceId?: string | undefined;
  readonly spawnTask: (input: {
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly modelProvider?: string | undefined;
    readonly fallbackModels?: readonly string[] | undefined;
    readonly routing?: AutomationRun['execution']['routing'] | undefined;
    readonly executionIntent?: AutomationRun['execution']['executionIntent'] | undefined;
    readonly template?: string | undefined;
    readonly reasoningEffort?: AutomationRun['execution']['reasoningEffort'] | undefined;
    readonly toolAllowlist?: readonly string[] | undefined;
    readonly context?: string | undefined;
  }) => string;
  readonly saveJobs: () => Promise<void>;
  readonly saveRuns: () => Promise<void>;
  readonly pruneRunHistory: (jobId?: string) => void;
  readonly activeRunCount: () => number;
  readonly maxConcurrentRuns: () => number;
  readonly syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitRunQueued: (job: AutomationJob, run: AutomationRun) => void;
  readonly emitRunStarted: (job: AutomationJob, run: AutomationRun) => void;
  readonly emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => void;
  readonly emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => void;
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => void;
  readonly scheduleFailureFollowUp: (job: AutomationJob, run: AutomationRun) => void;
  readonly applyFailureToJob: (job: AutomationJob, timestamp: number, countRun?: boolean) => AutomationJob;
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
}

interface ResolvedAutomationExecution {
  readonly task: string;
  readonly continuationMode: AutomationRunContinuationMode;
  readonly session?: SharedSessionRecord | undefined;
  readonly route?: AutomationRouteBinding | undefined;
  readonly agentId?: string | undefined;
  readonly target: AutomationSessionTarget;
  readonly executionIntent: AutomationRun['executionIntent'];
  readonly updatedJob?: AutomationJob | undefined;
}

function requireHostSurfaceKind(
  context: AutomationManagerExecutionContext,
  target: AutomationSessionTarget,
  job: AutomationJob,
): NonNullable<AutomationSessionTarget['surfaceKind']> {
  const surfaceKind = target.surfaceKind ?? context.defaultSurfaceKind;
  if (!surfaceKind) {
    throw new Error(
      `Automation target "${target.kind}" requires target.surfaceKind or an explicit AutomationManager defaultSurfaceKind (${job.id})`,
    );
  }
  return surfaceKind;
}

function resolveHostSurfaceId(
  context: AutomationManagerExecutionContext,
  surfaceKind: NonNullable<AutomationSessionTarget['surfaceKind']>,
): string {
  return context.defaultSurfaceId ?? `surface:${surfaceKind}`;
}

export async function executeAutomationJob(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  trigger: AutomationRunTrigger,
  dueRun: boolean,
  attempt = 1,
): Promise<AutomationRun> {
  const now = Date.now();
  const prompt = job.execution.prompt ?? job.description ?? job.name;
  const resolved = await resolveAutomationExecution(context, job, prompt, trigger);
  const effectiveJob = resolved.updatedJob ?? job;
  const run: AutomationRun = {
    id: `autorun-${job.id}-${now}-${randomUUID().slice(0, 6)}`,
    labels: trigger === 'manual' ? ['manual'] : ['scheduled'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'automation-manager',
    updatedBy: 'automation-manager',
    jobId: job.id,
    status: 'running',
    triggeredBy: {
      ...effectiveJob.source,
      lastSeenAt: now,
      updatedAt: now,
    },
    target: resolved.target,
    execution: {
      ...effectiveJob.execution,
      prompt,
    },
    scheduleKind: effectiveJob.schedule.kind,
    queuedAt: now,
    startedAt: now,
    endedAt: undefined,
    durationMs: undefined,
    forceRun: trigger === 'manual',
    dueRun,
    attempt,
    sessionId: resolved.session?.id,
    routeId: resolved.route?.id,
    route: resolved.route,
    continuationMode: resolved.continuationMode,
    executionIntent: resolved.executionIntent,
    deliveryIds: [],
    deliveryAttempts: undefined,
    modelId: effectiveJob.execution.modelId,
    providerId: effectiveJob.execution.modelProvider,
    result: undefined,
    error: undefined,
    cancelledReason: undefined,
    agentId: resolved.agentId,
  };

  try {
    if (resolved.continuationMode === 'continued-live') {
      const runningRun: AutomationRun = {
        ...run,
        agentId: resolved.agentId,
      };
      const updatedJob: AutomationJob = {
        ...effectiveJob,
        lastRunAt: now,
        lastRunId: runningRun.id,
        runCount: effectiveJob.runCount + 1,
        updatedAt: now,
      };
      context.runs.set(runningRun.id, runningRun);
      context.jobs.set(updatedJob.id, updatedJob);
      await context.syncExecutionRoute(updatedJob, runningRun);
      context.pruneRunHistory(updatedJob.id);
      await Promise.all([context.saveJobs(), context.saveRuns()]);
      context.syncRunToRuntime(runningRun, 'automation.execute');
      context.syncJobToRuntime(updatedJob, 'automation.execute');
      context.emitRunQueued(updatedJob, runningRun);
      context.emitRunStarted(updatedJob, runningRun);
      return runningRun;
    }

    const executionContext = buildAutomationExecutionContext(effectiveJob.execution, resolved.session?.id);
    const agentId = context.spawnTask({
      prompt: resolved.task,
      modelId: effectiveJob.execution.modelId,
      modelProvider: effectiveJob.execution.modelProvider,
      fallbackModels: effectiveJob.execution.fallbackModels,
      routing: effectiveJob.execution.routing,
      executionIntent: effectiveJob.execution.executionIntent,
      template: effectiveJob.execution.template,
      reasoningEffort: effectiveJob.execution.reasoningEffort,
      toolAllowlist: effectiveJob.execution.toolAllowlist,
      ...(executionContext ? { context: executionContext } : {}),
    });
    const runningRun: AutomationRun = {
      ...run,
      agentId,
    };
    const updatedJob: AutomationJob = {
      ...effectiveJob,
      lastRunAt: now,
      lastRunId: runningRun.id,
      runCount: effectiveJob.runCount + 1,
      updatedAt: now,
    };
    if (resolved.session?.id && resolved.continuationMode !== 'background') {
      await context.sessionBroker.bindAgent(resolved.session.id, agentId);
    }
    context.runs.set(runningRun.id, runningRun);
    context.jobs.set(updatedJob.id, updatedJob);
    await context.syncExecutionRoute(updatedJob, runningRun);
    context.pruneRunHistory(updatedJob.id);
    await Promise.all([context.saveJobs(), context.saveRuns()]);
    context.syncRunToRuntime(runningRun, 'automation.execute');
    context.syncJobToRuntime(updatedJob, 'automation.execute');
    context.emitRunQueued(updatedJob, runningRun);
    context.emitRunStarted(updatedJob, runningRun);
    return runningRun;
  } catch (error) {
    const message = summarizeError(error);
    const failedRun: AutomationRun = {
      ...run,
      status: 'failed',
      endedAt: now,
      durationMs: 0,
      error: message,
    };
    context.runs.set(failedRun.id, failedRun);
    const updatedJob = context.applyFailureToJob(effectiveJob, now);
    context.jobs.set(updatedJob.id, updatedJob);
    await context.syncExecutionRoute(updatedJob, failedRun);
    if (failedRun.sessionId && failedRun.continuationMode !== 'continued-live') {
      await context.sessionBroker.appendSystemMessage(failedRun.sessionId, `Automation failed: ${message}`, {
        automationJobId: updatedJob.id,
        automationRunId: failedRun.id,
        status: 'failed',
      });
    }
    context.pruneRunHistory(updatedJob.id);
    await Promise.all([context.saveJobs(), context.saveRuns()]);
    context.syncRunToRuntime(failedRun, 'automation.execute');
    context.syncJobToRuntime(updatedJob, 'automation.execute');
    context.emitRunFailed(updatedJob, failedRun, message, true);
    if (!updatedJob.enabled && effectiveJob.enabled) {
      // The caller is responsible for surfacing auto-disable events.
    }
    throw error;
  }
}

export async function resolveAutomationExecution(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  prompt: string,
  trigger: AutomationRunTrigger,
): Promise<ResolvedAutomationExecution> {
  const target = job.execution.target;
  await context.routeBindings.start();
  await context.sessionBroker.start();

  if (target.kind === 'isolated') {
    return {
      task: prompt,
      continuationMode: 'spawn',
      route: resolveRouteForTarget(context, target, job),
      target,
      executionIntent: buildAutomationExecutionIntent(target.kind, 'spawn'),
    };
  }

  if (target.kind === 'background') {
    return {
      task: prompt,
      continuationMode: 'background',
      route: resolveRouteForTarget(context, target, job),
      target,
      executionIntent: buildAutomationExecutionIntent(target.kind, 'background'),
    };
  }

  if (target.kind === 'main') {
    const surfaceKind = requireHostSurfaceKind(context, target, job);
    const preferredSession = target.sessionId
      ? context.sessionBroker.getSession(target.sessionId)
      : await context.sessionBroker.findPreferredSession({
          surfaceKind,
        });
    if (!preferredSession && !target.createIfMissing) {
      throw new Error(`No active shared session found for main target (${job.id})`);
    }
    const fallbackSessionId = target.sessionId ?? target.pinnedSessionId ?? 'main';
    const session = preferredSession ?? await context.sessionBroker.ensureSession({
      sessionId: fallbackSessionId,
      title: 'Main automation session',
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'main',
      },
      participant: {
        surfaceKind,
        surfaceId: resolveHostSurfaceId(context, surfaceKind),
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  if (target.kind === 'route') {
    const routeId = target.routeId ?? job.delivery.replyToRouteId;
    if (!routeId) {
      throw new Error(`Automation route target requires a route binding (${job.id})`);
    }
    const route = context.routeBindings.getBinding(routeId);
    if (!route) {
      throw new Error(`Automation route target not found: ${routeId}`);
    }
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      routeId: route.id,
      target: {
        ...target,
        routeId: route.id,
      },
    });
  }

  if (target.kind === 'session') {
    if (!target.sessionId) {
      throw new Error(`Automation session target requires sessionId (${job.id})`);
    }
    const existingSession = context.sessionBroker.getSession(target.sessionId);
    if (!existingSession && !target.createIfMissing) {
      throw new Error(`Automation session target not found: ${target.sessionId}`);
    }
    const session = await context.sessionBroker.ensureSession({
      sessionId: target.sessionId,
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
      },
      participant: {
        surfaceKind: 'service',
        surfaceId: 'surface:automation',
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  if (target.kind === 'pinned') {
    const pinnedSessionId = target.pinnedSessionId ?? `auto-pin-${job.id}`;
    const session = await context.sessionBroker.ensureSession({
      sessionId: pinnedSessionId,
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'pinned',
      },
      participant: {
        surfaceKind: 'service',
        surfaceId: 'surface:automation',
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    const updatedTarget: AutomationSessionTarget = {
      ...target,
      pinnedSessionId,
      sessionId: session.id,
    };
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: updatedTarget,
      updatedJob: target.pinnedSessionId === pinnedSessionId
        ? undefined
        : {
            ...job,
            updatedAt: Date.now(),
            execution: {
              ...job.execution,
              target: updatedTarget,
            },
          },
    });
  }

  if (target.kind === 'current') {
    const surfaceKind = requireHostSurfaceKind(context, target, job);
    const preferredSession = target.sessionId
      ? context.sessionBroker.getSession(target.sessionId)
      : await context.sessionBroker.findPreferredSession({
          surfaceKind,
        });
    if (!preferredSession && !target.createIfMissing) {
      throw new Error(`No active shared session found for current target (${job.id})`);
    }
    const session = preferredSession ?? await context.sessionBroker.ensureSession({
      title: `${job.name} automation session`,
      metadata: {
        source: 'automation',
        jobId: job.id,
        targetKind: 'current',
      },
      participant: {
        surfaceKind,
        surfaceId: resolveHostSurfaceId(context, surfaceKind),
        userId: 'automation',
        displayName: `Automation: ${job.name}`,
        lastSeenAt: Date.now(),
      },
    });
    return await resolveSharedSessionExecution(context, job, prompt, trigger, {
      sessionId: session.id,
      target: {
        ...target,
        sessionId: session.id,
      },
    });
  }

  return {
    task: prompt,
    continuationMode: 'spawn',
    route: resolveRouteForTarget(context, target, job),
    target,
    executionIntent: buildAutomationExecutionIntent(target.kind, 'spawn'),
  };
}

export async function resolveSharedSessionExecution(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  prompt: string,
  trigger: AutomationRunTrigger,
  input: {
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly target: AutomationSessionTarget;
    readonly updatedJob?: AutomationJob | undefined;
  },
): Promise<ResolvedAutomationExecution> {
  const route = input.routeId
    ? context.routeBindings.getBinding(input.routeId)
    : resolveRouteForTarget(context, input.target, job);
  if (route?.id && input.target.preserveThread && (input.target.threadId || input.target.channelId)) {
    await context.routeBindings.patchBinding(route.id, {
      ...(input.target.threadId ? { threadId: input.target.threadId } : {}),
      ...(input.target.channelId ? { channelId: input.target.channelId } : {}),
    });
  }
  const submission = await context.sessionBroker.submitMessage({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(route?.id ? { routeId: route.id } : {}),
    surfaceKind: 'service',
    surfaceId: 'surface:automation',
    externalId: `automation:${job.id}`,
    userId: 'automation',
    displayName: `Automation: ${job.name}`,
    title: job.name,
    body: prompt,
    metadata: {
      automationJobId: job.id,
      trigger,
      targetKind: input.target.kind,
    },
  });
  return toResolvedExecution(job, input.target, submission, input.updatedJob);
}

export function toResolvedExecution(
  job: AutomationJob,
  target: AutomationSessionTarget,
  submission: SharedSessionSubmission,
  updatedJob?: AutomationJob,
): ResolvedAutomationExecution {
  const resolvedTarget: AutomationSessionTarget = {
    ...target,
    sessionId: submission.session.id,
    ...(submission.routeBinding?.id ? { routeId: submission.routeBinding.id } : {}),
  };
  return {
    task: submission.task ?? (job.execution.prompt ?? job.description ?? job.name),
    continuationMode: submission.mode === 'continued-live' ? 'continued-live' : 'shared-session',
    session: submission.session,
    route: submission.routeBinding,
    agentId: submission.activeAgentId,
    target: resolvedTarget,
    executionIntent: buildAutomationExecutionIntent(
      target.kind,
      submission.mode === 'continued-live' ? 'continued-live' : 'shared-session',
    ),
    updatedJob,
  };
}

export function resolveRouteForTarget(
  context: AutomationManagerExecutionContext,
  target: AutomationSessionTarget,
  job: AutomationJob,
): AutomationRouteBinding | undefined {
  const routeId = target.routeId ?? job.delivery.replyToRouteId;
  if (!routeId) return undefined;
  return context.routeBindings.getBinding(routeId);
}

export async function syncExecutionRoute(
  context: AutomationManagerExecutionContext,
  job: AutomationJob,
  run: AutomationRun,
): Promise<void> {
  if (!run.routeId) return;
  await context.routeBindings.patchBinding(run.routeId, {
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    jobId: job.id,
    runId: run.id,
    ...(run.target.threadId ? { threadId: run.target.threadId } : {}),
    ...(run.target.channelId ? { channelId: run.target.channelId } : {}),
  });
}

export function applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
  const nextFailureCount = job.failureCount + 1;
  const shouldPause = Boolean(job.failure.disableAfterFailures)
    && nextFailureCount >= job.failure.maxConsecutiveFailures;
  return {
    ...job,
    lastRunAt: timestamp,
    runCount: countRun ? job.runCount + 1 : job.runCount,
    failureCount: nextFailureCount,
    enabled: shouldPause ? false : job.enabled,
    status: shouldPause ? 'paused' : job.status,
    pausedReason: shouldPause ? 'failure-threshold-reached' : job.pausedReason,
    updatedAt: timestamp,
  };
}
