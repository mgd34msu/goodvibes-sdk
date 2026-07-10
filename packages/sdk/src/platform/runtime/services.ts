import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ConfigManager } from '../config/manager.js';
import { SecretsManager } from '../config/secrets.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { SubscriptionManager } from '../config/subscriptions.js';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore } from '../automation/index.js';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../channels/index.js';
import { ChannelDeliveryRouter } from '../channels/delivery-router.js';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker, registerGatewayVerbGroups } from '../control-plane/index.js';
import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from '../control-plane/session-broker-sessions.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../control-plane/session-intents.js';
import { WatcherRegistry } from '../watchers/index.js';
import { ArtifactStore } from '../artifacts/index.js';
import {
  HomeGraphService,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  projectPlanningProjectIdFromPath,
} from '../knowledge/index.js';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_DB_FILE,
  REGULAR_KNOWLEDGE_DB_FILE,
} from '../knowledge/store-config.js';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '../media/index.js';
import { MultimodalService } from '../multimodal/index.js';
import { AgentManager } from '../tools/agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import { WrfcController } from '../agents/wrfc-controller.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import { ArchetypeLoader } from '../agents/archetypes.js';
import { ProcessManager } from '../tools/shared/process-manager.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import { WorkspaceCheckpointManager } from '../workspace/checkpoint/index.js';
import { MemoryRegistry } from '../state/memory-registry.js';
import { MemoryStore } from '../state/memory-store.js';
import { CodeIndexStore } from '../state/code-index-store.js';
import { CodeIndexReindexScheduler } from '../state/code-index-reindex.js';
import type { RuntimeEventBus } from './events/index.js';
import { createDomainDispatch } from './store/index.js';
import type { DomainDispatch, RuntimeStore } from './store/index.js';
import { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.js';
import { IntegrationHelperService } from './integration/helpers.js';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '../voice/index.js';
import { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.js';
import { MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import { HookActivityTracker } from '../hooks/activity.js';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '../hooks/index.js';
import { PluginManager } from '../plugins/manager.js';
import { BookmarkManager } from '../bookmarks/manager.js';
import { ProfileManager } from '../profiles/manager.js';
import { SessionManager } from '../sessions/manager.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import { ApiTokenAuditor } from '../security/token-audit.js';
import { UserAuthManager } from '../security/user-auth.js';
import { WebhookNotifier } from '../integrations/webhooks.js';
import { McpRegistry } from '../mcp/registry.js';
import { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import { ProviderOptimizer } from '../providers/optimizer.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import { CacheHitTracker } from '../providers/cache-strategy.js';
import { FavoritesStore } from '../providers/favorites.js';
import { BenchmarkStore } from '../providers/model-benchmarks.js';
import { ModelLimitsService } from '../providers/model-limits.js';
import { SessionMemoryStore } from '../core/session-memory.js';
import { SessionLineageTracker } from '../core/session-lineage.js';
import { SessionChangeTracker } from '../sessions/change-tracker.js';
import { ExecutionPlanManager } from '../core/execution-plan.js';
import { AdaptivePlanner } from '../core/adaptive-planner.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import { IdempotencyStore } from './idempotency/index.js';
import { OverflowHandler } from '../tools/shared/overflow.js';
import { ToolLLM } from '../config/tool-llm.js';
import { ComponentHealthMonitor } from './perf/component-health-monitor.js';
import { WorktreeRegistry } from './worktree/registry.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { createShellPathService, type ShellPathService } from './shell-paths.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import { createFeatureFlagManager } from './feature-flags/index.js';
import { PolicyRuntimeState } from './permissions/policy-runtime.js';
import { requireSurfaceRoot } from './surface-root.js';
import {
  createNoopKeybindingsManager,
  createNoopPanelManager,
  type KeybindingsManagerLike,
  type PanelManagerLike,
} from './host-ui.js';
import {
  createWorkflowServices,
  type WorkflowServices,
} from '../tools/workflow/index.js';
import { createProcessRegistry, withFleetArchive, attachFleetEmitBridge, type ArchivableProcessRegistry } from './fleet/index.js';
import { createOrchestrationEngine, type OrchestrationEngine } from '../orchestration/index.js';

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly surfaceRoot: string;
  readonly featureFlags?: FeatureFlagManager | undefined;
  readonly getConversationTitle?: (() => string | undefined) | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
  readonly panelManager?: PanelManagerLike | undefined;
  readonly keybindingsManager?: KeybindingsManagerLike | undefined;
  /**
   * Opt-in: kick off the repo source-tree code index's initial build
   * (Stage A) right after construction. Fire-and-forget — never
   * awaited, never blocks. Defaults off so building RuntimeServices never runs
   * an unrequested source-tree walk. Real interactive entry points pass `true`.
   */
  readonly autoStartCodeIndex?: boolean | undefined;
  /** Override the broker store path (default: home-scoped durable store). */
  readonly sessionStorePath?: string | undefined;
}

export interface RuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly panelManager: PanelManagerLike;
  readonly keybindingsManager: KeybindingsManagerLike;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /**
   * Repo source-tree code index (Stage A). Constructed and
   * schema-initialized eagerly like memoryStore, but the actual walk/chunk/
   * embed build is NOT auto-triggered here — call `.scheduleBuild()` from an
   * explicit call site (a `/codebase reindex` command, a session-start hook,
   * etc.) once one exists. Auto-triggering from every RuntimeServices
   * construction would run a full source-tree walk against whatever
   * workingDirectory a caller passes in — including the hundreds of existing
   * tests that build RuntimeServices fixtures — which is both slow and
   * surprising for embedders that never asked for it.
   */
  readonly codeIndexStore: CodeIndexStore;
  /** Stage B tool-site incremental reindex scheduler (bound to codeIndexStore). */
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  readonly componentHealthMonitor: ComponentHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly wrfcController: WrfcController;
  /**
   * Orchestration engine — ships ALONGSIDE wrfcController,
   * stage 1 of the 3-stage migration (see platform/orchestration/
   * controller-compat.ts). WrfcController is unchanged; this is a new,
   * opt-in surface for callers that want the pipeline/capacity-matching
   * scheduler instead of WrfcController's pairwise engineer<->reviewer
   * chain. Not auto-started — callers call orchestrationEngine.start(id)
   * (or resumeAllFromDisk()) once they have a workstream to run.
   */
  readonly orchestrationEngine: OrchestrationEngine;
  readonly processManager: ProcessManager;
  /**
   * Live process registry: queryable + subscribable fleet aggregation
   * over agentManager/wrfcController/processManager/watcherRegistry/workflow.
   * LIFECYCLE NOTE: RuntimeServices has no shutdown/dispose seam today, so
   * nothing calls processRegistry.dispose() here — the registry's coalesced
   * tick is timer.unref()'d and only runs while subscribers exist, so an
   * undisposed registry cannot pin the event loop. Hosts that tear down a
   * runtime (tests, embedders) should call processRegistry.dispose()
   * themselves; when a RuntimeServices-wide dispose seam lands, wire this in.
   */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  readonly integrationHelpers: IntegrationHelperService;
  /**
   * Re-root all path-bound services to a new working directory.
   *
   * Called by WorkspaceSwapManager.requestSwap() after the new directory has
   * been verified and its subdirectories created.
   *
   * Stores that are re-rooted in-process:
   * - MemoryStore (memory.sqlite + vector index): closed and reopened at new path.
   * - ProjectIndex: flushed at its current path, then reset to the new directory.
   *
   * Stores that require a process restart to fully re-root emit a warn-level log
   * naming the subsystem. They keep using their current filesystem path until the daemon is
   * restarted with --working-dir=<newDir> (or the persisted daemon-settings.json
   * value is picked up at startup).
   *
   * @throws if MemoryStore or ProjectIndex reroot fails. Propagated as INVALID_PATH
   * by WorkspaceSwapManager.
   */
  rerootStores(newWorkingDir: string): Promise<void>;
}

export function bindProviderOptimizerFeatureFlag(
  featureFlags: Pick<FeatureFlagManager, 'isEnabled' | 'subscribe'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setEnabled'>,
): () => void {
  providerOptimizer.setEnabled(featureFlags.isEnabled('provider-optimizer'));
  return featureFlags.subscribe((flagId, state) => {
    if (flagId === 'provider-optimizer') {
      providerOptimizer.setEnabled(state === 'enabled');
    }
  });
}

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'RuntimeServicesOptions surfaceRoot');
  const shellPaths = createShellPathService({
    workingDirectory,
    homeDirectory,
  });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    featureFlags.loadFromConfig({ flags: { ...configManager.getCategory('featureFlags') } });
  }
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = options.panelManager ?? createNoopPanelManager();
  const keybindingsManager = options.keybindingsManager ?? createNoopKeybindingsManager();
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  const surfaceRegistry = new SurfaceRegistry(configManager, options.runtimeStore, featureFlags);
  const channelPlugins = new ChannelPluginRegistry({ featureFlags });
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  const secretsManager = new SecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    surfaceRoot,
    configManager,
  });
  const subscriptionManager = new SubscriptionManager(
    shellPaths.resolveUserPath(surfaceRoot, 'subscriptions.json'),
  );
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath(surfaceRoot, 'services.json'), {
    secretsManager,
    subscriptionManager,
  });
  const providerCapabilityRegistry = new ProviderCapabilityRegistry();
  const cacheHitTracker = new CacheHitTracker();
  const favoritesStore = new FavoritesStore({ dir: shellPaths.resolveUserPath(surfaceRoot) });
  const benchmarkStore = new BenchmarkStore({ dir: shellPaths.resolveUserPath(surfaceRoot) });
  const modelLimitsService = new ModelLimitsService({
    cachePath: shellPaths.resolveUserPath(surfaceRoot, 'model-limits.json'),
  });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    featureFlags,
    runtimeBus: options.runtimeBus,
  });
  providerRegistry.initCustomProviders();
  const toolLLM = new ToolLLM({
    configManager,
    providerRegistry,
  });
  const localUserAuthManager = new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath(surfaceRoot, 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath(surfaceRoot, 'auth-bootstrap.txt'),
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(surfaceRoot, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(surfaceRoot, 'bookmarks'));
  const sessionManager = new SessionManager(workingDirectory, { surfaceRoot });
  const sessionOrchestration = new CrossSessionTaskRegistry(
    shellPaths.resolveProjectPath(surfaceRoot, 'sessions', 'task-graph.json'),
  );
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'watchers.json'),
    featureFlags,
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const agentMessageBus = new AgentMessageBus();
  agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader(join(workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({
    messageBus: agentMessageBus,
  });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager,
  });
  // Conversation-snapshot sink bridge: AgentOrchestrator is constructed before
  // AgentManager exists, so the conversation-snapshot sink is wired here via
  // setConversationSink rather than as a constructor dependency (same
  // ordering constraint as setRuntimeBus above).
  agentOrchestrator.setConversationSink({
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
  });
  // Cooperative cancellation bridge: same ordering constraint
  // and setter pattern as setConversationSink above — AgentOrchestrator is
  // constructed before AgentManager exists.
  agentOrchestrator.setCancellationSource({
    get: (agentId) => agentManager.getCancellationSignal(agentId),
  });
  agentManager.setRuntimeBus(options.runtimeBus);
  const wrfcController = new WrfcController(options.runtimeBus, agentMessageBus, {
    agentManager,
    configManager,
    projectRoot: workingDirectory,
    surfaceRoot,
  });
  agentManager.setWrfcController(wrfcController);
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({
    hookDispatcher,
    configManager,
  });
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'control-plane', 'approvals.json'),
  });
  // ONE home-scoped durable session store; project is DATA on each record.
  const sessionBroker = new SharedSessionBroker({
    storePath: options.sessionStorePath ?? shellPaths.resolveUserPath('control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
  });
  sessionBroker.setContinuationRunner(async ({ task, input }) => {
    const record = agentManager.spawn({
      mode: 'spawn',
      task,
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true }),
      context: `shared-session:${input.sessionId}`,
    });
    return { agentId: record.id };
  });
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const memoryDbPath = join(workingDirectory, '.goodvibes', surfaceRoot, 'memory.sqlite');
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  // Repo source-tree code index (Stage A) — shares
  // memoryEmbeddingRegistry so code + memory embeddings use one provider and
  // one dimensionality. Schema init only; build is not auto-triggered here
  // (see the RuntimeServices.codeIndexStore doc comment).
  const codeIndexDbPath = join(workingDirectory, '.goodvibes', surfaceRoot, 'code-index.sqlite');
  const codeIndexStore = new CodeIndexStore(workingDirectory, codeIndexDbPath, memoryEmbeddingRegistry);
  codeIndexStore.init();
  if (options.autoStartCodeIndex) {
    codeIndexStore.scheduleBuild();
  }
  // Stage B: tool-site incremental reindex. Gated on the SDK's autoStartCodeIndex opt-in
  // (this library's storage.codeIndexEnabled analog) AND the built-state check inside the
  // scheduler — an unbuilt index is a no-op either way.
  const codeInjectionSettingEnabled = (): boolean => options.autoStartCodeIndex === true;
  const codeIndexReindexScheduler = new CodeIndexReindexScheduler({
    target: codeIndexStore,
    workingDirectory,
    isEnabled: codeInjectionSettingEnabled,
  });
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    secretsManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  const automationManager = new AutomationManager({
    configManager,
    routeBindings,
    sessionBroker,
    defaultSurfaceKind: surfaceRoot as import('../automation/types.js').AutomationSurfaceKind,
    defaultSurfaceId: `surface:${surfaceRoot}`,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    featureFlags,
    spawnTask: (input) => {
      const record = agentManager.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.modelProvider ? { provider: input.modelProvider } : {}),
        ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
        ...(input.routing ? { routing: input.routing } : {}),
        ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      return record.id;
    },
  });
  const knowledgeStore = new KnowledgeStore({ configManager, dbFileName: REGULAR_KNOWLEDGE_DB_FILE, family: 'wiki' });
  const agentKnowledgeStore = new KnowledgeStore({ configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, family: 'agent' });
  const homeGraphKnowledgeStore = new KnowledgeStore({ configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE, family: 'home-graph' });
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, {
    timeoutMs: 20_000,
    maxConcurrent: 1,
  });
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
  });
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles,
  });
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
  });
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: knowledgeSemanticService,
  });
  knowledgeService.attachRuntimeBus(options.runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: agentKnowledgeSemanticService,
  });
  agentKnowledgeService.attachRuntimeBus(options.runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, {
    semanticService: homeGraphSemanticService,
  });
  const projectPlanningService = new ProjectPlanningService(knowledgeStore, {
    defaultProjectId: projectPlanningProjectIdFromPath(workingDirectory),
    runtimeBus: options.runtimeBus,
  });
  wrfcController.setWorkPlanService(projectPlanningService);
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders);
  const voiceService = new VoiceService(voiceProviders);
  const webSearchProviders = new WebSearchProviderRegistry({
    env: process.env,
    serviceRegistry,
  });
  const webSearchService = new WebSearchService(webSearchProviders, {
    serviceRegistry,
    featureFlags,
  });
  knowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: knowledgeService,
  }));
  agentKnowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: agentKnowledgeService,
  }));
  homeGraphSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: homeGraphService,
  }));
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager({
    pathOptions: {
      cwd: shellPaths.workingDirectory,
      homeDir: shellPaths.homeDirectory,
    },
    stateFilePath: shellPaths.resolveUserPath(surfaceRoot, 'plugins.json'),
  });
  const workflow = createWorkflowServices();
  hookDispatcher.setTriggerManager(workflow.triggerManager);
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(
    shellPaths.resolveProjectPath(surfaceRoot, 'remote', 'distributed-runtime.json'),
  );
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const mcpRegistry = new McpRegistry({
    hookDispatcher,
    sandboxSessions: sandboxSessionRegistry,
  });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  mcpRegistry.setSandboxRuntime(configManager, sandboxSessionRegistry);
  const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(workingDirectory, { surfaceRoot });
  const webhookNotifier = new WebhookNotifier();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = new ProviderOptimizer(
    providerRegistry,
    providerCapabilityRegistry,
    false,
  );
  bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({ baseDir: workingDirectory, featureFlags });
  const policyRuntimeState = new PolicyRuntimeState();
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  const modeManager = new ModeManager({ featureFlags });
  const fileUndoManager = new FileUndoManager();
  const workspaceCheckpointManager = new WorkspaceCheckpointManager({
    workspaceRoot: workingDirectory,
    runtimeBus: options.runtimeBus,
  });
  // Eagerly initialize so automatic turn/agent-run snapshot subscriptions are
  // wired up immediately rather than only on first explicit use — otherwise
  // the very first TURN_COMPLETED/AGENT_COMPLETED could arrive before any
  // caller has touched the manager.
  void workspaceCheckpointManager.init().catch((err: unknown) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: summarizeError(err) });
  });
  const integrationHelpers = new IntegrationHelperService({
    workingDirectory,
    homeDirectory,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    configManager,
    featureFlags,
    getConversationTitle: options.getConversationTitle,
    automationManager,
    approvalBroker,
    sessionBroker,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    panelManager,
    localUserAuthManager,
    providerRegistry,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
  });
  agentOrchestrator.setDependencies({
    fileCache,
    projectIndex,
    workingDirectory,
    surfaceRoot,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService,
    memoryRegistry,
    codeIndex: codeIndexStore,
    isCodeInjectionSettingEnabled: codeInjectionSettingEnabled,
    codeIndexReindexScheduler,
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    secretsManager,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
  });

  // Honest-unpriced: only price models the catalog actually knows; an
  // unknown model yields null (costState 'unpriced'), never a fabricated $0.
  // SHARED between the fleet registry and the orchestration engine — the
  // single cost source of truth so budget checks and fleet cost totals can
  // never double-count against each other.
  const priceUsage = (model: string | undefined, usage: { inputTokens: number; outputTokens: number }): number | null => {
    if (!model) return null;
    const catalogModels = providerRegistry.getRawCatalogModels();
    const known = catalogModels.some(
      (entry) => model === entry.id || model.startsWith(entry.id) || model.includes(entry.id),
    );
    if (!known && !model.endsWith(':free')) return null;
    const pricing = providerRegistry.getCostFromCatalog(model);
    return (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000;
  };

  // Orchestration engine — ships alongside wrfcController, untouched by this change. See the RuntimeServices interface comment.
  const orchestrationEngine = createOrchestrationEngine({
    agentManager,
    configManager,
    runtimeBus: options.runtimeBus,
    projectRoot: workingDirectory,
    priceUsage,
  });

  // Live process registry — narrow structural deps only, constructed
  // after every source manager exists. See the RuntimeServices interface
  // comment for the dispose story (no RuntimeServices-wide shutdown seam yet).
  // Archive-aware: finished agent/swarm subtrees can be moved out of the
  // live fleet view into a session-scoped archive (see fleet/archive.ts).
  const processRegistry = withFleetArchive(createProcessRegistry({
    agentManager,
    wrfcController,
    orchestrationEngine,
    processManager,
    watcherRegistry,
    workflow: {
      workflowManager: workflow.workflowManager,
      triggerManager: workflow.triggerManager,
      scheduleManager: workflow.scheduleManager,
    },
    approvalBroker,
    sessionBroker,
    runtimeBus: options.runtimeBus,
    priceUsage,
    codeIndexService: codeIndexStore,
  }));

  // Surface fleet lifecycle deltas on the runtime bus `fleet` domain (gateway fans it out; no polling). sessionPresence gates needs-input push suppression. Both subscriptions live for the registry's lifetime.
  attachFleetEmitBridge({ registry: processRegistry, bus: options.runtimeBus });
  const isAttached = (sessionId: string): boolean => {
    const s = sessionBroker.getSession(sessionId);
    return s ? hasFreshSurfaceParticipant(s, Date.now(), SURFACE_ROUTE_FRESHNESS_MS) : false;
  };
  registerGatewayVerbGroups(gatewayMethods, { processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager, approvalBroker, shellPaths, runtimeBus: options.runtimeBus, sessionPresence: { isAttached } }); // see routes/register-gateway-verb-groups.ts
  return {
    workingDirectory,
    homeDirectory,
    shellPaths,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    approvalBroker,
    sessionBroker,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    memoryStore,
    memoryRegistry,
    codeIndexStore,
    codeIndexReindexScheduler,
    serviceRegistry,
    secretsManager,
    subscriptionManager,
    localUserAuthManager,
    profileManager,
    bookmarkManager,
    sessionManager,
    sessionOrchestration,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    voiceProviders,
    voiceService,
    webSearchProviders,
    webSearchService,
    mediaProviders,
    multimodalService,
    memoryEmbeddingRegistry,
    channelPolicy,
    mcpRegistry,
    tokenAuditor,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    webhookNotifier,
    replayEngine,
    providerOptimizer,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionMemoryStore,
    sessionLineageTracker,
    sessionChangeTracker,
    planManager,
    adaptivePlanner,
    idempotencyStore,
    overflowHandler,
    policyRuntimeState,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    wrfcController,
    orchestrationEngine,
    processManager,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    async rerootStores(newWorkingDir: string): Promise<void> {
      // Step 1: Re-root MemoryStore — close existing SQLite/vector handles, reopen at new path.
      const newMemoryDbPath = join(newWorkingDir, '.goodvibes', surfaceRoot, 'memory.sqlite');
      await memoryStore.reroot(newMemoryDbPath);

      // Step 1b: Re-root the code index alongside memory — otherwise it keeps
      // pointing at the old tree after a workspace swap.
      const newCodeIndexDbPath = join(newWorkingDir, '.goodvibes', surfaceRoot, 'code-index.sqlite');
      await codeIndexStore.reroot(newWorkingDir, newCodeIndexDbPath);

      // Step 2: Re-root ProjectIndex — flush current path, reset, load from new directory.
      await projectIndex.reroot(newWorkingDir);

      // Step 3: Subsystems that cannot be live-rerooted emit a warn log.
      // They continue operating at their current root path until the next process restart,
      // at which point --working-dir / daemon-settings.json points to the new path.
      // This is acceptable because: (a) the swap endpoint is daemon-token-gated,
      // (b) these services primarily write user-scoped state (auth, bookmarks, profiles)
      // that is not workspace-scoped, and (c) knowledge/artifact stores resolve paths
      // through configManager which does not hot-reload during a running session.
      const cannotReroot = [
        'knowledgeStore (SQLite at configManager-resolved path — restart required)',
        'sessionManager (initialised with fixed workingDirectory)',
        'sessionOrchestration (task-graph.json path fixed at init)',
        'artifactStore (resolves rootDir via configManager.getControlPlaneConfigDir)',
        'hookDispatcher (projectRoot fixed at init)',
        'sandboxSessionRegistry (workingDirectory fixed at init)',
        'agentOrchestrator (workingDirectory fixed at init)',
        'wrfcController (projectRoot fixed at init)',
        'overflowHandler (baseDir fixed at init)',
        'replayEngine (workingDirectory fixed at init)',
        'planManager (workingDirectory fixed at init)',
        'workspaceCheckpointManager (side git GIT_DIR fixed at init)',
      ];
      for (const name of cannotReroot) {
        logger.warn('[rerootStores] subsystem requires restart to reroot', { subsystem: name, newWorkingDir });
      }
    },
  };
}
