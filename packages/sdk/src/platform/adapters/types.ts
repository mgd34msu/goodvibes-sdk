import type { AgentManager } from '../tools/agent/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { ChannelConversationKind, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';

export interface SurfaceControlCommand {
  readonly action: 'status' | 'cancel' | 'retry';
  readonly id: string;
}

export interface QueueSurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly workflowChainId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface QueueNtfyChatReplyInput {
  readonly sessionId: string;
  readonly topic: string;
  readonly body: string;
  readonly title?: string | undefined;
  readonly messageId: string;
}

export interface NtfyRemoteChatResult {
  readonly sessionId: string;
  readonly messageId: string;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

export interface HomeAssistantRemoteChatResult {
  readonly sessionId: string;
  readonly routeId?: string | undefined;
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

export type TrySpawnAgentInput = Parameters<AgentManager['spawn']>[0];
export type TrySpawnAgentResult = AgentRecord | Response;
export type TrySpawnAgentFn = (
  input: TrySpawnAgentInput,
  logLabel: string,
  sessionId?: string,
) => TrySpawnAgentResult;

export interface SurfaceAdapterContext {
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'slack' | 'discord' | 'ntfy' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'>;
    userId?: string | undefined;
    channelId?: string | undefined;
    groupId?: string | undefined;
    threadId?: string | undefined;
    workspaceId?: string | undefined;
    conversationKind?: ChannelConversationKind | undefined;
    hasAnyMention?: boolean | undefined;
    text?: string | undefined;
    controlCommand?: string | undefined;
    mentioned?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<ChannelPolicyDecision>;
  readonly parseSurfaceControlCommand: (text: string) => SurfaceControlCommand | null;
  readonly performSurfaceControlCommand: (command: SurfaceControlCommand) => Promise<string>;
  readonly performInteractiveSurfaceAction: (
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
  ) => Promise<string>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: QueueSurfaceReplyInput,
  ) => void;
  readonly publishConversationFollowup?: (
    sessionId: string,
    envelope: Omit<ConversationMessageEnvelope, 'sessionId'>,
  ) => void;
  readonly queueNtfyChatReply?: ((input: QueueNtfyChatReplyInput) => void) | undefined;
  readonly postNtfyRemoteChatMessage?: (input: {
    readonly topic: string;
    readonly body: string;
    readonly title?: string | undefined;
  }) => Promise<NtfyRemoteChatResult>;
  readonly postHomeAssistantChatMessage?: (input: {
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
  }) => Promise<HomeAssistantRemoteChatResult>;
}

export interface GenericWebhookReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackCorrelationId?: string | undefined;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256' | undefined;
}

export interface GenericWebhookAdapterContext {
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'webhook'>;
    userId?: string | undefined;
    channelId?: string | undefined;
    groupId?: string | undefined;
    threadId?: string | undefined;
    workspaceId?: string | undefined;
    conversationKind?: ChannelConversationKind | undefined;
    hasAnyMention?: boolean | undefined;
    text?: string | undefined;
    controlCommand?: string | undefined;
    mentioned?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<ChannelPolicyDecision>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  readonly surfaceDeliveryEnabled: (surface: Extract<AutomationSurfaceKind, 'webhook'>) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly queueWebhookReply: (input: GenericWebhookReplyInput) => void;
}
