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
  readonly sessionId?: string;
}

export interface QueueNtfyChatReplyInput {
  readonly sessionId: string;
  readonly topic: string;
  readonly body: string;
  readonly title?: string;
  readonly messageId: string;
}

export interface NtfyRemoteChatResult {
  readonly sessionId: string;
  readonly messageId: string;
  readonly delivered: boolean;
  readonly error?: string;
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
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'slack' | 'discord' | 'ntfy' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'>;
    userId?: string;
    channelId?: string;
    groupId?: string;
    threadId?: string;
    workspaceId?: string;
    conversationKind?: ChannelConversationKind;
    hasAnyMention?: boolean;
    text?: string;
    controlCommand?: string;
    mentioned?: boolean;
    metadata?: Record<string, unknown>;
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
  readonly queueNtfyChatReply?: (input: QueueNtfyChatReplyInput) => void;
  readonly postNtfyRemoteChatMessage?: (input: {
    readonly topic: string;
    readonly body: string;
    readonly title?: string;
  }) => Promise<NtfyRemoteChatResult>;
}

export interface GenericWebhookReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly callbackUrl?: string;
  readonly callbackCorrelationId?: string;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256';
}

export interface GenericWebhookAdapterContext {
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'webhook'>;
    userId?: string;
    channelId?: string;
    groupId?: string;
    threadId?: string;
    workspaceId?: string;
    conversationKind?: ChannelConversationKind;
    hasAnyMention?: boolean;
    text?: string;
    controlCommand?: string;
    mentioned?: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<ChannelPolicyDecision>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  readonly surfaceDeliveryEnabled: (surface: Extract<AutomationSurfaceKind, 'webhook'>) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly queueWebhookReply: (input: GenericWebhookReplyInput) => void;
}
