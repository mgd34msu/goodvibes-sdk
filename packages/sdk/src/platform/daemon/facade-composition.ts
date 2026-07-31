import { join } from 'node:path';
import { AgentManager } from '../tools/agent/index.js';
import { resolveHostBinding } from './host-resolver.js';
import { composeHostedSessionsForFacade } from './hosted-sessions-composition.js';
import { WorkProposalStore } from '../agents/work-proposal-store.js';
import { readConversationGateConfig, type ConversationGateConfigReader } from '../agents/conversation-gate.js';
import { continuationChainOptions, decideContinuationEscalation } from '../agents/conversation-continuation.js';
import { gateSurfaceSpawn, type SurfaceIngressOrigin } from './surface-conversation-gate.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { setTelemetryIncludeRawPrompts } from '../runtime/telemetry/redaction-config.js';
import {
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
} from '../channels/index.js';
import { createChannelIngressAlarm } from './owner-alert.js';
import { ControlPlaneGateway } from '../control-plane/index.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../control-plane/session-intents.js';
import type { ModelIdCandidate } from '../providers/model-id-resolution.js';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  KnowledgeGraphqlService,
  KnowledgeSemanticService,
  KnowledgeService,
  KnowledgeStore,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
} from '../knowledge/index.js';
import { createBuiltinChannelRuntime } from './facade-builtin-channels.js';
import { DaemonControlPlaneHelper } from './control-plane.js';
import { DaemonSurfaceDeliveryHelper, type SurfaceDeliveryLedgerEntry } from './surface-delivery.js';
import { ROUTE_SURFACE_KINDS, type RouteSurfaceKind } from '../../events/routes.js';
import {
  emitDeliveryFailed,
  emitDeliveryQueued,
  emitDeliveryStarted,
  emitDeliverySucceeded,
} from '../runtime/emitters/deliveries.js';
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

function hasKnowledgeService(value: unknown): value is KnowledgeService {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.getStatus === 'function'
    && typeof candidate.ask === 'function'
    && typeof candidate.searchScoped === 'function';
}

