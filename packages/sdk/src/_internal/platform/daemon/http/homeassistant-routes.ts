import { randomUUID } from 'node:crypto';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { RouteBindingManager } from '../../channels/index.js';
import { HOME_ASSISTANT_SURFACE } from '../../channels/builtin/homeassistant.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SharedSessionBroker, SharedSessionRecord } from '../../control-plane/index.js';
import type { AgentManager, AgentRecord } from '../../tools/agent/index.js';

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REMOTE_SESSION_TTL_MS = 20 * 60_000;

type JsonRecord = Record<string, unknown>;

interface HomeAssistantMessageIndex {
  readonly messageId: string;
  readonly agentId?: string;
  readonly sessionId: string;
  readonly routeId: string;
  readonly conversationId: string;
  readonly createdAt: number;
}

interface HomeAssistantSubmitResult {
  readonly ok: boolean;
  readonly acknowledged: true;
  readonly messageId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly routeId: string;
  readonly agentId?: string;
  readonly mode: 'spawn' | 'continued-live' | 'queued-follow-up' | 'rejected';
  readonly newSession: boolean;
  readonly sessionExpired: boolean;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'timeout';
  readonly assistant?: HomeAssistantAssistantResult;
  readonly timeoutMs?: number;
  readonly error?: string;
}

interface HomeAssistantAssistantResult {
  readonly text: string;
  readonly speechText: string;
  readonly status: string;
  readonly toolCallsMade?: number;
  readonly usage?: AgentRecord['usage'];
  readonly completedAt?: number;
}

interface HomeAssistantRouteContext {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly routeBindings: Pick<RouteBindingManager, 'start' | 'upsertBinding' | 'patchBinding'>;
  readonly sessionBroker: Pick<
    SharedSessionBroker,
    'start' | 'createSession' | 'submitMessage' | 'bindAgent' | 'getSession' | 'closeSession'
  >;
  readonly agentManager: Pick<AgentManager, 'getStatus' | 'cancel'>;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string },
  ) => void;
}

interface ParsedHomeAssistantInput {
  readonly text: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly surfaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly title: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly tools?: readonly string[];
  readonly context?: JsonRecord;
  readonly publishEvent: boolean;
  readonly wait: boolean;
  readonly waitTimeoutMs: number;
  readonly remoteSessionTtlMs: number;
}

export class HomeAssistantConversationRoutes {
  private readonly messageIndex = new Map<string, HomeAssistantMessageIndex>();

  constructor(private readonly context: HomeAssistantRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/homeassistant')) return null;

    if ((url.pathname === '/api/homeassistant' || url.pathname === '/api/homeassistant/health') && req.method === 'GET') {
      return Response.json(this.describeHealth());
    }

    if (url.pathname === '/api/homeassistant/conversation' && req.method === 'POST') {
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      return this.respondToSubmit(await this.submitConversation(body, req.signal));
    }

    if (url.pathname === '/api/homeassistant/conversation/stream' && req.method === 'POST') {
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      return this.streamConversation(body, req.signal);
    }

    if (url.pathname === '/api/homeassistant/conversation/cancel' && req.method === 'POST') {
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      return this.cancelConversation(body);
    }

    return null;
  }

