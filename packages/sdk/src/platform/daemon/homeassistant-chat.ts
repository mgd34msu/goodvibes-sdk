import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/index.js';
import { HOME_ASSISTANT_SURFACE, HOME_STATE_PROVENANCE_CONTRACT } from '../channels/builtin/homeassistant.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionChatSession, CompanionChatTurnEvent } from '../companion/companion-chat-types.js';
import type { ConfigManager } from '../config/manager.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSpaceInput } from '../knowledge/home-graph/types.js';

/**
 * The narrow read surface the Home Assistant turn consults to ground itself in
 * the pre-registered home-graph knowledge space (HomeGraphService.ask). Kept
 * structural + optional so a runtime without a home graph degrades to today's
 * ungrounded behavior rather than failing.
 */
export interface HomeGraphGroundingReader {
  ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult>;
}

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
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title: string;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly context?: JsonRecord | undefined;
  /**
   * Optional grounding reference — the pre-registered home-graph knowledge
   * space / Home Assistant installation this turn should consult. When present
   * (and a home-graph reader is wired), the turn queries that space and folds
   * the retrieved grounding into its system prompt, closing the
   * index-then-query loop the HA integration already opens by registering and
   * refreshing the graph.
   */
  readonly grounding?: HomeGraphSpaceInput | undefined;
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
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly error?: string | undefined;
}

export interface HomeAssistantChatRuntime {
  readonly configManager: Pick<ConfigManager, 'get'> | ConfigReader;
  readonly routeBindings: RouteBindingsLike;
  readonly chatManager: CompanionChatManager;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /** Optional home-graph reader used to ground a turn against its pre-registered space. */
  readonly homeGraph?: HomeGraphGroundingReader | undefined;
}

export async function postHomeAssistantChatMessage(
  runtime: HomeAssistantChatRuntime,
  input: HomeAssistantChatInput,
  options: {
    readonly wait?: boolean;
    readonly timeoutMs?: number | undefined;
    readonly clientId?: string;
    /** In-process tap for the turn's incremental events, forwarded to the chat
     * manager so a caller (the SSE route) can stream deltas while awaiting the reply. */
    readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
  } = {},
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
    { timeoutMs: options.timeoutMs, ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}) },
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
  const grounding = await resolveHomeGraphGrounding(runtime.homeGraph, input);
  const systemPrompt = buildHomeAssistantSystemPrompt(input, grounding);
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

export function buildHomeAssistantSystemPrompt(input: HomeAssistantChatInput, grounding?: string | undefined): string {
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
    HOME_STATE_PROVENANCE_CONTRACT,
    'For weather questions, first look for Home Assistant weather entities or other relevant sensors before saying live weather is unavailable.',
    'Ask a concise follow-up only when Home Assistant does not expose enough information to answer safely.',
    contextLines.length ? `Home Assistant context:\n${contextLines.join('\n')}` : '',
    grounding ? grounding : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Consult the pre-registered home-graph space for this turn and return a
 * grounding block to fold into the system prompt, or undefined when there is
 * nothing to add (no reader wired, no grounding reference, empty query, an
 * empty/failed answer). Honest: only the graph's own answer text is carried,
 * with its confidence, and any failure degrades to an ungrounded turn rather
 * than breaking the conversation.
 */
async function resolveHomeGraphGrounding(
  reader: HomeGraphGroundingReader | undefined,
  input: HomeAssistantChatInput,
): Promise<string | undefined> {
  if (!reader || !input.grounding || !input.text.trim()) return undefined;
  const hasRef = readString(input.grounding.installationId) !== undefined
    || readString(input.grounding.knowledgeSpaceId) !== undefined;
  if (!hasRef) return undefined;
  try {
    const result = await reader.ask({
      query: input.text,
      mode: 'concise',
      includeSources: false,
      ...(input.grounding.installationId ? { installationId: input.grounding.installationId } : {}),
      ...(input.grounding.knowledgeSpaceId ? { knowledgeSpaceId: input.grounding.knowledgeSpaceId } : {}),
    });
    const answer = result.answer.text.trim();
    if (!answer) return undefined;
    const confidencePct = Math.round(result.answer.confidence * 100);
    return [
      `Home graph grounding (from the pre-registered home knowledge space ${result.spaceId}, confidence ${confidencePct}%):`,
      answer,
      'Treat this grounding as prior knowledge about the home; still verify live device/entity state through Home Assistant tools before acting on it.',
    ].join('\n');
  } catch {
    // Grounding is best-effort — an unreachable/empty graph must never break the turn.
    return undefined;
  }
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
