import { randomUUID } from 'node:crypto';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import { HOME_ASSISTANT_SURFACE } from '../../channels/builtin/homeassistant.js';
import type { RouteBindingManager } from '../../channels/index.js';
import type { CompanionChatManager } from '../../companion/companion-chat-manager.js';
import type { ConfigManager } from '../../config/manager.js';
import {
  postHomeAssistantChatMessage,
  readHomeAssistantRemoteSessionTtlMs,
  type HomeAssistantChatInput,
  type HomeAssistantChatPostResult,
} from '../homeassistant-chat.js';

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;

type JsonRecord = Record<string, unknown>;

interface HomeAssistantMessageIndex {
  readonly messageId: string;
  readonly assistantMessageId?: string;
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
  readonly mode: 'remote-chat' | 'rejected';
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
  readonly completedAt?: number;
}

interface HomeAssistantRouteContext {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly routeBindings: Pick<RouteBindingManager, 'start' | 'upsertBinding' | 'patchBinding'>;
  readonly chatManager: CompanionChatManager;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly resolveDefaultProviderModel?: () => { provider: string; model: string } | null;
}

interface ParsedHomeAssistantInput extends HomeAssistantChatInput {
  readonly publishEvent: boolean;
  readonly wait: boolean;
  readonly waitTimeoutMs: number;
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
      return this.respondToSubmit(await this.submitConversation(body));
    }

    if (url.pathname === '/api/homeassistant/conversation/stream' && req.method === 'POST') {
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      return this.streamConversation(body);
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
        'isolated-remote-chat-session',
        'remote-session-ttl',
        'homeassistant-event-delivery',
      ],
    };
  }

  private async submitConversation(body: JsonRecord): Promise<HomeAssistantSubmitResult> {
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

    let posted: HomeAssistantChatPostResult;
    try {
      posted = await postHomeAssistantChatMessage(
        {
          configManager: this.context.configManager,
          routeBindings: this.context.routeBindings,
          chatManager: this.context.chatManager,
          resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
        },
        input,
        {
          wait: input.wait,
          timeoutMs: input.waitTimeoutMs,
          clientId: `homeassistant:${input.surfaceId}:${input.conversationId}`,
        },
      );
    } catch (error) {
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
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.indexMessage(input, posted);
    const base = {
      ok: true,
      acknowledged: true as const,
      messageId: input.messageId,
      conversationId: input.conversationId,
      sessionId: posted.session.id,
      routeId: posted.binding.id,
      mode: 'remote-chat' as const,
      newSession: posted.newSession,
      sessionExpired: posted.sessionExpired,
    };

    if (!input.wait) {
      return { ...base, status: 'running' };
    }
    if (posted.error) {
      const timedOut = posted.error.toLowerCase().includes('timed out');
      return {
        ...base,
        ok: false,
        status: timedOut ? 'timeout' : 'failed',
        ...(timedOut ? { timeoutMs: input.waitTimeoutMs } : {}),
        error: posted.error,
      };
    }
    return {
      ...base,
      status: 'completed',
      assistant: buildAssistantResult(posted.response ?? ''),
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

  private streamConversation(body: JsonRecord): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          const result = await this.submitConversation({ ...body, wait: true });
          send(result.status === 'completed' ? 'final' : 'error', result);
          controller.close();
        } catch (error) {
          send('error', { ok: false, error: error instanceof Error ? error.message : String(error) });
          controller.close();
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
    const indexed = readString(body.messageId ?? body.message_id)
      ? this.messageIndex.get(readString(body.messageId ?? body.message_id)!)
      : undefined;
    const sessionId = readString(body.sessionId ?? body.session_id) ?? indexed?.sessionId;
    if (!sessionId) {
      return Response.json({ ok: false, error: 'sessionId or known messageId is required.' }, { status: 400 });
    }
    const session = this.context.chatManager.closeSession(sessionId);
    return session
      ? Response.json({ ok: true, sessionId, status: 'cancelled' })
      : Response.json({ ok: false, sessionId, error: 'Unknown Home Assistant chat session.' }, { status: 404 });
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

  private indexMessage(input: ParsedHomeAssistantInput, posted: HomeAssistantChatPostResult): void {
    this.messageIndex.set(input.messageId, {
      messageId: input.messageId,
      ...(posted.assistantMessageId ? { assistantMessageId: posted.assistantMessageId } : {}),
      sessionId: posted.session.id,
      routeId: posted.binding.id,
      conversationId: input.conversationId,
      createdAt: Date.now(),
    });
    if (this.messageIndex.size > 500) {
      const oldest = [...this.messageIndex.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, 100);
      for (const entry of oldest) this.messageIndex.delete(entry.messageId);
    }
  }

  private readRemoteSessionTtlMs(body: JsonRecord): number {
    return readHomeAssistantRemoteSessionTtlMs(this.context.configManager, body.remoteSessionTtlMs);
  }
}

function buildAssistantResult(text: string): HomeAssistantAssistantResult {
  return {
    text,
    speechText: text,
    status: 'completed',
    completedAt: Date.now(),
  };
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
