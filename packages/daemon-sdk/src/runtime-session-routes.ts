import type { DaemonApiRouteHandlers } from './context.js';
import { randomUUID } from 'node:crypto';
import type {
  AutomationSurfaceKind,
  DaemonRuntimeRouteContext,
  ExecutionIntent,
  JsonBody,
  SharedSessionRoutingIntent,
} from './runtime-route-types.js';

type SharedSessionSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['submitMessage']>>;
type SharedSessionSteerSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['steerMessage']>>;
type SharedSessionFollowUpSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['followUpMessage']>>;
type SessionSubmission = SharedSessionSubmission | SharedSessionSteerSubmission | SharedSessionFollowUpSubmission;

export function createDaemonRuntimeSessionRouteHandlers(
  context: DaemonRuntimeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'createSharedSession'
  | 'postTask'
  | 'getSharedSession'
  | 'closeSharedSession'
  | 'reopenSharedSession'
  | 'getSharedSessionMessages'
  | 'getSharedSessionInputs'
  | 'postSharedSessionMessage'
  | 'postSharedSessionSteer'
  | 'postSharedSessionFollowUp'
  | 'cancelSharedSessionInput'
  | 'getRuntimeTask'
  | 'runtimeTaskAction'
  | 'getTaskStatus'
  | 'getSharedSessionEvents'
> {
  return {
    createSharedSession: async (request) => handleCreateSharedSession(context, request),
    postTask: async (request) => handlePostTask(context, request),
    getSharedSession: async (sessionId) => handleGetSharedSession(context, sessionId),
    closeSharedSession: (sessionId) => handleSharedSessionLifecycle(context, sessionId, 'close'),
    reopenSharedSession: (sessionId) => handleSharedSessionLifecycle(context, sessionId, 'reopen'),
    getSharedSessionMessages: async (sessionId, url) => handleGetSharedSessionMessages(context, sessionId, url),
    getSharedSessionInputs: async (sessionId, url) => handleGetSharedSessionInputs(context, sessionId, url),
    postSharedSessionMessage: (sessionId, request) => handlePostSharedSessionMessage(context, sessionId, request),
    postSharedSessionSteer: (sessionId, request) => handlePostSharedSessionSteer(context, sessionId, request),
    postSharedSessionFollowUp: (sessionId, request) => handlePostSharedSessionFollowUp(context, sessionId, request),
    cancelSharedSessionInput: (sessionId, inputId) => handleCancelSharedSessionInput(context, sessionId, inputId),
    getRuntimeTask: (taskId) => handleGetRuntimeTask(context, taskId),
    runtimeTaskAction: (taskId, action, request) => handleRuntimeTaskAction(context, taskId, action, request),
    getTaskStatus: (agentId) => handleGetTaskStatus(context, agentId),
    getSharedSessionEvents: (sessionId, request) => handleGetSharedSessionEvents(context, sessionId, request),
  };
}

async function handleCreateSharedSession(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  await context.sessionBroker.start();
  await context.routeBindings.start();
  const routeBinding = typeof body.routeId === 'string'
    ? context.routeBindings.getBinding(body.routeId)
    : undefined;
  const session = await context.sessionBroker.createSession({
    id: typeof body.id === 'string' ? body.id : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    routeBinding,
    participant: typeof body.surfaceKind === 'string' && typeof body.surfaceId === 'string'
      ? {
          surfaceKind: body.surfaceKind as AutomationSurfaceKind,
          surfaceId: body.surfaceId,
          externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
          userId: typeof body.userId === 'string' ? body.userId : undefined,
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          routeId: routeBinding?.id,
          lastSeenAt: Date.now(),
        }
      : undefined,
  });
  return context.recordApiResponse(req, '/api/sessions', Response.json({ session }, { status: 201 }));
}

async function handlePostTask(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const task = body.task;
  if (!task || typeof task !== 'string' || task.trim() === '') {
    return Response.json({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
  }
  const model = typeof body.model === 'string' ? body.model : undefined;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
  const wantsSharedSession = typeof body.sessionId === 'string' || typeof body.routeId === 'string' || typeof body.surfaceKind === 'string';
  if (wantsSharedSession) {
    const submission = await context.sessionBroker.submitMessage({
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      surfaceKind: typeof body.surfaceKind === 'string' ? body.surfaceKind as AutomationSurfaceKind : 'web',
      surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      body: task.trim(),
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      ...(typeof body.routing === 'object' && body.routing !== null ? { routing: body.routing as SharedSessionRoutingIntent } : {}),
    });

    if (submission.mode === 'continued-live') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: submission.activeAgentId ?? null,
        inputId: submission.input.id,
      }, { status: 202 }));
    }
    if (submission.mode === 'queued-follow-up') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: submission.activeAgentId ?? null,
        inputId: submission.input.id,
      }, { status: 202 }));
    }
    if (submission.mode === 'rejected') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: false,
        mode: submission.mode,
        sessionId: submission.session.id,
        inputId: submission.input.id,
      }, { status: 409 }));
    }

    const sessionSpawn = context.trySpawnAgent({
      mode: 'spawn',
      task: submission.task!,
      ...(model !== undefined || submission.input.routing?.modelId ? { model: model ?? submission.input.routing?.modelId } : {}),
      ...(tools !== undefined || submission.input.routing?.tools ? { tools: tools ?? [...(submission.input.routing?.tools ?? [])] } : {}),
      ...(submission.input.routing?.providerId ? { provider: submission.input.routing.providerId } : {}),
      ...(submission.input.routing?.executionIntent ? { executionIntent: submission.input.routing.executionIntent } : {}),
    }, 'DaemonServer.handlePostTask.sharedSession', submission.session.id);
    if (sessionSpawn instanceof Response) return sessionSpawn;
    await context.sessionBroker.bindAgent(submission.session.id, sessionSpawn.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding, {
      agentId: sessionSpawn.id,
      task,
      sessionId: submission.session.id,
    });
    return context.recordApiResponse(req, '/task', Response.json({
      acknowledged: true,
      mode: submission.mode,
      sessionId: submission.session.id,
      agentId: sessionSpawn.id,
      status: sessionSpawn.status,
    }, { status: 202 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task,
    ...(model !== undefined && { model }),
    ...(tools !== undefined && { tools }),
    ...(typeof body.routing === 'object'
      && body.routing !== null
      && typeof (body.routing as { executionIntent?: unknown }).executionIntent === 'object'
      && (body.routing as { executionIntent?: unknown }).executionIntent !== null
      ? {
          executionIntent: (body.routing as {
            executionIntent: ExecutionIntent;
          }).executionIntent,
        }
      : {}),
  }, 'DaemonServer', typeof body.sessionId === 'string' ? body.sessionId : undefined);
  if (spawnResult instanceof Response) return spawnResult;
  return context.recordApiResponse(req, '/task', Response.json({
    acknowledged: true,
    agentId: spawnResult.id,
    status: spawnResult.status,
    task: spawnResult.task,
    model: spawnResult.model ?? null,
    tools: spawnResult.tools,
  }, { status: 202 }));
}