  private describeHealth(): JsonRecord {
    const enabled = Boolean(this.context.configManager.get('surfaces.homeassistant.enabled'));
    return {
      ok: enabled,
      surface: HOME_ASSISTANT_SURFACE,
      enabled,
      defaultConversationId: String(this.context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes'),
      eventType: String(this.context.configManager.get('surfaces.homeassistant.eventType') || 'goodvibes_message'),
      remoteSessionTtlMs: this.readRemoteSessionTtlMs({}),
      endpoints: {
        conversation: '/api/homeassistant/conversation',
        stream: '/api/homeassistant/conversation/stream',
        cancel: '/api/homeassistant/conversation/cancel',
        webhook: '/webhook/homeassistant',
      },
      capabilities: [
        'conversation-submit-wait',
        'conversation-stream',
        'conversation-cancel',
        'stable-correlation',
        'remote-session-ttl',
        'homeassistant-event-delivery',
      ],
    };
  }

  private async submitConversation(body: JsonRecord, signal: AbortSignal): Promise<HomeAssistantSubmitResult> {
    if (!Boolean(this.context.configManager.get('surfaces.homeassistant.enabled'))) {
      return {
        ok: false,
        acknowledged: true,
        messageId: '',
        conversationId: '',
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: 'rejected',
        error: 'Home Assistant surface is disabled.',
      };
    }

    const input = this.parseInput(body);
    if (!input.text) {
      return {
        ok: false,
        acknowledged: true,
        messageId: input.messageId,
        conversationId: input.conversationId,
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: 'rejected',
        error: 'Missing Home Assistant conversation message.',
      };
    }

    await this.context.routeBindings.start();
    await this.context.sessionBroker.start();
    const binding = await this.upsertBinding(input);
    const sessionResolution = await this.resolveRemoteSession(binding, input);
    const routing = this.buildRouting(input);
    const submission = await this.context.sessionBroker.submitMessage({
      sessionId: sessionResolution.session.id,
      routeId: binding.id,
      surfaceKind: HOME_ASSISTANT_SURFACE,
      surfaceId: input.surfaceId,
      externalId: input.conversationId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      title: input.title,
      body: input.text,
      metadata: {
        source: 'homeassistant',
        messageId: input.messageId,
        conversationId: input.conversationId,
        remoteSessionTtlMs: input.remoteSessionTtlMs,
        ...(input.context ? { homeAssistantContext: input.context } : {}),
      },
      ...(routing ? { routing } : {}),
    });

    let agentId = submission.activeAgentId;
    if (submission.mode === 'spawn') {
      const spawnResult = this.context.trySpawnAgent({
        mode: 'spawn',
        task: submission.task!,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.providerId ? { provider: input.providerId } : {}),
        ...(input.tools?.length ? { tools: [...input.tools] } : {}),
        context: `homeassistant:${input.conversationId}`,
      }, 'HomeAssistantConversationRoutes.submitConversation', submission.session.id);
      if (spawnResult instanceof Response) {
        return this.errorFromSpawnResponse(input, sessionResolution, binding, spawnResult);
      }
      agentId = spawnResult.id;
      await this.context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
      if (input.publishEvent) {
        this.context.queueSurfaceReplyFromBinding(binding, {
          agentId: spawnResult.id,
          task: input.text,
          sessionId: submission.session.id,
        });
      }
    }

    this.indexMessage(input, submission.session.id, binding.id, agentId);
    const base = {
      ok: true,
      acknowledged: true as const,
      messageId: input.messageId,
      conversationId: input.conversationId,
      sessionId: submission.session.id,
      routeId: binding.id,
      ...(agentId ? { agentId } : {}),
      mode: submission.mode,
      newSession: sessionResolution.newSession,
      sessionExpired: sessionResolution.sessionExpired,
    };

    if (submission.mode === 'rejected') {
      return { ...base, ok: false, status: 'rejected', error: 'Home Assistant conversation was rejected.' };
    }
    if (!agentId || !input.wait) {
      return { ...base, status: agentId ? 'running' : 'queued' };
    }

    const finalRecord = await this.waitForAgent(agentId, input.waitTimeoutMs, signal);
    if (!finalRecord) {
      return { ...base, status: 'timeout', timeoutMs: input.waitTimeoutMs };
    }
    return {
      ...base,
      status: normalizeAgentStatus(finalRecord.status),
      ok: finalRecord.status === 'completed',
      assistant: buildAssistantResult(finalRecord),
      ...(finalRecord.status !== 'completed' ? { error: finalRecord.error ?? finalRecord.status } : {}),
    };
  }

  private respondToSubmit(result: HomeAssistantSubmitResult): Response {
    if (result.error === 'Home Assistant surface is disabled.') return Response.json(result, { status: 503 });
    if (result.status === 'rejected') return Response.json(result, { status: result.ok ? 202 : 400 });
    if (result.status === 'timeout') return Response.json(result, { status: 202 });
    if (result.status === 'failed') return Response.json(result, { status: 500 });
    if (result.status === 'cancelled') return Response.json(result, { status: 409 });
    return Response.json(result, { status: result.status === 'completed' ? 200 : 202 });
  }

