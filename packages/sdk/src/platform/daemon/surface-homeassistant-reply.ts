/**
 * surface-homeassistant-reply.ts, the Home Assistant half of the daemon's
 * surface actions: run a chat turn for an inbound HA message and publish the
 * assistant's reply back as a Home Assistant event.
 *
 * Split out of `surface-actions.ts`, which had reached the 800-line source cap
 * exactly. This is the largest coherent piece of that file that is about ONE
 * surface rather than about surface actions in general, everything left behind
 * (the ingress hook, control commands, interactive actions, the ntfy pending-
 * reply machinery) is either shared across surfaces or genuinely ntfy-specific
 * state held on the helper instance. Moving it took the file from 799 lines to
 * well under the cap, which is why the card gate could be installed on
 * `authorizeSurfaceIngress` without grandfathering a file over the limit.
 *
 * Behaviour is unchanged from the methods it replaces: the helper keeps thin
 * delegating methods so the adapter-context surface is identical.
 */
import {
  HOME_ASSISTANT_DEFAULT_EVENT_TYPE,
  resolveHomeAssistantAccessToken,
  resolveHomeAssistantBaseUrl,
} from '../channels/builtin/homeassistant.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import { HomeAssistantIntegration } from '../integrations/homeassistant.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import {
  postHomeAssistantChatMessage as postHomeAssistantChatTurn,
  readHomeAssistantRemoteSessionTtlMs,
} from './homeassistant-chat.js';

/** The slice of the daemon surface-action context this module consults. */
export interface HomeAssistantReplyDeps {
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly companionChatManager: CompanionChatManager | null;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
}

export interface HomeAssistantSurfaceChatInput {
  readonly body: string;
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
  readonly context?: Record<string, unknown> | undefined;
  readonly remoteSessionTtlMs?: number | undefined;
  readonly publishEvent?: boolean | undefined;
}

export interface HomeAssistantSurfaceChatResult {
  readonly sessionId: string;
  readonly routeId?: string | undefined;
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

/** Run one inbound Home Assistant message as a chat turn and publish the reply. */
export async function postHomeAssistantSurfaceChatMessage(
  deps: HomeAssistantReplyDeps,
  input: HomeAssistantSurfaceChatInput,
): Promise<HomeAssistantSurfaceChatResult> {
  const manager = deps.companionChatManager;
  if (!manager) {
    return {
      sessionId: '',
      messageId: input.messageId,
      delivered: false,
      error: 'Home Assistant remote chat manager is unavailable',
    };
  }

  try {
    const result = await postHomeAssistantChatTurn(
      {
        configManager: deps.configManager,
        routeBindings: deps.routeBindings,
        chatManager: manager,
        resolveDefaultProviderModel: deps.resolveDefaultProviderModel,
      },
      {
        text: input.body,
        messageId: input.messageId,
        conversationId: input.conversationId,
        surfaceId: input.surfaceId,
        channelId: input.channelId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        title: input.title,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.context ? { context: input.context } : {}),
        remoteSessionTtlMs: readHomeAssistantRemoteSessionTtlMs(deps.configManager, input.remoteSessionTtlMs),
      },
      {
        wait: true,
        timeoutMs: 120_000,
        clientId: `homeassistant:${input.surfaceId}:${input.conversationId}`,
      },
    );
    const response = result.response?.trim();
    const error = result.error ?? (response ? undefined : 'No response from Home Assistant remote chat');
    if (input.publishEvent !== false) {
      await publishHomeAssistantChatReply(deps, input, {
        sessionId: result.session.id,
        routeId: result.binding.id,
        assistantMessageId: result.assistantMessageId,
        response: response || `Error: ${error}`,
        status: error ? 'failed' : 'completed',
      });
    }
    return {
      sessionId: result.session.id,
      routeId: result.binding.id,
      messageId: input.messageId,
      ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
      ...(response ? { response } : {}),
      delivered: !error,
      ...(error ? { error } : {}),
    };
  } catch (error) {
    const errorMessage = summarizeError(error);
    if (input.publishEvent !== false) {
      try {
        await publishHomeAssistantChatReply(deps, input, {
          sessionId: '',
          response: `Error: ${errorMessage}`,
          status: 'failed',
        });
      } catch (publishError) {
        logger.warn('DaemonSurfaceActionHelper: failed to publish Home Assistant chat error', {
          conversationId: input.conversationId,
          error: summarizeError(publishError),
        });
      }
    }
    return {
      sessionId: '',
      messageId: input.messageId,
      delivered: false,
      error: errorMessage,
    };
  }
}

/** Publish the assistant's reply back to Home Assistant as a GoodVibes event. */
export async function publishHomeAssistantChatReply(
  deps: HomeAssistantReplyDeps,
  input: Pick<
    HomeAssistantSurfaceChatInput,
    'body' | 'messageId' | 'conversationId' | 'surfaceId' | 'channelId' | 'threadId' | 'userId' | 'displayName' | 'title' | 'context'
  >,
  result: {
    readonly sessionId: string;
    readonly routeId?: string | undefined;
    readonly assistantMessageId?: string | undefined;
    readonly response: string;
    readonly status: string;
  },
): Promise<void> {
  const baseUrl = resolveHomeAssistantBaseUrl(deps.configManager, deps.serviceRegistry);
  const accessToken = await resolveHomeAssistantAccessToken(deps);
  if (!baseUrl || !accessToken) {
    throw new Error('Home Assistant instance URL or access token is not configured.');
  }
  const eventType = String(deps.configManager.get('surfaces.homeassistant.eventType') || HOME_ASSISTANT_DEFAULT_EVENT_TYPE);
  const client = new HomeAssistantIntegration({ baseUrl, accessToken });
  await client.publishGoodVibesEvent(eventType, {
    type: 'message',
    title: input.title || 'GoodVibes',
    body: result.response,
    speechText: result.response,
    status: result.status,
    sessionId: result.sessionId,
    ...(result.routeId ? { routeId: result.routeId } : {}),
    surfaceId: input.surfaceId,
    externalId: input.conversationId,
    ...(result.assistantMessageId ? { messageId: result.assistantMessageId } : {}),
    replyToMessageId: input.messageId,
    conversationId: input.conversationId,
    metadata: {
      threadId: input.threadId ?? null,
      channelId: input.channelId,
      userId: input.userId ?? null,
      displayName: input.displayName ?? null,
      inboundMessageId: input.messageId,
      conversationId: input.conversationId,
      ...(input.context ? { homeAssistantContext: input.context } : {}),
    },
  });
}