async function handleGetSharedSession(context: DaemonRuntimeRouteContext, sessionId: string): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }
  return Response.json({
    session,
    messages: context.sessionBroker.getMessages(sessionId, 100),
  });
}

async function handleSharedSessionLifecycle(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  action: 'close' | 'reopen',
): Promise<Response> {
  await context.sessionBroker.start();
  const session = action === 'close'
    ? await context.sessionBroker.closeSession(sessionId)
    : await context.sessionBroker.reopenSession(sessionId);
  return session
    ? Response.json({ session })
    : Response.json({ error: 'Unknown shared session' }, { status: 404 });
}

async function handleGetSharedSessionMessages(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  url: URL,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }
  const limit = Number(url.searchParams.get('limit') ?? 100);
  return Response.json({
    session,
    messages: context.sessionBroker.getMessages(sessionId, limit),
  });
}

async function handleGetSharedSessionInputs(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  url: URL,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }
  const limit = Number(url.searchParams.get('limit') ?? 100);
  return Response.json({
    session,
    inputs: context.sessionBroker.getInputs(sessionId, limit),
  });
}

/**
 * Handle POST /api/sessions/:sessionId/messages.
 *
 * Accepts either `{body}`, `{message}`, or `{text}` in the request payload (F13 normalization,
 * in priority order). If multiple fields are present, `{body}` takes precedence over
 * `{message}`, which takes precedence over `{text}`.
 * Returns 400 when none of the accepted fields are present or all are empty.
 */
