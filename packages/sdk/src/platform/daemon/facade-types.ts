/**
 * Shared type definitions for the daemon facade layer.
 *
 * Split from facade-composition.ts to keep runtime wiring logic separate
 * from the type contracts that describe it. Importers that only need the
 * types import from here; facade-composition.ts imports these contracts for
 * runtime assembly.
 */
import type { AgentManager } from '../tools/agent/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { UserAuthManager } from '../security/user-auth.js';
import type { AutomationDeliveryManager, AutomationManager } from '../automation/index.js';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { GatewayMethodCatalog } from '../control-plane/index.js';
import type {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
} from '../channels/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { PlatformServiceManager } from './service-manager.js';
import type { WatcherRegistry } from '../watchers/index.js';
import type { DistributedPeerAuth } from '../runtime/remote/index.js';
import type { HomeGraphService, KnowledgeGraphqlService, KnowledgeService, ProjectPlanningService } from '../knowledge/index.js';
import type { IntegrationHelperService } from '../runtime/integration/helpers.js';
import type { DaemonControlPlaneHelper } from './control-plane.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import type { DaemonSurfaceActionHelper } from './surface-actions.js';
import type { DaemonTransportEventsHelper } from './transport-events.js';
import type { DaemonHttpRouter } from './http/router.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { RuntimeServices } from '../runtime/services.js';
import type { PendingSurfaceReply } from './types.js';
import type { ResolvedInboundTlsContext } from '../runtime/network/index.js';

export interface ResolvedDaemonFacadeRuntime {
  readonly configManager: ConfigManager;
  readonly runtimeServices: RuntimeServices;
  readonly integrationHelpers: IntegrationHelperService;
  readonly port: number;
  readonly host: string;
  readonly agentManager: AgentManager;
  readonly userAuth: UserAuthManager;
  readonly automationManager: AutomationManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeServices['runtimeStore'];
  readonly runtimeDispatch: RuntimeServices['runtimeDispatch'];
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly sessionBroker: SharedSessionBroker;
  readonly approvalBroker: ApprovalBroker;
  readonly routeBindings: RouteBindingManager;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly watcherRegistry: WatcherRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  readonly voiceService: RuntimeServices['voiceService'];
  readonly webSearchService: RuntimeServices['webSearchService'];
  readonly knowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: RuntimeServices['mediaProviders'];
  readonly multimodalService: RuntimeServices['multimodalService'];
  readonly artifactStore: RuntimeServices['artifactStore'];
  readonly serviceRegistry: ServiceRegistry;
  readonly serveFactory: typeof Bun.serve;
  readonly githubWebhookSecret: string | null;
  readonly companionChatManager: CompanionChatManager;
}

export interface DaemonFacadeCollaborators {
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly controlPlaneHelper: DaemonControlPlaneHelper;
  readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
  readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  readonly transportEventsHelper: DaemonTransportEventsHelper;
  readonly httpRouter: DaemonHttpRouter;
  readonly providerRuntime: ChannelProviderRuntimeManager;
  readonly builtinChannels: BuiltinChannelRuntime;
}

type JsonBody = Record<string, unknown>;

export interface CreateDaemonFacadeCollaboratorsOptions {
  readonly runtime: ResolvedDaemonFacadeRuntime;
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly authToken: () => string | null;
  readonly trustProxyEnabled: () => boolean;
  readonly dispatchApiRoutes: (req: Request) => Promise<Response | null>;
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.js').AgentRecord | Response;
  readonly checkAuth: (req: Request) => boolean;
  readonly extractAuthToken: (req: Request) => string;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly describeAuthenticatedPrincipal: (token: string) => {
    principalId: string;
    principalKind: 'user' | 'bot' | 'service' | 'token';
    admin: boolean;
    scopes: readonly string[];
  } | null;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalId?: string | undefined;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly clientKind?: string | undefined;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly syncSpawnedAgentTask: (record: import('../tools/agent/index.js').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../tools/agent/index.js').AgentRecord) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (approvalId: string, action: 'claim' | 'approve' | 'deny' | 'cancel', req: Request) => Promise<Response>;
  readonly tlsState: () => ResolvedInboundTlsContext | null;
  /**
   * WorkspaceSwapManager instance, forwarded from DaemonConfig.swapManager.
   * Null in embedded/test contexts that don't support live workspace swaps.
   */
  readonly swapManager: import('./http/system-route-types.js').WorkspaceSwapManagerLike | null;
  /** Resolve the current provider/model for companion-chat session creation. */
  readonly resolveDefaultProviderModel?: () => { provider: string; model: string } | null;
}
