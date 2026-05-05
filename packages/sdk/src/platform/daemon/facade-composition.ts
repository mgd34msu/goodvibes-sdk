import { AgentManager } from '../tools/agent/index.js';
import { resolveHostBinding } from './host-resolver.js';
import type { ConfigManager } from '../config/manager.js';
import { RuntimeEventBus } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { setTelemetryIncludeRawPrompts } from '../runtime/telemetry/redaction-config.js';
import {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
} from '../channels/index.js';
import { ControlPlaneGateway } from '../control-plane/index.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../control-plane/session-intents.js';
import { KnowledgeGraphqlService } from '../knowledge/index.js';
import { DaemonControlPlaneHelper } from './control-plane.js';
import { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import { DaemonSurfaceActionHelper } from './surface-actions.js';
import { DaemonTransportEventsHelper } from './transport-events.js';
import { DaemonHttpRouter } from './http/router.js';
import { DaemonBatchManager } from '../batch/index.js';
import { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { CompanionLLMProvider, CompanionProviderChunk } from '../companion/companion-chat-manager.js';
import { findModelDefinition, findModelDefinitionForProvider } from '../providers/registry-models.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from '../providers/builtin-registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import type { DaemonConfig, PendingSurfaceReply } from './types.js';
import { PlatformServiceManager } from './service-manager.js';
import type { ResolvedInboundTlsContext } from '../runtime/network/index.js';
import { PermissionManager, createPermissionConfigReader } from '../permissions/manager.js';
// Re-export type definitions from the dedicated types module.
export type {
  ResolvedDaemonFacadeRuntime,
  DaemonFacadeCollaborators,
  CreateDaemonFacadeCollaboratorsOptions,
} from './facade-types.js';
import type {
  ResolvedDaemonFacadeRuntime,
  DaemonFacadeCollaborators,
  CreateDaemonFacadeCollaboratorsOptions,
} from './facade-types.js';

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
        if (options.model) {
          provider = providerRegistry.getForModel(options.model, options.provider ?? undefined);
        } else {
          const current = providerRegistry.getCurrentModel();
          provider = providerRegistry.getForModel(current.registryKey, current.provider);
        }
      } catch {
        // No provider is configured or the requested model/provider is unavailable.
        // Yield a structured error so the companion session receives feedback
        // rather than hanging or crashing.
        yield { type: 'error' as const, error: 'No provider available for companion chat' };
        return;
      }
      // Guard: if the selected provider has no credentials, yield a clean error
      // immediately instead of letting the upstream respond with a cryptic 401.
      if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
        const providerName = provider.name;
        const envVarHint = (provider as { authEnvVars?: readonly string[] }).authEnvVars?.[0]
          ?? (provider as { authEnvVars?: readonly string[] }).authEnvVars?.join(' or ')
          ?? 'the appropriate API key env var';
        yield {
          type: 'error' as const,
          error: `Provider '${providerName}' is not configured. Set ${envVarHint} or configure via the TUI settings.`,
        };
        return;
      }
      // Resolve the provider model id from the registry's ModelDefinition.
      // options.model is the provider-qualified registry key (for example
      // "inception:mercury-2"); provider.chat() receives the provider's id.
      let providerModelId: string;
      try {
        const modelRegistry = providerRegistry.listModels();
        const def = options.model
          ? (options.provider
              ? findModelDefinitionForProvider(options.model, options.provider, modelRegistry, CATALOG_PROVIDER_NAME_ALIASES)
              : findModelDefinition(options.model, modelRegistry))
          : providerRegistry.getCurrentModel();
        if (!def) {
          throw new Error(`Model '${options.model}' is not in the provider registry.`);
        }
        providerModelId = def.id;
      } catch (err) {
        yield {
          type: 'error' as const,
          error: err instanceof Error ? err.message : 'Requested companion model is not available',
        };
        return;
      }
      // Queue-based streaming bridge: onDelta pushes into a queue consumed by the generator.
      const queue: CompanionProviderChunk[] = [];
      let resolve: (() => void) | null = null;
      let done = false;
      let streamError: string | undefined;
      let streamedContent = '';
      const push = (chunk: CompanionProviderChunk): void => {
        queue.push(chunk);
        resolve?.();
        resolve = null;
      };
      const chatPromise = provider.chat({
        model: providerModelId,
        messages: messages.map((m) => {
          if (m.role === 'tool') {
            return {
              role: 'tool' as const,
              callId: m.callId,
              content: m.content,
              ...(m.name ? { name: m.name } : {}),
            };
          }
          if (m.role === 'assistant') {
            return {
              role: 'assistant' as const,
              content: m.content,
              ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            };
          }
          return { role: 'user' as const, content: m.content };
        }),
        tools: options.tools && options.tools.length > 0 ? [...options.tools] : undefined,
        systemPrompt: options.systemPrompt ?? undefined,
        signal: options.abortSignal,
        onDelta(delta) {
          if (delta.content) {
            streamedContent += delta.content;
            push({ type: 'text_delta', delta: delta.content });
          }
        },
      }).then((resp) => {
        if (resp.content && streamedContent.length === 0) {
          push({ type: 'text_delta', delta: resp.content });
        }
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

export function resolveDaemonFacadeRuntime(config: DaemonConfig): ResolvedDaemonFacadeRuntime {
  const ownedWorkingDir = config.runtimeServices?.workingDirectory ?? config.workingDir;
  const ownedHomeDirectory = config.runtimeServices?.homeDirectory ?? config.homeDirectory;
  const configManager = config.configManager ?? config.runtimeServices?.configManager;
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
    featureFlags: runtimeServices.featureFlags,
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
    // Explicitly opt into disk persistence for the daemon. Default is false
    // for tests and embedded hosts.
    persist: true,
    // Wire the full ToolRegistry so LLM-emitted tool calls are executed.
    toolRegistry: runtimeServices.agentOrchestrator.getToolRegistry(),
    permissionManager: new PermissionManager(
      undefined,
      createPermissionConfigReader(resolvedConfigManager),
      runtimeServices.policyRuntimeState,
      runtimeServices.hookDispatcher,
      runtimeServices.featureFlags,
    ),
    hookDispatcher: runtimeServices.hookDispatcher,
    runtimeBus,
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
      featureFlags: runtimeServices.featureFlags,
    }),
    distributedRuntime: runtimeServices.distributedRuntime,
    voiceService: runtimeServices.voiceService,
    webSearchService: runtimeServices.webSearchService,
    knowledgeService: runtimeServices.knowledgeService,
    homeGraphService: runtimeServices.homeGraphService,
    projectPlanningService: runtimeServices.projectPlanningService,
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

export function createDaemonFacadeCollaborators(
  options: CreateDaemonFacadeCollaboratorsOptions,
): DaemonFacadeCollaborators {
  const { runtime } = options;

  // wire telemetry.includeRawPrompts into turn-emitter redaction behavior.
  // Default (false) redacts raw prompt/response content to {length, sha256, first100chars}.
  // Opt-in surfaces a startup WARN (emitted inside setTelemetryIncludeRawPrompts when true).
  setTelemetryIncludeRawPrompts(
    runtime.configManager.get('telemetry.includeRawPrompts') === true,
  );

  const channelReplyPipeline = new ChannelReplyPipeline({
    channelPlugins: runtime.channelPlugins,
    routeBindings: runtime.routeBindings,
    runtimeBus: runtime.runtimeBus,
  });
  const surfaceDeliveryHelper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: options.pendingSurfaceReplies,
    channelReplyPipeline,
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
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
    secretsManager: runtime.runtimeServices.secretsManager,
    configManager: runtime.configManager,
    routeBindings: runtime.routeBindings,
    sessionBroker: runtime.sessionBroker,
    channelPolicy: runtime.channelPolicy,
    controlPlaneGateway: runtime.controlPlaneGateway,
    runtimeBus: runtime.runtimeBus,
    companionChatManager: runtime.companionChatManager,
    automationManager: runtime.automationManager,
    agentManager: runtime.agentManager,
    trySpawnAgent: options.trySpawnAgent,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    queueWebhookReply: (input) => surfaceDeliveryHelper.queueWebhookReply(input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    signWebhookPayload: options.signWebhookPayload,
    handleApprovalAction: options.handleApprovalAction,
    resolveDefaultProviderModel: options.resolveDefaultProviderModel,
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
  const batchManager = new DaemonBatchManager({
    configManager: runtime.configManager,
    providerRegistry: runtime.runtimeServices.providerRegistry,
  });
  batchManager.start();
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
    homeGraphService: runtime.homeGraphService,
    projectPlanningService: runtime.projectPlanningService,
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
    batchManager,
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
    secretsManager: runtime.runtimeServices.secretsManager,
    swapManager: options.swapManager,
    resolveDefaultProviderModel: options.resolveDefaultProviderModel,
  });
  const providerRuntime = new ChannelProviderRuntimeManager({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
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
  readonly sessionBroker: import('../control-plane/index.js').SharedSessionBroker;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.js').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('../automation/routes.js').AutomationRouteBinding | undefined, input: {
    readonly agentId: string;
    readonly task: string;
    readonly agentTask?: string | undefined;
    readonly workflowChainId?: string | undefined;
    readonly sessionId?: string | undefined;
  }) => void;
}): void {
  options.sessionBroker.setContinuationRunner(async ({ sessionId, input, task, routeBinding }) => {
    const spawned = options.trySpawnAgent({
      mode: 'spawn',
      task,
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing),
      context: `shared-session:${sessionId}`,
    }, 'DaemonServer.sharedSessionFollowUp', sessionId);
    if (spawned instanceof Response) {
      return null;
    }
    options.queueSurfaceReplyFromBinding(routeBinding, {
      agentId: spawned.id,
      task: input.body,
      agentTask: task,
      ...(typeof spawned.wrfcId === 'string' && spawned.wrfcId.length > 0 ? { workflowChainId: spawned.wrfcId } : {}),
      sessionId,
    });
    return { agentId: spawned.id };
  });
}