function ensureAgentKnowledgeService(runtimeServices: RuntimeServices): RuntimeServices {
  const mutableRuntime = runtimeServices as RuntimeServices & { agentKnowledgeService?: KnowledgeService };
  if (hasKnowledgeService(mutableRuntime.agentKnowledgeService)) {
    return runtimeServices;
  }

  const store = new KnowledgeStore({
    configManager: runtimeServices.configManager,
    dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
    family: 'agent',
  });
  const semanticLlm = createProviderBackedKnowledgeSemanticLlm(runtimeServices.providerRegistry, {
    timeoutMs: 20_000,
    maxConcurrent: 1,
  });
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    runtimeServices.memoryGovernor.admitExpensiveWork(label);
  const semanticService = new KnowledgeSemanticService(store, {
    llm: semanticLlm,
    maxLlmSourcesPerReindex: 3,
    isBackgroundPaused: () => runtimeServices.pauseController.isPaused('knowledge-self-improvement'),
    admitExpensiveWork,
  });
  const service = new KnowledgeService(store, runtimeServices.artifactStore, undefined, {
    memoryRegistry: runtimeServices.memoryRegistry,
    runtimeBus: runtimeServices.runtimeBus,
    semanticService,
    admitExpensiveWork,
  });
  semanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: runtimeServices.webSearchService,
    ingestService: service,
  }));
  service.attachRuntimeBus(runtimeServices.runtimeBus);
  Object.defineProperty(mutableRuntime, 'agentKnowledgeService', {
    value: service,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return mutableRuntime as RuntimeServices;
}

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
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => resolvedConfigManager.get(key)));
  const ownedRuntimeBus = config.runtimeServices?.runtimeBus ?? config.runtimeBus ?? new RuntimeEventBus();
  const runtimeServices = ensureAgentKnowledgeService(config.runtimeServices ?? createRuntimeServices({
    configManager: resolvedConfigManager,
    runtimeBus: ownedRuntimeBus,
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'goodvibes daemon',
    workingDir: ownedWorkingDir!,
    homeDirectory: ownedHomeDirectory!,
  }));
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

  // Register the gateway's replay ring with the MemoryGovernor: a REAL count
  // and a REAL trim (floor halves the retained history; flush clears it, and
  // replay degrades honestly to an empty backlog for reconnecting clients).
  runtimeServices.cacheRegistry.register('event-replay-ring', {
    name: 'control-plane event replay ring + surface messages',
    entryCount: () => controlPlaneGateway.retainedEventCount(),
    trim: (level) => controlPlaneGateway.trimRetainedEvents(level),
  });

  runtimeServices.knowledgeService.attachRuntimeBus(runtimeBus);
  runtimeServices.agentKnowledgeService.attachRuntimeBus(runtimeBus);
  runtimeServices.sessionBroker.attachRuntimeBus(runtimeBus, (agentId) => {
    for (const s of runtimeServices.sessionBroker.listSessions(1000)) {
      if (s.activeAgentId === agentId) return s.id;
    }
    return null;
  });
  // Stamp automatic workspace checkpoints with the owning session id, resolved
  // the same way agent terminal events reconcile to a session (the broker's
  // activeAgentId map). Returns undefined when the triggering agent maps to no
  // shared session — the checkpoint is then left unstamped rather than guessed,
  // and sessions.changes.get / list({sessionId}) honestly report nothing for it.
  runtimeServices.workspaceCheckpointManager.setSessionResolver(({ agentId }) => {
    if (!agentId) return undefined;
    for (const s of runtimeServices.sessionBroker.listSessions(1000)) {
      if (s.activeAgentId === agentId) return s.id;
    }
    return undefined;
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
    // Honor the runtime's injected home so an isolated-home daemon never reads
    // or writes the real ~/.goodvibes/companion-chat.
    sessionsDir: runtimeServices.shellPaths.resolveUserPath('companion-chat', 'sessions'),
    // Live spine: companion sessions register INTO the shared broker at write
    // time so /api/sessions reflects them same-process (no restart).
    sessionBroker: runtimeServices.sessionBroker,
    // Wire the full ToolRegistry so LLM-emitted tool calls are executed.
    toolRegistry: runtimeServices.agentOrchestrator.getToolRegistry(),
    permissionManager: new PermissionManager(
      undefined,
      createPermissionConfigReader(resolvedConfigManager),
      runtimeServices.policyRuntimeState,
      runtimeServices.hookDispatcher,
      runtimeServices.featureFlags,
      runtimeServices.userPermissionRuleStore,
    ),
    hookDispatcher: runtimeServices.hookDispatcher,
    runtimeBus,
    artifactStore: runtimeServices.artifactStore,
  });
  runtimeServices.approvalBroker.setPublisher(controlPlaneGateway);
  runtimeServices.sessionBroker.setEventPublisher((event, payload) => {
    controlPlaneGateway.publishEvent(event, payload);
  });

  // Hosted sessions: composed here because the engine publishes its lifecycle channel through the gateway built here.
  const hostedSessions = composeHostedSessionsForFacade(config.hostedSessions, runtimeServices, resolvedConfigManager, runtimeBus, controlPlaneGateway);

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
    ownsRuntimeServices: config.runtimeServices === undefined, // see facade-types.ts
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
    triggerManager: runtimeServices.triggerManager,
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
    agentKnowledgeService: runtimeServices.agentKnowledgeService,
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
    hostedSessions,
  };
}

/**
 * Put a surface reply into the SAME delivery ledger automation deliveries use.
 *
 * Before this, the ledger observed automation deliveries only, so a channel
 * conversation could exchange messages all evening and the ledger still read
 * "0 queued, 0 started, 0 succeeded, 0 failed, 0 attempts". A dropped reply and
 * an idle daemon produced byte-identical evidence, which is how a real delivery
 * failure stayed invisible.
 */
