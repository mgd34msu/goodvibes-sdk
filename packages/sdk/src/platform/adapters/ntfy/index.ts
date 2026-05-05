import { randomUUID } from 'node:crypto';
import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '../helpers.js';
import type { SurfaceAdapterContext } from '../types.js';
import {
  isGoodVibesNtfyDeliveryEcho,
  resolveGoodVibesNtfyTopics,
} from '../../integrations/ntfy.js';

export async function handleNtfySurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const enabled = Boolean(context.configManager.get('surfaces.ntfy.enabled'));
  const configuredToken =
    String(context.configManager.get('surfaces.ntfy.token') ?? '')
    || await context.serviceRegistry.resolveSecret('ntfy', 'primary')
    || process.env.NTFY_ACCESS_TOKEN
    || '';
  if (!enabled || !configuredToken) {
    return Response.json({ error: 'ntfy webhook ingress is not configured' }, { status: 503 });
  }
  const providedToken = req.headers.get('x-ntfy-token')
    ?? readBearerOrHeaderToken(req, 'x-goodvibes-ntfy-token')
    ?? '';
  if (!constantTimeEquals(configuredToken, providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed = parseJsonRecord(rawBody);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else if (rawBody.trim().length > 0) {
    body = { message: rawBody.trim() };
  }

  return handleNtfySurfacePayload(body, context, new URL(req.url));
}

export async function handleNtfySurfacePayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  url?: URL,
): Promise<Response> {
  if (isGoodVibesNtfyDeliveryEcho(body)) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'goodvibes-self-echo',
      ignored: 'goodvibes-self-echo',
    });
  }
  const topic = typeof body.topic === 'string'
    ? body.topic
    : url?.searchParams.get('topic') ?? '';
  const message = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : '';
  if (!topic) {
    return Response.json({ error: 'Missing ntfy topic' }, { status: 400 });
  }
  const topics = resolveConfiguredNtfyTopics(context);
  if (topic === topics.chatTopic) {
    return handleNtfyChatPayload(body, context, topic, message);
  }
  if (topic === topics.remoteTopic) {
    return handleNtfyRemoteChatPayload(body, context, topic, message);
  }
  if (topic !== topics.agentTopic) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unknown-ntfy-topic',
      ignored: 'unknown-ntfy-topic',
      topic,
    });
  }
  return handleNtfyAgentPayload(body, context, topic, message);
}

function resolveConfiguredNtfyTopics(context: SurfaceAdapterContext) {
  return resolveGoodVibesNtfyTopics({
    chatTopic: readConfigString(context, 'surfaces.ntfy.chatTopic'),
    agentTopic: readConfigString(context, 'surfaces.ntfy.agentTopic'),
    remoteTopic: readConfigString(context, 'surfaces.ntfy.remoteTopic'),
  });
}

function readConfigString(context: SurfaceAdapterContext, key: string): string {
  const value = context.configManager.get(key);
  return typeof value === 'string' ? value : '';
}

async function authorizeNtfyPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response | null> {
  const policy = await context.authorizeSurfaceIngress({
    surface: 'ntfy',
    channelId: topic,
    groupId: topic,
    conversationKind: 'channel',
    text: message,
    mentioned: true,
    metadata: body,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }
  return null;
}

async function handleNtfyChatPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      topic,
    });
  }
  if (!context.publishConversationFollowup) {
    return Response.json({ error: 'ntfy chat routing is unavailable in this runtime' }, { status: 503 });
  }
  const session = await findPreferredTuiSession(context);
  if (!session) {
    return Response.json({ error: 'No active terminal TUI session is available for ntfy chat' }, { status: 409 });
  }
  const messageId = randomUUID();
  const timestamp = Date.now();
  await context.sessionBroker.appendCompanionMessage(session.id, {
    messageId,
    body: message,
    source: 'ntfy-chat',
    timestamp,
  });
  context.queueNtfyChatReply?.({
    sessionId: session.id,
    topic,
    body: message,
    title: typeof body.title === 'string' ? body.title : 'GoodVibes chat',
    messageId,
  });
  context.publishConversationFollowup(session.id, {
    messageId,
    body: message,
    source: 'ntfy-chat',
    timestamp,
    metadata: { surface: 'ntfy', topic, ntfyMessageId: messageId },
  });
  return Response.json({
    acknowledged: true,
    queued: false,
    routedTo: 'tui-chat',
    sessionId: session.id,
    messageId,
    topic,
  }, { status: 202 });
}

async function handleNtfyRemoteChatPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      topic,
    });
  }
  if (!context.postNtfyRemoteChatMessage) {
    return Response.json({ error: 'ntfy remote chat is unavailable in this runtime' }, { status: 503 });
  }
  const result = await context.postNtfyRemoteChatMessage({
    topic,
    body: message,
    title: typeof body.title === 'string' ? body.title : 'GoodVibes ntfy',
  });
  return Response.json({
    acknowledged: true,
    queued: false,
    routedTo: 'ntfy-remote-chat',
    ...result,
    topic,
  }, { status: result.error ? 502 : 202 });
}

async function handleNtfyAgentPayload(
  body: Record<string, unknown>,
  context: SurfaceAdapterContext,
  topic: string,
  message: string,
): Promise<Response> {
  const denied = await authorizeNtfyPayload(body, context, topic, message);
  if (denied) return denied;
  const preferredTuiSession = await findPreferredTuiSession(context);

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'ntfy',
    surfaceId: 'ntfy',
    externalId: topic,
    channelId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    metadata: body,
  });

  if (!message) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
      topic,
    });
  }

  const submission = await context.sessionBroker.submitMessage({
    ...(preferredTuiSession ? { sessionId: preferredTuiSession.id } : {}),
    routeId: binding.id,
    surfaceKind: 'ntfy',
    surfaceId: binding.surfaceId,
    externalId: topic,
    threadId: topic,
    title: typeof body.title === 'string' ? body.title : topic,
    body: message,
    metadata: body,
  });
  if (submission.mode === 'continued-live') {
    return Response.json({
      acknowledged: true,
      queued: true,
      continued: true,
      bindingId: binding.id,
      sessionId: submission.session.id,
      agentId: submission.activeAgentId,
    });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleNtfySurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: message,
    ...(typeof submission.task === 'string' && submission.task.length > 0 ? { agentTask: submission.task } : {}),
    ...(typeof spawnResult.wrfcId === 'string' && spawnResult.wrfcId.length > 0 ? { workflowChainId: spawnResult.wrfcId } : {}),
    sessionId: submission.session.id,
  });
  return Response.json({
    acknowledged: true,
    queued: true,
    bindingId: binding.id,
    topic,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}

async function findPreferredTuiSession(context: SurfaceAdapterContext) {
  const direct = await context.sessionBroker.findPreferredSession({ surfaceKind: 'tui' });
  if (direct) return direct;
  return context.sessionBroker
    .listSessions(500)
    .find((candidate) => candidate.status !== 'closed' && candidate.metadata?.source === 'tui')
    ?? null;
}
