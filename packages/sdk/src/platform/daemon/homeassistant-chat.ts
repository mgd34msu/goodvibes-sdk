import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/index.js';
import { HOME_ASSISTANT_SURFACE } from '../channels/builtin/homeassistant.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionChatSession } from '../companion/companion-chat-types.js';
import type { ConfigManager } from '../config/manager.js';

export const HOME_ASSISTANT_DEFAULT_REMOTE_SESSION_TTL_MS = 20 * 60_000;
const MIN_REMOTE_SESSION_TTL_MS = 60_000;
const MAX_REMOTE_SESSION_TTL_MS = 24 * 60 * 60_000;

type JsonRecord = Record<string, unknown>;

interface RouteBindingsLike {
  readonly start: RouteBindingManager['start'];
  readonly upsertBinding: RouteBindingManager['upsertBinding'];
  readonly patchBinding: RouteBindingManager['patchBinding'];
}

interface ConfigReader {
  get(key: string): unknown;
}

export interface HomeAssistantChatInput {
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
  readonly remoteSessionTtlMs: number;
}

export interface HomeAssistantChatResolution {
  readonly binding: AutomationRouteBinding;
  readonly session: CompanionChatSession;
  readonly newSession: boolean;
  readonly sessionExpired: boolean;
}

export interface HomeAssistantChatPostResult extends HomeAssistantChatResolution {
  readonly messageId: string;
  readonly assistantMessageId?: string;
  readonly response?: string;
  readonly error?: string;
}

export interface HomeAssistantChatRuntime {
  readonly configManager: Pick<ConfigManager, 'get'> | ConfigReader;
  readonly routeBindings: RouteBindingsLike;
  readonly chatManager: CompanionChatManager;
  readonly resolveDefaultProviderModel?: () => { provider: string; model: string } | null;
}

export async function postHomeAssistantChatMessage(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
  options: { readonly wait?: boolean; readonly timeoutMs?: number; readonly clientId?: string } = {},
): Promise<HomeAssistantChatPostResult> {
  const resolution = await resolveHomeAssistantChatSession(runtime, input);
  const clientId = options.clientId ?? `homeassistant:${input.surfaceId}:${input.conversationId}`;
  if (options.wait === false) {
    const messageId = await runtime.chatManager.postMessage(resolution.session.id, formatHomeAssistantUserMessage(input), clientId);
    return { ...resolution, messageId };
  }
  const reply = await runtime.chatManager.postMessageAndWaitForReply(
    resolution.session.id,
    formatHomeAssistantUserMessage(input),
    clientId,
    { timeoutMs: options.timeoutMs },
  );
  return {
    ...resolution,
    messageId: reply.messageId,
    ...(reply.assistantMessageId ? { assistantMessageId: reply.assistantMessageId } : {}),
    ...(reply.response ? { response: reply.response } : {}),
    ...(reply.error ? { error: reply.error } : {}),
  };
}

export async function resolveHomeAssistantChatSession(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
): Promise<HomeAssistantChatResolution> {
  await runtime.chatManager.init();
  await runtime.routeBindings.start();
  const binding = await runtime.routeBindings.upsertBinding({
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

  const now = Date.now();
  const existingSessionId = readString(binding.metadata.homeAssistantChatSessionId);
  const existing = existingSessionId ? runtime.chatManager.getSession(existingSessionId) : null;
  const expired = Boolean(existing && existing.status !== 'closed' && now - existing.updatedAt > input.remoteSessionTtlMs);
  if (expired && existing) {
    runtime.chatManager.closeSession(existing.id);
  }

  const defaultProviderModel = runtime.resolveDefaultProviderModel?.() ?? null;
  const provider = input.providerId ?? defaultProviderModel?.provider;
  const model = input.modelId ?? defaultProviderModel?.model;
  const systemPrompt = buildHomeAssistantSystemPrompt(input);
  const shouldCreate = !existing || existing.status === 'closed' || expired;
  const session = shouldCreate
    ? runtime.chatManager.createSession({
        title: input.title || 'Home Assistant',
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        systemPrompt,
      })
    : runtime.chatManager.updateSession(existing.id, {
        title: input.title || existing.title,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        systemPrompt,
      });

  await runtime.routeBindings.patchBinding(binding.id, {
    sessionId: null,
    jobId: null,
    runId: null,
    metadata: {
      homeAssistantChatSessionId: session.id,
      homeAssistantChatSessionUpdatedAt: now,
      remoteSessionTtlMs: input.remoteSessionTtlMs,
    },
  });

  return {
    binding,
    session,
    newSession: shouldCreate,
    sessionExpired: expired,
  };
}

export function readHomeAssistantRemoteSessionTtlMs(
  configManager: ConfigReader,
  value: unknown,
): number {
  return clampNumber(
    value,
    Number(configManager.get('surfaces.homeassistant.remoteSessionTtlMs') ?? HOME_ASSISTANT_DEFAULT_REMOTE_SESSION_TTL_MS),
    MIN_REMOTE_SESSION_TTL_MS,
    MAX_REMOTE_SESSION_TTL_MS,
  );
}

function buildHomeAssistantSystemPrompt(input: HomeAssistantChatInput): string {
  const contextLines = [
    `Conversation id: ${input.conversationId}`,
    `Surface id: ${input.surfaceId}`,
    input.channelId ? `Area/entity channel: ${input.channelId}` : '',
    input.userId ? `Home Assistant user id: ${input.userId}` : '',
    input.displayName ? `Home Assistant display name: ${input.displayName}` : '',
  ].filter(Boolean);
  return [
    'You are GoodVibes responding inside Home Assistant.',
    'Answer as a normal assistant. Do not emit JSON summaries, WRFC summaries, agent reports, changelogs, or engineering-stage output.',
    'Use Home Assistant tools whenever the user asks about devices, entities, rooms, services, automations, templates, or current home state.',
    'For weather questions, first look for Home Assistant weather entities or other relevant sensors before saying live weather is unavailable.',
    'Ask a concise follow-up only when Home Assistant does not expose enough information to answer safely.',
    contextLines.length ? `Home Assistant context:\n${contextLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function formatHomeAssistantUserMessage(input: HomeAssistantChatInput): string {
  const metadata = {
    source: 'homeassistant',
    messageId: input.messageId,
    conversationId: input.conversationId,
    surfaceId: input.surfaceId,
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
  return [
    input.text,
    `Home Assistant metadata: ${JSON.stringify(metadata)}`,
  ].join('\n\n');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
