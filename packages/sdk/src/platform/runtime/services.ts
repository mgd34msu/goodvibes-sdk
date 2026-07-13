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
import { StepUpService } from '../relay/step-up-service.js';
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
import { StoreSnapshotScheduler } from '../state/store-snapshots.js';
import { resolveMemoryVectorDbPath } from '../state/memory-vector-store.js';
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
import { createMcpElicitationApprovalHandler } from '../mcp/elicitation.js';
import { buildSandboxEscalationHandler } from './permissions/sandbox-escalation-wiring.js';
import { buildExecPromptAnswerHandler } from './permissions/exec-prompt-wiring.js';
import { buildLocalhostFetchApproval } from './permissions/localhost-fetch-approval.js';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from './provider-optimizer-wiring.js';
import {
  FeatureAnnouncementStore,
  createSandboxContainmentAnnouncer,
  featureAnnouncementsPath,
} from './feature-announcements.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import { ProviderOptimizer } from '../providers/optimizer.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import { CacheHitTracker } from '../providers/cache-strategy.js';
import { FavoritesStore } from '../providers/favorites.js';
import { BenchmarkStore } from '../providers/model-benchmarks.js';
import { ModelLimitsService } from '../providers/model-limits.js';
import { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import { computeUsageCostUsd } from '../providers/model-pricing.js';
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
import { deriveFeatureStates, bindFeatureSettingsBridge } from './feature-flags/feature-settings.js';
import { PolicyRuntimeState } from './permissions/policy-runtime.js';
import { loadConfiguredPolicyBundle } from './permissions/policy-config-loader.js';
import { bindPermissionModeChangeEvent } from '../permissions/mode-change-emitter.js';
import { PermissionManager, createPermissionConfigReader } from '../permissions/manager.js';
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
import { createOrchestrationEngine, createProviderBackedAttemptJudge, type OrchestrationEngine } from '../orchestration/index.js';

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
  readonly userPermissionRuleStore: UserPermissionRuleStore; // durable user-origin permission rules (remembered approvals); permissions.rules.* surface
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
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (same lifecycle posture as processRegistry — hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  /** Relay WebAuthn step-up ceremony service (shared by the stepup.* verbs and the relay gate's verifier). */
  readonly stepUpService: StepUpService;
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
  /**
   * Settable holder for the context_accounting tool's session source. The tool
   * is registered on the shared roster; an interactive consumer binds its
   * Orchestrator-backed source here (see tools/context-accounting).
   */
  readonly contextAccountingHolder: ContextAccountingHolder;
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

export {
  applyProviderOptimizerConfigMode,
  bindProviderOptimizerFeatureFlag,
} from './provider-optimizer-wiring.js';

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
    // Gate states derive from domain settings keys; the bridge keeps live
    // config.set changes flowing. Wired only for a manager this call owns.
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    bindFeatureSettingsBridge(configManager, featureFlags);
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
  providerRegistry.initCustomProviders(); providerRegistry.initProviderModelDiscovery();
  // ONE credential chain (env -> secrets -> subscription): boot applies secrets-backed keys; every secrets write/delete re-registers builtins LIVE (no restart); badges/picker/chat read the same instances.
  secretsManager.onDidChange(() => void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('live credential refresh failed', { error: summarizeError(error) })));
  void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('boot credential refresh failed', { error: summarizeError(error) }));
  const toolLLM = new ToolLLM({
    configManager,
    providerRegistry,
    runtimeBus: options.runtimeBus,
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
  const agentMessageBus = new AgentMessageBus(); agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader(join(workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({ messageBus: agentMessageBus });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager,
    providerRegistry,
  });
  // Conversation-snapshot sink bridge: AgentOrchestrator predates AgentManager, so it's
  // wired via setConversationSink, not a constructor dep (same ordering constraint as setRuntimeBus above).
  agentOrchestrator.setConversationSink({
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
  });
  // Cooperative cancellation bridge: same ordering constraint/setter pattern as setConversationSink above.
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
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true, modelCandidates: providerRegistry.listModels() }),
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
  // Data safety with no discipline: a daily snapshot of every SQLite store
  // this runtime writes, bounded by the retention engine. Timers are unref'd
  // so an undisposed scheduler cannot pin the event loop.
  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [
      { name: 'memory store', dbPath: memoryDbPath },
      { name: 'memory vector index', dbPath: resolveMemoryVectorDbPath(memoryDbPath) },
      { name: 'code index store', dbPath: codeIndexDbPath },
    ],
  });
  storeSnapshotScheduler.start();
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
    providerRegistry,
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
  // MCP elicitation/create requests ride the SAME approval broker as a permission
  // ask (see mcp/elicitation.ts) instead of the client dropping them with -32601.
  mcpRegistry.setElicitationHandler(createMcpElicitationApprovalHandler((input) => approvalBroker.requestApproval(input)));
  const tokenAuditor = new ApiTokenAuditor({
    managed: configManager.get('security.tokenAudit.managed'),
    featureFlags,
    defaultRotationCadenceMs:
      configManager.get('security.tokenAudit.rotationCadenceDays') * 24 * 60 * 60 * 1000,
    defaultRotationWarningThresholdMs:
      configManager.get('security.tokenAudit.rotationWarningDays') * 24 * 60 * 60 * 1000,
  });
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
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  // Poll-free runtime event for permission-mode changes so surfaces can render a live mode pill.
  bindPermissionModeChangeEvent(configManager, options.runtimeBus, 'runtime');
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({
    baseDir: workingDirectory,
    featureFlags,
    spillBackend: configManager.get('tools.overflowSpillBackend'),
  });
  const policyRuntimeState = new PolicyRuntimeState();
  loadConfiguredPolicyBundle(configManager, featureFlags, policyRuntimeState);
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
  // Durable user-origin permission rules (remembered approvals): one store per project, shared by
  // every PermissionManager here; permissions.rules.* lists/deletes. Background init is fail-safe.
  const userPermissionRuleStore = new UserPermissionRuleStore(join(configManager.getControlPlaneConfigDir(), 'permission-rules.json'));
  void userPermissionRuleStore.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));
  // Background/subagent tool calls are brokered through the SAME session
  // permission mode as the foreground turn loop. The ask handler is the shared
  // approval broker, so a background ask surfaces through the same blocked-on-
  // user machinery — here carrying the subagent's attribution. The escape hatch
  // (config permissions.backgroundAgents: 'allow-all') exempts background agents.
  const backgroundPermissionManager = new PermissionManager(
    (request) => approvalBroker.requestApproval({
      request,
      ...(request.attribution?.kind === 'background-agent'
        ? {
            routeId: request.attribution.agentId,
            metadata: {
              source: 'background-agent',
              agentId: request.attribution.agentId,
              ...(request.attribution.template ? { agentTemplate: request.attribution.template } : {}),
            },
          }
        : {}),
    }),
    createPermissionConfigReader(configManager),
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userPermissionRuleStore,
  );
  // The interactive session binds its Orchestrator-backed source onto this holder
  // after construction; passing it through here registers the context_accounting
  // tool on the shared roster (every consumer inherits it, like repo_map).
  const contextAccountingHolder = new ContextAccountingHolder();
  // Sandbox boundary escalations ride the SAME approval broker as a permission
  // ask and an MCP elicitation — one learned pattern, not five. The optional
  // model-judgment tier (dark flag) annotates or opt-in auto-approves the ask;
  // it never converts allow→deny and never touches the frozen catastrophic block.
  // (Wiring + judgment provider live in permissions/sandbox-escalation-wiring.ts.)
  const sandboxEscalationHandler = buildSandboxEscalationHandler({
    requestApproval: (input) => approvalBroker.requestApproval(input),
    providerRegistry,
    configManager,
    featureFlags,
  });
  // An exec command blocked on a terminal prompt (host-key confirmation,
  // credential ask) rides the same broker: the pending prompt surfaces through
  // every surface's approval machinery and the typed answer feeds the same
  // continuing run. (Wiring lives in permissions/exec-prompt-wiring.ts.)
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({
    requestApproval: (input) => approvalBroker.requestApproval(input),
  });
  // Localhost dev-server fetches ride the same broker: ask once, one-tap
  // "allow for this project", persisted as fetch.allowLocalhost.
  const localhostFetchApproval = buildLocalhostFetchApproval({
    requestApproval: (input) => approvalBroker.requestApproval(input),
    configManager,
  });
  // Announce-once receipts for default-on features: the first contained exec
  // run yields the one-time containment line (persisted, once per install).
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  const onSandboxedRun = createSandboxContainmentAnnouncer(announcementStore, (announcement) => {
    logger.info(announcement.text, { announcement: announcement.id });
  });
  agentOrchestrator.setDependencies({
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
    permissionManager: backgroundPermissionManager,
    contextAccountingHolder,
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

  // Honest-unpriced: usage prices through the ONE model pricing resolver (manual -> registration ->
  // provider-served -> catalog -> unknown; any resolvable model). Unknown/subscription yields null
  // (costState 'unpriced'), never $0. SHARED by fleet + orchestration so totals never double-count.
  const priceUsage = (model: string | undefined, usage: { inputTokens: number; outputTokens: number }): number | null => (model ? computeUsageCostUsd(providerRegistry.resolveModelPricing(model), usage) : null);

  // Orchestration engine — ships alongside wrfcController, untouched by this change. See the RuntimeServices interface comment.
  const orchestrationEngine = createOrchestrationEngine({
    agentManager,
    configManager,
    runtimeBus: options.runtimeBus,
    projectRoot: workingDirectory,
    priceUsage, judgeAttempts: createProviderBackedAttemptJudge(providerRegistry), // best-of-N judge (fleet.attempts.judge); never auto-picks unless opted in
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
  const stepUpService = new StepUpService({ secrets: secretsManager });
  registerGatewayVerbGroups(gatewayMethods, { processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager, approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input), watcherRegistry, userPermissionRuleStore, shellPaths, runtimeBus: options.runtimeBus, sessionPresence: { isAttached }, configManager, runtimeStore: options.runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker, workingDirectory, attemptsController: orchestrationEngine, stepUpService, memoryRegistry }); // see routes/register-gateway-verb-groups.ts
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
    userPermissionRuleStore,
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
    storeSnapshotScheduler,
    serviceRegistry,
    secretsManager,
    stepUpService,
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
    contextAccountingHolder,
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
