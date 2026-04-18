import { AgentManager } from '../tools/agent/index.js';
import { resolveHostBinding } from './host-resolver.js';
import { ConfigManager } from '../config/manager.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { UserAuthManager } from '../security/user-auth.js';
import {
  AutomationDeliveryManager,
  AutomationManager,
} from '../automation/index.js';
import { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import { GatewayMethodCatalog } from '../control-plane/index.js';
import {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
} from '../channels/index.js';
import { RuntimeEventBus } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { PlatformServiceManager } from './service-manager.js';
import { WatcherRegistry } from '../watchers/index.js';
import { type DistributedPeerAuth } from '../runtime/remote/index.js';
import { KnowledgeGraphqlService, KnowledgeService } from '../knowledge/index.js';
import type { IntegrationHelperService } from '../runtime/integration/helpers.js';
import { DaemonControlPlaneHelper } from './control-plane.js';
import { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import { DaemonSurfaceActionHelper } from './surface-actions.js';
import { DaemonTransportEventsHelper } from './transport-events.js';
import { DaemonHttpRouter } from './http/router.js';
import { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionLLMProvider, CompanionProviderChunk } from '../companion/companion-chat-manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import type { DaemonConfig, PendingSurfaceReply } from './types.js';
import type { ResolvedInboundTlsContext } from '../runtime/network/index.js';

type JsonBody = Record<string, unknown>;

/**
 * Creates the CompanionLLMProvider adapter that bridges the daemon's
 * ProviderRegistry (chat-based) to the queue-driven async-generator interface
 * expected by CompanionChatManager.
 *
 * Extracted for testability: the adapter can be unit-tested in isolation
 * without constructing a full daemon facade.
 *
 * Error handling:
 * - If no provider is configured or the model is unavailable, the adapter
 *   immediately yields `{ type: 'error', error: 'No provider available ...' }`
 *   and returns. This is a graceful degradation — the companion chat session
 *   receives a structured error rather than an unhandled exception.
 * - If the underlying provider.chat() rejects mid-stream, the error is
 *   caught in the `.catch()` handler and surfaced as a final
 *   `{ type: 'error', error: <message> }` chunk after all buffered deltas
 *   have been yielded. The generator never throws; callers always receive
 *   a terminal chunk.
 */
export function createCompanionProviderAdapter(providerRegistry: ProviderRegistry): CompanionLLMProvider {
  return {
    async *chatStream(messages, options): AsyncIterable<CompanionProviderChunk> {
      let provider: import('../providers/interface.js').LLMProvider;
      try {
        provider = options.model
          ? providerRegistry.getForModel(options.model, options.provider ?? undefined)
          : providerRegistry.getForModel(providerRegistry.getCurrentModel().id);
      } catch {
        // No provider is configured or the requested model/provider is unavailable.
        // Yield a structured error so the companion session receives feedback
        // rather than hanging or crashing.
        yield { type: 'error' as const, error: 'No provider available for companion chat' };
        return;
      }
      // Queue-based streaming bridge: onDelta pushes into a queue consumed by the generator.
      const queue: CompanionProviderChunk[] = [];
      let resolve: (() => void) | null = null;
      let done = false;
      let streamError: string | undefined;
      const push = (chunk: CompanionProviderChunk): void => {
        queue.push(chunk);
        resolve?.();
        resolve = null;
      };
      const chatPromise = provider.chat({
        model: options.model ?? providerRegistry.getCurrentModel().id,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt: options.systemPrompt ?? undefined,
        signal: options.abortSignal,
        onDelta(delta) {
          if (delta.content) push({ type: 'text_delta', delta: delta.content });
        },
      }).then((resp) => {
        if (resp.toolCalls?.length) {
          for (const tc of resp.toolCalls) {
            push({ type: 'tool_call', toolCallId: tc.id, toolName: tc.name, toolInput: tc.arguments });
          }
        }
      }).catch((err: unknown) => {
        // Mid-stream error: capture message so it can be yielded as a terminal chunk.
        streamError = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        done = true;
        resolve?.();
        resolve = null;
      });
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
      await chatPromise;
      if (streamError) {
        yield { type: 'error' as const, error: streamError };
      } else {
        yield { type: 'done' as const };
      }
    },
  };
}

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
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: RuntimeServices['mediaProviders'];
  readonly multimodalService: RuntimeServices['multimodalService'];
  readonly artifactStore: RuntimeServices['artifactStore'];
  readonly serviceRegistry: ServiceRegistry;
  readonly serveFactory: typeof Bun.serve;
  readonly githubWebhookSecret: string | null;
  readonly companionChatManager: CompanionChatManager;
}

export function resolveDaemonFacadeRuntime(
  config: DaemonConfig,
  fallbackConfigManager?: ConfigManager,
): ResolvedDaemonFacadeRuntime {
  const ownedWorkingDir = config.runtimeServices?.workingDirectory ?? config.workingDir;
  const ownedHomeDirectory = config.runtimeServices?.homeDirectory ?? config.homeDirectory;
  const configManager = config.configManager ?? fallbackConfigManager ?? config.runtimeServices?.configManager;
  if (!config.runtimeServices && !configManager && (!ownedWorkingDir || !ownedHomeDirectory)) {
    throw new Error('DaemonServer requires explicit runtime services or explicit configManager plus workingDir/homeDirectory ownership.');
  }
  if (!config.runtimeServices && !configManager) {
    throw new Error('DaemonServer requires an explicit ConfigManager or runtimeServices.');
  }

  const resolvedConfigManager = configManager ?? config.runtimeServices!.configManager;
  const ownedRuntimeBus = config.runtimeServices?.runtimeBus ?? config.runtimeBus ?? new RuntimeEventBus();
  const runtimeServices = config.runtimeServices ?? createRuntimeServices({
    configManager: resolvedConfigManager,
    runtimeBus: ownedRuntimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'goodvibes daemon',
    workingDir: ownedWorkingDir!,
    homeDirectory: ownedHomeDirectory!,
  });
  const runtimeBus = runtimeServices.runtimeBus;
  const runtimeStore = runtimeServices.runtimeStore;
  const controlPlaneGateway = new ControlPlaneGateway({
    runtimeBus,
    runtimeStore,
    server: {
      enabled: false,
      ...resolveHostBinding(
        (resolvedConfigManager.get('controlPlane.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
        String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
        Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
        'controlPlane',
      ),
      streamingMode: (resolvedConfigManager.get('controlPlane.streamMode') as import('../control-plane/index.js').ControlPlaneStreamingMode | undefined) ?? 'sse',
    },
  });

  runtimeServices.knowledgeService.attachRuntimeBus(runtimeBus);
  runtimeServices.sessionBroker.attachRuntimeBus(runtimeBus, (agentId) => {
    for (const s of runtimeServices.sessionBroker.listSessions(1000)) {
      if (s.activeAgentId === agentId) return s.id;
    }
    return null;
  });
  runtimeServices.routeBindings.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.surfaceRegistry.attachRuntime(runtimeStore);
  runtimeServices.watcherRegistry.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.automationManager.attachRuntime({
    runtimeBus,
    runtimeStore,
    deliveryManager: runtimeServices.deliveryManager,
  });
  runtimeServices.deliveryManager.setControlPlaneGateway(controlPlaneGateway);

  const companionChatManager = new CompanionChatManager({
    eventPublisher: controlPlaneGateway,
    provider: createCompanionProviderAdapter(runtimeServices.providerRegistry),
    // C-2: Explicitly opt into disk persistence for the daemon. Default is
    // false (safe for tests/embedders); daemon is the only caller that needs it.
    persist: true,
    // C-3: Wire the full ToolRegistry so LLM-emitted tool calls are executed.
    toolRegistry: runtimeServices.agentOrchestrator.getToolRegistry(),
  });
  runtimeServices.approvalBroker.setPublisher(controlPlaneGateway);
  runtimeServices.sessionBroker.setEventPublisher((event, payload) => {
    controlPlaneGateway.publishEvent(event, payload);
  });

  // Host and port precedence: constructor-injected config.host/config.port win,
  // then fall back to the hostMode-aware binding resolution from configManager.
  // Directly-passed overrides are critical for tests (which bind random high
  // ports) and for embedders that construct DaemonServer with explicit values.
  const resolvedControlPlaneBinding = resolveHostBinding(
    (resolvedConfigManager.get('controlPlane.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
    String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
    Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
    'controlPlane',
  );

  return {
    configManager: resolvedConfigManager,
    runtimeServices,
    integrationHelpers: runtimeServices.integrationHelpers,
    port: config.port ?? resolvedControlPlaneBinding.port,
    host: config.host ?? resolvedControlPlaneBinding.host,
    agentManager: config.agentManager ?? runtimeServices.agentManager,
    userAuth: config.userAuth ?? runtimeServices.localUserAuthManager,
    automationManager: runtimeServices.automationManager,
    runtimeBus,
    runtimeStore,
    runtimeDispatch: runtimeServices.runtimeDispatch,
    controlPlaneGateway,
    gatewayMethods: runtimeServices.gatewayMethods,
    sessionBroker: runtimeServices.sessionBroker,
    approvalBroker: runtimeServices.approvalBroker,
    routeBindings: runtimeServices.routeBindings,
    deliveryManager: runtimeServices.deliveryManager,
    surfaceRegistry: runtimeServices.surfaceRegistry,
    channelPolicy: runtimeServices.channelPolicy,
    channelPlugins: runtimeServices.channelPlugins,
    watcherRegistry: runtimeServices.watcherRegistry,
    platformServiceManager: new PlatformServiceManager(resolvedConfigManager, {
      workingDirectory: runtimeServices.workingDirectory,
      homeDirectory: runtimeServices.homeDirectory,
      surfaceRoot: 'goodvibes',
      binaryBaseName: 'goodvibes',
      defaultServiceName: 'goodvibes',
      defaultServiceDescription: 'goodvibes omnichannel daemon host',
    }),
    distributedRuntime: runtimeServices.distributedRuntime,
    voiceService: runtimeServices.voiceService,
    webSearchService: runtimeServices.webSearchService,
    knowledgeService: runtimeServices.knowledgeService,
    knowledgeGraphqlService: new KnowledgeGraphqlService(runtimeServices.knowledgeService),
    mediaProviders: runtimeServices.mediaProviders,
    multimodalService: runtimeServices.multimodalService,
    artifactStore: runtimeServices.artifactStore,
    serviceRegistry: runtimeServices.serviceRegistry,
    serveFactory: config.serveFactory ?? Bun.serve,
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null,
    companionChatManager,
  };
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
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalId?: string;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
      readonly clientKind?: string;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly syncSpawnedAgentTask: (record: import('../tools/agent/index.js').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../tools/agent/index.js').AgentRecord) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (approvalId: string, action: 'claim' | 'approve' | 'deny' | 'cancel', req: Request) => Promise<Response>;
  readonly tlsState: () => ResolvedInboundTlsContext | null;
}

export function createDaemonFacadeCollaborators(
  options: CreateDaemonFacadeCollaboratorsOptions,
): DaemonFacadeCollaborators {
  const { runtime } = options;
  const channelReplyPipeline = new ChannelReplyPipeline({
    channelPlugins: runtime.channelPlugins,
    routeBindings: runtime.routeBindings,
    runtimeBus: runtime.runtimeBus,
  });
  const surfaceDeliveryHelper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: options.pendingSurfaceReplies,
    channelReplyPipeline,
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    agentManager: runtime.agentManager,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPlugins: runtime.channelPlugins,
    authToken: options.authToken,
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
  });
  const surfaceActionHelper = new DaemonSurfaceActionHelper({
    serviceRegistry: runtime.serviceRegistry,
    configManager: runtime.configManager,
    routeBindings: runtime.routeBindings,
    sessionBroker: runtime.sessionBroker,
    channelPolicy: runtime.channelPolicy,
    automationManager: runtime.automationManager,
    agentManager: runtime.agentManager,
    trySpawnAgent: options.trySpawnAgent,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    queueWebhookReply: (input) => surfaceDeliveryHelper.queueWebhookReply(input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    signWebhookPayload: options.signWebhookPayload,
    handleApprovalAction: options.handleApprovalAction,
  });
  const controlPlaneHelper = new DaemonControlPlaneHelper({
    authToken: options.authToken,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    host: runtime.host,
    port: runtime.port,
    distributedRuntime: runtime.distributedRuntime,
    trustProxyEnabled: options.trustProxyEnabled,
    dispatchApiRoutes: options.dispatchApiRoutes,
    parseJsonBody: options.parseJsonBody,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
  });
  const transportEventsHelper = new DaemonTransportEventsHelper({
    runtimeBus: runtime.runtimeBus,
    hookDispatcher: runtime.runtimeServices.hookDispatcher,
    host: runtime.host,
    port: runtime.port,
    tlsState: options.tlsState,
  });
  const httpRouter = new DaemonHttpRouter({
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    automationManager: runtime.automationManager,
    approvalBroker: runtime.approvalBroker,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    providerRegistry: runtime.runtimeServices.providerRegistry,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    surfaceRegistry: runtime.surfaceRegistry,
    distributedRuntime: runtime.distributedRuntime,
    watcherRegistry: runtime.watcherRegistry,
    voiceService: runtime.voiceService,
    webSearchService: runtime.webSearchService,
    knowledgeService: runtime.knowledgeService,
    knowledgeGraphqlService: runtime.knowledgeGraphqlService,
    mediaProviders: runtime.mediaProviders,
    multimodalService: runtime.multimodalService,
    artifactStore: runtime.artifactStore,
    memoryRegistry: runtime.runtimeServices.memoryRegistry,
    memoryEmbeddingRegistry: runtime.runtimeServices.memoryEmbeddingRegistry,
    platformServiceManager: runtime.platformServiceManager,
    integrationHelpers: runtime.integrationHelpers,
    runtimeBus: runtime.runtimeBus,
    runtimeStore: runtime.runtimeStore,
    runtimeDispatch: runtime.runtimeDispatch,
    githubWebhookSecret: runtime.githubWebhookSecret,
    authToken: options.authToken,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    checkAuth: options.checkAuth,
    extractAuthToken: options.extractAuthToken,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
    requireAdmin: options.requireAdmin,
    requireRemotePeer: options.requireRemotePeer,
    describeAuthenticatedPrincipal: options.describeAuthenticatedPrincipal,
    invokeGatewayMethodCall: options.invokeGatewayMethodCall,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    syncSpawnedAgentTask: options.syncSpawnedAgentTask,
    syncFinishedAgentTask: options.syncFinishedAgentTask,
    trySpawnAgent: options.trySpawnAgent,
    companionChatManager: runtime.companionChatManager,
  });
  const providerRuntime = new ChannelProviderRuntimeManager({
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
  });
  const builtinChannels = new BuiltinChannelRuntime({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    serviceRegistry: runtime.serviceRegistry,
    routeBindings: runtime.routeBindings,
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    providerRuntime,
    deliveryRouter: runtime.deliveryManager.getDeliveryRouter(),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    deliverSurfaceProgress: (pending, progress) => surfaceDeliveryHelper.deliverSurfaceProgress(pending as PendingSurfaceReply, progress),
    deliverSlackAgentReply: (pending, message) => surfaceDeliveryHelper.deliverSlackAgentReply(pending as PendingSurfaceReply, message),
    deliverDiscordAgentReply: (pending, message) => surfaceDeliveryHelper.deliverDiscordAgentReply(pending as PendingSurfaceReply, message),
    deliverNtfyAgentReply: (pending, message) => surfaceDeliveryHelper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
    deliverWebhookAgentReply: (pending, message) => surfaceDeliveryHelper.deliverWebhookAgentReply(pending as PendingSurfaceReply, message),
    deliverSlackApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverSlackApprovalUpdate(approval, binding),
    deliverDiscordApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverDiscordApprovalUpdate(approval, binding),
    deliverNtfyApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverNtfyApprovalUpdate(approval, binding),
    deliverWebhookApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverWebhookApprovalUpdate(approval, binding),
  });
  builtinChannels.registerPlugins();

  return {
    channelReplyPipeline,
    controlPlaneHelper,
    surfaceDeliveryHelper,
    surfaceActionHelper,
    transportEventsHelper,
    httpRouter,
    providerRuntime,
    builtinChannels,
  };
}

export function configureDaemonSessionContinuation(options: {
  readonly sessionBroker: SharedSessionBroker;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.js').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding | undefined, input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string;
  }) => void;
}): void {
  options.sessionBroker.setContinuationRunner(async ({ sessionId, input, task, routeBinding }) => {
    const spawned = options.trySpawnAgent({
      mode: 'spawn',
      task,
      ...(input.routing?.modelId ? { model: input.routing.modelId } : {}),
      ...(input.routing?.providerId ? { provider: input.routing.providerId } : {}),
      ...(input.routing?.tools?.length ? { tools: [...input.routing.tools] } : {}),
      context: `shared-session:${sessionId}`,
    }, 'DaemonServer.sharedSessionFollowUp', sessionId);
    if (spawned instanceof Response) {
      return null;
    }
    options.queueSurfaceReplyFromBinding(routeBinding, {
      agentId: spawned.id,
      task: input.body,
      sessionId,
    });
    return { agentId: spawned.id };
  });
}