  private streamConversation(body: JsonRecord, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          const result = await this.submitConversation({ ...body, wait: false }, signal);
          send('ack', result);
          if (!result.agentId) {
            send('final', result);
            controller.close();
            return;
          }
          let lastProgress = '';
          for (;;) {
            if (signal.aborted) return;
            const record = this.context.agentManager.getStatus(result.agentId);
            if (!record) {
              send('error', { ...result, ok: false, error: 'Unknown agent.' });
              controller.close();
              return;
            }
            const progress = record.streamingContent ?? record.progress ?? '';
            if (progress && progress !== lastProgress) {
              lastProgress = progress;
              send('progress', { messageId: result.messageId, agentId: result.agentId, text: progress });
            }
            if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
              send('final', {
                ...result,
                ok: record.status === 'completed',
                status: normalizeAgentStatus(record.status),
                assistant: buildAssistantResult(record),
                ...(record.status !== 'completed' ? { error: record.error ?? record.status } : {}),
              });
              controller.close();
              return;
            }
            await delay(250, signal);
          }
        } catch (error) {
          if (!signal.aborted) {
            send('error', { ok: false, error: error instanceof Error ? error.message : String(error) });
            controller.close();
          }
        }
      },
      cancel: () => undefined,
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  private cancelConversation(body: JsonRecord): Response {
    const agentId = readString(body.agentId)
      ?? (readString(body.messageId ?? body.message_id)
        ? this.messageIndex.get(readString(body.messageId ?? body.message_id)!)?.agentId
        : undefined);
    if (!agentId) {
      return Response.json({ ok: false, error: 'agentId or known messageId is required.' }, { status: 400 });
    }
    const cancelled = this.context.agentManager.cancel(agentId);
    return cancelled
      ? Response.json({ ok: true, agentId, status: 'cancelled' })
      : Response.json({ ok: false, agentId, error: 'Unknown or already finished agent.' }, { status: 404 });
  }

  private parseInput(body: JsonRecord): ParsedHomeAssistantInput {
    const threadId = readString(body.threadId ?? body.thread_id);
    const userId = readString(body.userId ?? body.user_id);
    const displayName = readString(body.displayName ?? body.userName ?? body.user_name);
    const providerId = readString(body.providerId ?? body.provider);
    const modelId = readString(body.modelId ?? body.model);
    const tools = readStringList(body.tools);
    const haContext = readRecord(body.context);
    const conversationId = readString(body.conversationId ?? body.conversation_id)
      ?? threadId
      ?? readString(body.deviceId ?? body.device_id)
      ?? String(this.context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes');
    const surfaceId = readString(body.surfaceId ?? body.instanceId ?? body.instance_id)
      ?? readString(body.hassInstanceId ?? body.hass_instance_id)
      ?? 'homeassistant';
    const channelId = readString(body.areaId ?? body.area_id)
      ?? readString(body.entityId ?? body.entity_id)
      ?? conversationId;
    return {
      text: readString(body.body ?? body.message ?? body.text ?? body.prompt ?? body.task) ?? '',
      messageId: readString(body.messageId ?? body.message_id) ?? `ha-${randomUUID()}`,
      conversationId,
      surfaceId,
      channelId,
      ...(threadId ? { threadId } : {}),
      ...(userId ? { userId } : {}),
      ...(displayName ? { displayName } : {}),
      title: readString(body.title) ?? 'Home Assistant',
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(tools.length ? { tools } : {}),
      ...(haContext ? { context: haContext } : {}),
      publishEvent: body.publishEvent === true,
      wait: body.wait !== false,
      waitTimeoutMs: clampNumber(body.timeoutMs ?? body.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 1_000, MAX_WAIT_TIMEOUT_MS),
      remoteSessionTtlMs: this.readRemoteSessionTtlMs(body),
    };
  }

  private async upsertBinding(input: ParsedHomeAssistantInput): Promise<AutomationRouteBinding> {
    return this.context.routeBindings.upsertBinding({
      kind: input.threadId ? 'thread' : 'channel',
      surfaceKind: HOME_ASSISTANT_SURFACE,
      surfaceId: input.surfaceId,
      externalId: input.conversationId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      channelId: input.channelId,
      title: input.title,
      metadata: {
        source: 'homeassistant',
        directoryKind: input.threadId ? 'thread' : 'user',
        messageId: input.messageId,
        conversationId: input.conversationId,
        remoteSessionTtlMs: input.remoteSessionTtlMs,
        ...(input.context ? { homeAssistantContext: input.context } : {}),
      },
    });
  }

  private async resolveRemoteSession(
    binding: AutomationRouteBinding,
    input: ParsedHomeAssistantInput,
  ): Promise<{ readonly session: SharedSessionRecord; readonly newSession: boolean; readonly sessionExpired: boolean }> {
    const now = Date.now();
    const current = binding.sessionId ? this.context.sessionBroker.getSession(binding.sessionId) : null;
    if (current && current.status !== 'closed' && !isExpiredSession(current, input.remoteSessionTtlMs, now)) {
      return { session: current, newSession: false, sessionExpired: false };
    }
    if (current && current.status !== 'closed' && !current.activeAgentId) {
      await this.context.sessionBroker.closeSession(current.id);
    }
    const session = await this.context.sessionBroker.createSession({
      title: input.title,
      metadata: {
        source: 'homeassistant',
        conversationId: input.conversationId,
        remote: true,
        remoteSessionTtlMs: input.remoteSessionTtlMs,
      },
      routeBinding: binding,
      participant: {
        surfaceKind: HOME_ASSISTANT_SURFACE,
        surfaceId: input.surfaceId,
        externalId: input.conversationId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        routeId: binding.id,
        lastSeenAt: now,
      },
      kind: 'homeassistant-remote',
    } as Parameters<SharedSessionBroker['createSession']>[0] & { kind: 'homeassistant-remote' });
    await this.context.routeBindings.patchBinding(binding.id, {
      sessionId: session.id,
      metadata: {
        homeAssistantSessionId: session.id,
        homeAssistantSessionCreatedAt: now,
        remoteSessionTtlMs: input.remoteSessionTtlMs,
      },
    });
    return {
      session,
      newSession: true,
      sessionExpired: Boolean(current),
    };
  }

  private buildRouting(input: ParsedHomeAssistantInput): { providerId?: string; modelId?: string; tools?: readonly string[] } | undefined {
    if (!input.providerId && !input.modelId && !input.tools?.length) return undefined;
    return {
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.tools?.length ? { tools: input.tools } : {}),
    };
  }

  private async waitForAgent(agentId: string, timeoutMs: number, signal: AbortSignal): Promise<AgentRecord | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) return null;
      const record = this.context.agentManager.getStatus(agentId);
      if (record && (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled')) {
        return record;
      }
      await delay(200, signal);
    }
    return null;
  }

  private errorFromSpawnResponse(
    input: ParsedHomeAssistantInput,
    session: { readonly session: SharedSessionRecord; readonly newSession: boolean; readonly sessionExpired: boolean },
    binding: AutomationRouteBinding,
    response: Response,
  ): HomeAssistantSubmitResult {
    return {
      ok: false,
      acknowledged: true,
      messageId: input.messageId,
      conversationId: input.conversationId,
      sessionId: session.session.id,
      routeId: binding.id,
      mode: 'rejected',
      newSession: session.newSession,
      sessionExpired: session.sessionExpired,
      status: 'rejected',
      error: `Agent spawn failed with HTTP ${response.status}.`,
    };
  }

  private indexMessage(
    input: ParsedHomeAssistantInput,
    sessionId: string,
    routeId: string,
    agentId: string | undefined,
  ): void {
    this.messageIndex.set(input.messageId, {
      messageId: input.messageId,
      ...(agentId ? { agentId } : {}),
      sessionId,
      routeId,
      conversationId: input.conversationId,
      createdAt: Date.now(),
    });
    if (this.messageIndex.size > 500) {
      const oldest = [...this.messageIndex.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, 100);
      for (const entry of oldest) this.messageIndex.delete(entry.messageId);
    }
  }

  private readRemoteSessionTtlMs(body: JsonRecord): number {
    return clampNumber(
      body.remoteSessionTtlMs,
      Number(this.context.configManager.get('surfaces.homeassistant.remoteSessionTtlMs') ?? DEFAULT_REMOTE_SESSION_TTL_MS),
      60_000,
      24 * 60 * 60_000,
    );
  }
}

function isExpiredSession(session: SharedSessionRecord, ttlMs: number, now: number): boolean {
  if (session.activeAgentId) return false;
  return now - session.lastActivityAt > ttlMs;
}

function buildAssistantResult(record: AgentRecord): HomeAssistantAssistantResult {
  const text = record.status === 'completed'
    ? (record.fullOutput ?? record.streamingContent ?? record.progress ?? 'Completed')
    : record.error ?? record.status;
  return {
    text,
    speechText: text,
    status: record.status,
    toolCallsMade: record.toolCallCount,
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}

function normalizeAgentStatus(status: AgentRecord['status']): HomeAssistantSubmitResult['status'] {
  if (status === 'pending' || status === 'running') return 'running';
  return status;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function readRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
