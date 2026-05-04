import type { DaemonRuntimeRouteHandlers } from '../../control-plane/routes/context.js';
import type { DaemonRuntimeRouteContext as SdkDaemonRuntimeRouteContext, AutomationSurfaceKind, JsonBody } from '@pellux/goodvibes-daemon-sdk';
import type { ExecutionIntent } from '../../runtime/execution-intents.js';
// The local Like-view types below describe the minimal route handler inputs
// accepted by daemon-sdk handlers. They stay narrow so callers can provide
// lightweight records instead of full runtime objects.
export interface SharedSessionRoutingIntent {
  readonly modelId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly executionIntent?: ExecutionIntent | undefined;
}
interface AutomationRouteBinding {
  readonly id?: string | undefined;
}
type AgentRecordLike = {
  readonly id: string;
  readonly status: string;
  readonly task: string;
  readonly model?: string | null | undefined;
  readonly tools: readonly string[];
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  readonly toolCallCount?: number | undefined;
  readonly progress?: string | null | undefined;
  readonly error?: string | null | undefined;
};
type AutomationJobLike = { readonly id: string };
type AutomationRunLike = {
  readonly id: string;
  readonly jobId: string;
  readonly agentId?: string | undefined;
  readonly status: string;
  readonly startedAt?: number | undefined;
  readonly queuedAt: number;
  readonly continuationMode?: string | undefined;
};
interface RuntimeTaskLike {
  readonly kind?: string | undefined;
  readonly owner?: string | undefined;
  readonly description?: string | undefined;
  readonly title?: string | undefined;
}
interface RuntimeTaskStateLike {
  readonly tasks: Map<string, RuntimeTaskLike>;
}

export interface DaemonRuntimeRouteContext extends Omit<SdkDaemonRuntimeRouteContext, 'trySpawnAgent'> {
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonBody | null | Response>;
  readonly recordApiResponse: (req: Request, path: string, response: Response) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly sessionBroker: {
    start(): Promise<void>;
    submitMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding | undefined;
      task?: string | undefined;
      activeAgentId?: string | null | undefined;
      userMessage?: unknown | undefined;
    }>;
    steerMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
      allowSpawnFallback?: boolean | undefined;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding | undefined;
      task?: string | undefined;
      activeAgentId?: string | null | undefined;
      userMessage?: unknown | undefined;
    }>;
    followUpMessage(input: {
      sessionId?: string | undefined;
      routeId?: string | undefined;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string | undefined;
      threadId?: string | undefined;
      userId?: string | undefined;
      displayName?: string | undefined;
      title?: string | undefined;
      body: string;
      metadata?: Record<string, unknown> | undefined;
      routing?: SharedSessionRoutingIntent | undefined;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding | undefined;
      task?: string | undefined;
      activeAgentId?: string | null | undefined;
      userMessage?: unknown | undefined;
    }>;
    bindAgent(sessionId: string, agentId: string): Promise<unknown>;
    createSession(input: {
      id?: string | undefined;
      title?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      routeBinding?: AutomationRouteBinding | undefined;
      participant?: {
        surfaceKind: AutomationSurfaceKind;
        surfaceId: string;
        externalId?: string | undefined;
        userId?: string | undefined;
        displayName?: string | undefined;
        routeId?: string | undefined;
        lastSeenAt: number;
      };
    }): Promise<{ id: string }>;
    getSession(sessionId: string): { id: string; status: string; messageCount: number; activeAgentId?: string } | null;
    getMessages(sessionId: string, limit: number): unknown[];
    getInputs(sessionId: string, limit: number): unknown[];
    closeSession(sessionId: string): Promise<{ id: string } | null>;
    reopenSession(sessionId: string): Promise<{ id: string } | null>;
    cancelInput(sessionId: string, inputId: string): Promise<unknown | null>;
    completeAgent(sessionId: string, agentId: string, message: string, meta: { status: string; routeId?: string }): Promise<void>;
    appendCompanionMessage(sessionId: string, input: {
      readonly messageId: string;
      readonly body: string;
      readonly timestamp: number;
      readonly source: string;
    }): Promise<unknown>;
  };
  readonly agentManager: {
    getStatus(agentId: string): AgentRecordLike | null;
    cancel(agentId: string): void;
  };
  readonly automationManager: {
    listJobs(): AutomationJobLike[];
    listRuns(): AutomationRunLike[];
    getRun(runId: string): AutomationRunLike | null | undefined;
    triggerHeartbeat(input: { source: string }): Promise<unknown>;
    cancelRun(runId: string, reason: string): Promise<unknown | null>;
    retryRun(runId: string): Promise<unknown>;
    createJob(input: Record<string, unknown>): Promise<AutomationJobLike>;
    updateJob(jobId: string, input: Record<string, unknown>): Promise<AutomationJobLike | null>;
    removeJob(jobId: string): Promise<void>;
    setEnabled(jobId: string, enabled: boolean): Promise<AutomationJobLike | null>;
    runNow(jobId: string): Promise<{ id: string; agentId?: string; status: string }>;
    getSchedulerCapacity(): { slotsTotal: number; slotsInUse: number; queueDepth: number; oldestQueuedAgeMs: number | null };
  };
  readonly normalizeAtSchedule: (at: number) => unknown;
  readonly normalizeEverySchedule: (interval: string | number, anchorAt?: number) => unknown;
  readonly normalizeCronSchedule: (expression: string, timezone?: string, staggerMs?: unknown) => unknown;
  readonly routeBindings: {
    start(): Promise<void>;
    getBinding(id: string): AutomationRouteBinding | undefined;
  };
  readonly trySpawnAgent: (input: {
    mode: 'spawn';
    task: string;
    model?: string | undefined;
    tools?: string[] | readonly string[] | undefined;
    provider?: string | undefined;
    context?: string | undefined;
    executionIntent?: ExecutionIntent | undefined;
  }, logLabel: string, sessionId?: string) => AgentRecordLike | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string; readonly workflowChainId?: string; readonly sessionId?: string; },
  ) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: AgentRecordLike, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: AgentRecordLike) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: { getState(): { tasks: RuntimeTaskStateLike } } | null;
  readonly runtimeDispatch: {
    transitionRuntimeTask(
      taskId: string,
      status: string,
      patch: Record<string, unknown>,
      source: string,
    ): void;
  } | null;
}

export type { JsonBody };

export type DaemonRuntimeRouteHandlerMap = DaemonRuntimeRouteHandlers;