async function handlePostSharedSessionMessage(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;

  // Validate kind field — 'task' (default), 'message', and 'followup' are accepted
  const kind = body.kind === undefined ? 'task' : body.kind;
  if (kind !== 'task' && kind !== 'message' && kind !== 'followup') {
    return Response.json(
      { error: `Invalid kind '${String(kind)}'. Accepted values: 'task' | 'message' | 'followup'`, code: 'INVALID_KIND' },
      { status: 400 },
    );
  }

  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return Response.json({ error: 'Missing shared session message body' }, { status: 400 });
  }

  // kind='followup' — always queues/spawns a follow-up turn via followUpMessage()
  if (kind === 'followup') {
    const followUpSubmission = await context.sessionBroker.followUpMessage(buildSharedSessionMessageInput(sessionId, body, message));
    return await respondToSessionSubmission(context, req, followUpSubmission, message, `/api/sessions/${sessionId}/messages`, 'DaemonServer.handlePostSharedSessionMessage.followup', {
      context: `shared-session:${followUpSubmission.session.id}`,
    });
  }

  // kind='message' — companion main-chat send. Persist + publish COMPANION_MESSAGE_RECEIVED
  // on the runtime bus; TUI's bootstrap-core subscriber delegates to
  // orchestrator.handleUserInput() which fires a real LLM turn (same entry as TUI input
  // box). Turn events stream to both TUI and companion over SSE automatically.
  // Deliberately short-circuits BEFORE sessionBroker.submitMessage() to avoid the
  // buildContinuationTask WRFC engineer-chain spawn path.
  if (kind === 'message') {
    const session = context.sessionBroker.getSession(sessionId);
    if (!session) {
      return Response.json({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
    }
    if (session.status === 'closed') {
      return Response.json({ error: 'Session is closed', code: 'SESSION_CLOSED' }, { status: 409 });
    }
    const messageId = randomUUID();
    const timestamp = Date.now();
    // Persist the companion message to the session log so GET /api/sessions/:id/messages
    // returns it and the TUI can render it.
    await context.sessionBroker.appendCompanionMessage(sessionId, {
      messageId,
      body: message,
      source: 'companion-followup',
      timestamp,
    });
    // Also notify the TUI's in-process subscriber via the conversation follow-up event.
    context.publishConversationFollowup(sessionId, {
      messageId,
      body: message,
      source: 'companion-followup',
      timestamp,
    });
    // Return immediately. appendCompanionMessage persists the message and
    // publishConversationFollowup emits COMPANION_MESSAGE_RECEIVED on the runtime bus.
    // The TUI's bootstrap-core.ts COMPANION_MESSAGE_RECEIVED subscriber delegates to
    // orchestrator.handleUserInput(), which adds the user message to the conversation
    // view and fires a real LLM turn whose events stream to both TUI and companion SSE.
    // The { routedTo: 'conversation' } shape signals the companion app that the message
    // was received and persisted (isConversationRouteResult check).
    return context.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
      messageId,
      routedTo: 'conversation',
      sessionId,
    }, { status: 202 }));
  }

  const submission = await context.sessionBroker.submitMessage(buildSharedSessionMessageInput(sessionId, body, message));

  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/messages`, 'DaemonServer.handlePostSharedSessionMessage', {
    context: `shared-session:${submission.session.id}`,
  });
}

/**
 * Handle GET /api/sessions/:id/events — creates a session-scoped SSE stream
 * for the companion app to receive turn events (STREAM_DELTA, TURN_COMPLETED,
 * etc.) and agent events from the shared session.
 */
async function handleGetSharedSessionEvents(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  req: Request,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  return context.openSessionEventStream(req, sessionId);
}

async function handlePostSharedSessionSteer(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return Response.json({ error: 'Missing shared session steer body' }, { status: 400 });
  }
  const submission = await context.sessionBroker.steerMessage({
    ...buildSharedSessionMessageInput(sessionId, body, message),
    ...(body.allowSpawnFallback === true ? { allowSpawnFallback: true } : {}),
  });
  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/steer`, 'DaemonServer.handlePostSharedSessionSteer', {
    context: `shared-session:${submission.session.id}`,
  });
}