function recordSurfaceDeliveryAttempt(runtime: ResolvedDaemonFacadeRuntime, entry: SurfaceDeliveryLedgerEntry): void {
  const surfaceKind = (ROUTE_SURFACE_KINDS as readonly string[]).includes(entry.surfaceKind)
    ? entry.surfaceKind as RouteSurfaceKind
    : 'webhook';
  const now = Date.now();
  runtime.runtimeDispatch?.syncDeliveryAttempt({
    id: entry.deliveryId,
    runId: entry.sessionId ?? entry.agentId,
    jobId: entry.routeId ?? `surface:${surfaceKind}`,
    target: {
      kind: 'surface',
      surfaceKind: surfaceKind as never,
      ...(entry.routeId ? { routeId: entry.routeId } : {}),
      address: entry.targetId,
      label: `agent ${entry.agentId}`,
    },
    status: entry.phase === 'queued'
      ? 'pending'
      : entry.phase === 'started'
        ? 'sending'
        : entry.phase === 'succeeded' ? 'sent' : 'failed',
    ...(entry.phase === 'queued' ? {} : { startedAt: now }),
    ...(entry.phase === 'succeeded' || entry.phase === 'failed' ? { endedAt: now } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }, `deliveries.${entry.phase}`);
  const bus = runtime.runtimeBus;
  if (!bus) return;
  const ctx = {
    sessionId: entry.sessionId ?? 'surface-reply',
    source: 'daemon-surface-delivery',
    traceId: entry.deliveryId,
  } as const;
  const common = {
    deliveryId: entry.deliveryId,
    jobId: entry.routeId ?? `surface:${surfaceKind}`,
    runId: entry.sessionId ?? entry.agentId,
    surfaceKind,
    targetId: entry.targetId,
  };
  if (entry.phase === 'queued') {
    emitDeliveryQueued(bus, ctx, { ...common, deliveryKind: 'reply' });
    return;
  }
  if (entry.phase === 'started') {
    emitDeliveryStarted(bus, ctx, { ...common, startedAt: now });
    return;
  }
  if (entry.phase === 'succeeded') {
    emitDeliverySucceeded(bus, ctx, { ...common, completedAt: now, durationMs: 0, statusCode: 200 });
    return;
  }
  emitDeliveryFailed(bus, ctx, {
    ...common,
    failedAt: now,
    error: entry.error ?? 'surface reply was not delivered',
    retryable: false,
  });
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
    recordDeliveryAttempt: (entry) => recordSurfaceDeliveryAttempt(runtime, entry),
  });
  // Every reply the pipeline could not put on a channel becomes a visible
  // failed delivery rather than an absence.
  channelReplyPipeline.setUndeliveredReporter((reply) => surfaceDeliveryHelper.recordUndeliveredReply(reply));
  channelReplyPipeline.setDeliveredReporter((reply) => surfaceDeliveryHelper.recordDeliveredReply(reply));
  // THE shared reply-routing point. The broker announces "this agent will
  // answer this channel message" from inside itself, so every ingress — a fresh
  // spawn, a message that landed in an existing live session, a shared-session
  // continuation — routes its answer back to the conversation it came from.
  runtime.sessionBroker.setSurfaceReplyBinder((binding) => {
    surfaceDeliveryHelper.ensureSurfaceReply(binding);
  });
  // The broker's own voice on a channel, used when it heals a route binding
  // that named an unusable session: the conversation moves to a fresh session
  // and the person on the other end is told why, instead of meeting an
  // assistant that has silently forgotten the last two days. Same delivery
  // helper every other unsolicited message uses, so the surface's escaper and
  // its refusal logging both apply.
  runtime.sessionBroker.setSurfaceNoticeSender((routeId, text) => {
    const binding = runtime.routeBindings.getBinding(routeId) ?? undefined;
    void surfaceDeliveryHelper.deliverSurfaceNotice(binding, text);
  });
  // One alarm, every inbound path — see createChannelIngressAlarm.
  const ingressAlarm = createChannelIngressAlarm(runtime.routeBindings, surfaceDeliveryHelper);
  runtime.channelPlugins.setIngressAlarm(ingressAlarm);
  // Pending work proposals for the conversation-first spawn gate. Persisted
  // beside the other control-plane state so a proposal survives a daemon
  // restart; the store validates and reaps on load, so a stale one is not
  // answerable after it expires.
  const workProposals = new WorkProposalStore({
    storePath: join(runtime.configManager.getControlPlaneConfigDir(), 'work-proposals.json'),
    maxPending: readConversationGateConfig(runtime.configManager).maxPendingProposals,
  });
  void workProposals.init().catch((error: unknown) => {
    logger.warn('WorkProposalStore init failed; the conversation gate will re-propose', {
      error: summarizeError(error),
    });
  });

  const surfaceActionHelper = new DaemonSurfaceActionHelper({
    ingressAlarm,
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
    approvalBroker: runtime.approvalBroker,
    resolveDefaultProviderModel: options.resolveDefaultProviderModel,
    workProposals,
    deliverSurfaceNotice: (binding, text) => surfaceDeliveryHelper.deliverSurfaceNotice(binding, text),
  });
  const controlPlaneHelper = new DaemonControlPlaneHelper({
    authToken: options.authToken,
    pairingTokens: runtime.runtimeServices.pairingTokens,
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
    // A thunk, not a value: `builtinChannels` is constructed further down this
    // same function, and the route only runs on an HTTP request long after
    // composition finishes. Reading it eagerly here would be a temporal-dead-
    // zone error at startup.
    inboundMailHealth: () => builtinChannels.inboundMailHealth(),
    surfaceRegistry: runtime.surfaceRegistry,
    distributedRuntime: runtime.distributedRuntime,
    watcherRegistry: runtime.watcherRegistry,
    voiceService: runtime.voiceService,
    webSearchService: runtime.webSearchService,
    mcpRegistry: runtime.runtimeServices.mcpRegistry,
    mcpConfigRoots: runtime.runtimeServices.shellPaths,
    knowledgeService: runtime.knowledgeService,
    agentKnowledgeService: runtime.agentKnowledgeService,
    homeGraphService: runtime.homeGraphService,
    projectPlanningService: runtime.projectPlanningService,
    knowledgeGraphqlService: runtime.knowledgeGraphqlService,
    mediaProviders: runtime.mediaProviders,
    multimodalService: runtime.multimodalService,
    artifactStore: runtime.artifactStore,
    memoryRegistry: runtime.runtimeServices.memoryRegistry,
    memoryConsolidation: { listReceipts: () => runtime.runtimeServices.memoryConsolidationScheduler.listReceipts() },
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
    completeSurfaceReplyFromSurface: (input) => surfaceDeliveryHelper.completeSurfaceReplyFromSurface(input),
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
    ingressAlarm,
  });
  const builtinChannels = createBuiltinChannelRuntime({
    runtime, options, providerRuntime, surfaceActionHelper, surfaceDeliveryHelper, ingressAlarm,
  });

  return {
    channelReplyPipeline,
    controlPlaneHelper,
    surfaceDeliveryHelper,
    surfaceActionHelper,
    transportEventsHelper,
    httpRouter,
    providerRuntime,
    builtinChannels,
    workProposals,
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
  /** The live registry's model candidates — enables bare model id resolution in routing overrides. */
  readonly modelCandidates?: (() => readonly ModelIdCandidate[]) | undefined;
  /**
   * The surface helper holding the conversation-first gate's dependencies. A
   * follow-up in a shared session is the SAME message class the ingress gate
   * guards, so it gets the same treatment: conversation is answered with the
   * chain suppressed, and a work-shaped follow-up is PROPOSED over the channel
   * it arrived on (a Response, reported here as "no agent started").
   *
   * Absent — an embedder that has not wired the gate — still fails closed via
   * `continuationChainOptions` below. A continuation never opens a chain just
   * because nobody installed a gate.
   */
  readonly surfaceActionHelper?: Pick<DaemonSurfaceActionHelper, 'conversationGateDeps'> | undefined;
  /** Reads `conversationGate.*` so both halves of the gate obey one configuration. */
  readonly configReader?: ConversationGateConfigReader | undefined;
}): void {
  options.sessionBroker.setContinuationRunner(async ({ sessionId, input, task, routeBinding }) => {
    const spawnInput = {
      mode: 'spawn' as const,
      task,
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { modelCandidates: options.modelCandidates?.() }),
      context: `shared-session:${sessionId}`,
    };
    // Classify the OWNER's words (`input.body`), never the enriched
    // continuation task the broker builds from the transcript — that framing
    // reads as work no matter what the owner actually said.
    const origin: SurfaceIngressOrigin | null = input.surfaceKind
      ? {
          surface: input.surfaceKind,
          text: input.body,
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.externalId ?? input.threadId ? { channelId: input.externalId ?? input.threadId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }
      : null;
    // Work the owner already confirmed (an agreed proposal, a schedule, a
    // trigger, an on-exit chain) carries the marker and must not be re-asked;
    // a follow-up typed on a local surface keeps its chain. Everything else is
    // conversation and goes through the gate.
    const escalation = decideContinuationEscalation(input, {
      ...(options.configReader ? { configReader: options.configReader } : {}),
    });
    const label = 'DaemonServer.sharedSessionFollowUp';
    const gateDeps = options.surfaceActionHelper?.conversationGateDeps();
    const spawned = escalation.startsWorkChain
      ? options.trySpawnAgent(spawnInput, label, sessionId)
      : gateDeps
        ? gateSurfaceSpawn(gateDeps, origin, spawnInput, label, sessionId)
        : options.trySpawnAgent({ ...spawnInput, ...continuationChainOptions(input) }, label, sessionId);
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