async function handlePostSharedSessionFollowUp(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return Response.json({ error: 'Missing shared session follow-up body' }, { status: 400 });
  }
  const submission = await context.sessionBroker.followUpMessage(buildSharedSessionMessageInput(sessionId, body, message));
  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/follow-up`, 'DaemonServer.handlePostSharedSessionFollowUp', {
    context: `shared-session:${submission.session.id}`,
  });
}

async function handleCancelSharedSessionInput(context: DaemonRuntimeRouteContext, sessionId: string, inputId: string): Promise<Response> {
  await context.sessionBroker.start();
  const input = await context.sessionBroker.cancelInput(sessionId, inputId);
  if (!input) {
    return Response.json({ error: 'Unknown shared session input' }, { status: 404 });
  }
  // F17: cancelInput returns the entry unchanged when state is not 'queued'.
  // Return 409 so callers know the cancel was a no-op (e.g. already spawned).
  const inputRecord = input as { state?: string };
  if (inputRecord.state !== 'queued' && inputRecord.state !== 'cancelled') {
    return Response.json(
      { error: `Cannot cancel input in state '${inputRecord.state}'`, code: 'CANCEL_NOT_ALLOWED', input },
      { status: 409 },
    );
  }
  return Response.json({ input });
}

function handleGetRuntimeTask(context: DaemonRuntimeRouteContext, taskId: string): Response {
  const task = context.runtimeStore?.getState().tasks.tasks.get(taskId);
  if (!task) {
    return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
  }
  return Response.json({ task });
}

/**
 * Extract the message body from an incoming POST body.
 *
 * F13 normalization: accepts 'body', 'message', and 'text' field names in
 * priority order (newest to legacy). Returns empty string when none are present.
 * The caller must check for an empty result and return 400.
 *
 * @param body - Parsed JSON body from the request.
 * @returns Trimmed message string, or '' if none of the accepted fields are present.
 */
export function readSharedSessionMessageBody(body: JsonBody): string {
  return typeof body.body === 'string'
    ? body.body.trim()
    : typeof body.message === 'string'
      ? body.message.trim()
      : typeof body.text === 'string'
        ? body.text.trim()
        : '';
}

function buildSharedSessionMessageInput(
  sessionId: string,
  body: JsonBody,
  message: string,
): {
  sessionId: string;
  surfaceKind: AutomationSurfaceKind;
  surfaceId: string;
  externalId?: string;
  threadId?: string;
  userId?: string;
  displayName?: string;
  title?: string;
  routeId?: string;
  body: string;
  metadata?: Record<string, unknown>;
  routing?: SharedSessionRoutingIntent;
} {
  return {
    sessionId,
    surfaceKind: typeof body.surfaceKind === 'string' ? body.surfaceKind as AutomationSurfaceKind : 'web',
    surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
    ...(typeof body.externalId === 'string' ? { externalId: body.externalId } : {}),
    ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
    ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
    ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.routeId === 'string' ? { routeId: body.routeId } : {}),
    body: message,
    ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    ...(typeof body.routing === 'object' && body.routing !== null ? { routing: body.routing as SharedSessionRoutingIntent } : {}),
  };
}

async function respondToSessionSubmission(
  context: DaemonRuntimeRouteContext,
  req: Request,
  submission: SessionSubmission,
  taskText: string,
  path: string,
  logLabel: string,
  spawnOptions: {
    readonly context?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly tools?: readonly string[];
    readonly executionIntent?: ExecutionIntent;
  } = {},
): Promise<Response> {
  if (submission.mode === 'continued-live' || submission.mode === 'queued-follow-up') {
    return context.recordApiResponse(req, path, Response.json({
      session: submission.session,
      message: submission.userMessage ?? null,
      input: submission.input,
      mode: submission.mode,
      agentId: submission.activeAgentId ?? null,
    }, { status: 202 }));
  }
  if (submission.mode === 'rejected') {
    return context.recordApiResponse(req, path, Response.json({
      session: submission.session,
      message: submission.userMessage ?? null,
      input: submission.input,
      mode: submission.mode,
    }, { status: 409 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task: submission.task!,
    ...(spawnOptions.context ? { context: spawnOptions.context } : {}),
    ...(spawnOptions.model ?? submission.input.routing?.modelId ? { model: spawnOptions.model ?? submission.input.routing?.modelId } : {}),
    ...(spawnOptions.provider ?? submission.input.routing?.providerId ? { provider: spawnOptions.provider ?? submission.input.routing?.providerId } : {}),
    ...(spawnOptions.tools ?? submission.input.routing?.tools ? { tools: [...(spawnOptions.tools ?? submission.input.routing?.tools ?? [])] } : {}),
    ...(spawnOptions.executionIntent ?? submission.input.routing?.executionIntent
      ? { executionIntent: spawnOptions.executionIntent ?? submission.input.routing?.executionIntent }
      : {}),
  }, logLabel, submission.session.id);
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding, {
    agentId: spawnResult.id,
    task: taskText,
    sessionId: submission.session.id,
  });
  return context.recordApiResponse(req, path, Response.json({
    session: context.sessionBroker.getSession(submission.session.id),
    message: submission.userMessage ?? null,
    input: {
      ...submission.input,
      state: 'spawned',
      activeAgentId: spawnResult.id,
    },
    mode: submission.mode,
    agentId: spawnResult.id,
  }, { status: 202 }));
}

function handleRuntimeTaskAction(context: DaemonRuntimeRouteContext, taskId: string, action: string, _req: Request): Response {
  if (!context.runtimeStore || !context.runtimeDispatch) {
    return Response.json({ error: 'Runtime store unavailable' }, { status: 503 });
  }
  const task = context.runtimeStore.getState().tasks.tasks.get(taskId);
  if (!task) {
    return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
  }
  if (action === 'cancel') {
    if (task.kind === 'agent' && task.owner) {
      context.agentManager.cancel(task.owner);
    }
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'cancelled', {
      endedAt: Date.now(),
      error: 'Cancelled via control plane',
    }, 'daemon.server.tasks.cancel');
    return Response.json({ task: context.runtimeStore.getState().tasks.tasks.get(taskId) });
  }
  if (action === 'retry') {
    if (task.kind !== 'agent') {
      return Response.json({ error: 'Retry is only implemented for agent tasks' }, { status: 400 });
    }
    const spawnResult = context.trySpawnAgent({
      mode: 'spawn',
      task: task.description ?? task.title ?? '',
    }, 'DaemonServer.handleRuntimeTaskAction');
    if (spawnResult instanceof Response) return spawnResult;
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'queued', {
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      result: undefined,
    }, 'daemon.server.tasks.retry');
    return Response.json({
      retried: true,
      task: context.runtimeStore.getState().tasks.tasks.get(taskId),
      agentId: spawnResult.id,
    });
  }
  return Response.json({ error: 'Unsupported task action' }, { status: 400 });
}

function handleGetTaskStatus(context: DaemonRuntimeRouteContext, agentId: string): Response {
  const record = context.agentManager.getStatus(agentId);
  if (!record) {
    return Response.json({ error: `Agent not found: ${agentId}` }, { status: 404 });
  }
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
    context.syncFinishedAgentTask(record);
  }
  const durationMs = record.completedAt !== undefined
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  return Response.json({
    agentId: record.id,
    task: record.task,
    status: record.status,
    model: record.model ?? null,
    tools: record.tools,
    durationMs,
    toolCallCount: record.toolCallCount,
    progress: record.progress ?? null,
    error: record.error ?? null,
  });
}
