import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { createRuntimeSecretsManager } from './secrets-composition.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { SubscriptionManager, sharedSubscriptionsPath } from '../config/subscriptions.js';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore } from '../automation/index.js';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../channels/index.js';
import { ChannelDeliveryRouter } from '../channels/delivery-router.js';
import { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker, registerGatewayVerbGroups, controlPlaneStorePath } from '../control-plane/index.js';
import { StepUpService } from '../relay/step-up-service.js';
import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from '../control-plane/session-broker-sessions.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../control-plane/session-intents.js';
import { WatcherRegistry } from '../watchers/index.js';
import { TriggerManager } from '../triggers/manager.js';
import { createBunStreamHost, createProcessManagerTriggerHost, createTriggerActionExecutor } from '../triggers/hosts.js';
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
import { cancelAllAgentRuns, type AgentManager } from '../tools/agent/index.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { WrfcController } from '../agents/wrfc-controller.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import { continuationChainOptions } from '../agents/conversation-continuation.js';
import { PersonalCaptureHolder, conversationalTurnSpawnOptions } from '../personal-capture/index.js';
import { ProcessManager } from '../tools/shared/process-manager.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import { WorkspaceCheckpointManager } from '../workspace/checkpoint/index.js';
import { MemoryRegistry } from '../state/memory-registry.js';
import { MemoryStore } from '../state/memory-store.js';
import { CodeIndexStore } from '../state/code-index-store.js';
import { CodeIndexReindexScheduler } from '../state/code-index-reindex.js';
import { StoreSnapshotScheduler } from '../state/store-snapshots.js';
import { MemoryConsolidationScheduler } from '../state/memory-consolidation-scheduler.js';
import { PowerManager, wireRuntimePower, createUnavailablePowerSeam, type PowerPlatformSeam } from '../power/index.js';
import { emitProviderVoiceUsage } from './emitters/providers.js';
import { AppendOnlyRetentionScheduler, runStartupAppendOnlySweep } from './retention/append-only-registry.js';
import { createDisposalScope, registerRuntimePollers } from './disposal.js';
import { resolveMemoryVectorDbPath } from '../state/memory-vector-store.js';
import type { RuntimeEventBus } from './events/index.js';
import { createDomainDispatch } from './store/index.js';
import type { DomainDispatch, RuntimeStore } from './store/index.js';
import { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.js';
import { IntegrationHelperService } from './integration/helpers.js';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '../voice/index.js';
import { createVoiceSetupService } from './voice-setup.js';
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
import { PairingTokenManager } from '../pairing/pairing-token-store.js';
import { AcpHostService } from '../acp/host.js';
import { WebhookNotifier } from '../integrations/webhooks.js';
import { McpRegistry } from '../mcp/registry.js';
import { createMcpElicitationApprovalHandler } from '../mcp/elicitation.js';
import {
  createApprovalDerivedHandlers,
  createBrokeredPermissionManager,
  createPolicyRuntimeState,
  createUserPermissionRuleStore,
} from './permissions/permission-composition.js';
import {
  FeatureAnnouncementStore,
  featureAnnouncementsPath,
} from './feature-announcements.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { FavoritesStore } from '../providers/favorites.js';
import type { BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelLimitsService } from '../providers/model-limits.js';
import type { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import { buildPricingSeams } from './cost/pricing-seams.js';
import { SessionMemoryStore } from '../core/session-memory.js';
import { SessionLineageTracker } from '../core/session-lineage.js';
import { SessionChangeTracker } from '../sessions/change-tracker.js';
import { ExecutionPlanManager } from '../core/execution-plan.js';
import { AdaptivePlanner } from '../core/adaptive-planner.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import { IdempotencyStore } from './idempotency/index.js';
import { OverflowHandler } from '../tools/shared/overflow.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { ComponentHealthMonitor } from './perf/component-health-monitor.js';
import { WorktreeRegistry } from './worktree/registry.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { createShellPathService, type ShellPathService } from './shell-paths.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import { resolveRuntimeFeatureFlags } from './feature-flag-composition.js';
import { createProviderStack } from './provider-stack.js';
import { createAgentGraph } from './agent-graph.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import { bindPermissionModeChangeEvent } from '../permissions/mode-change-emitter.js';
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
import { attachConfigEmitBridge } from './config/index.js';
import { ObservedAgentSource } from './fleet/observed/source.js';
import { createOrchestrationEngine, createProviderBackedAttemptJudge, type OrchestrationEngine } from '../orchestration/index.js';
import { createFixWorkstreamRunner } from '../orchestration/fix-workstream-runner.js';
import { makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import {
  CacheRegistry,
  PauseController,
  wireDaemonMemoryGovernance,
  type MemoryGovernor,
} from './memory/index.js';

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
   * Opt-in: kick off the code index's initial build (Stage A) after
   * construction; fire-and-forget. Off by default so constructing
   * RuntimeServices never runs an unrequested source-tree walk.
   */
  readonly autoStartCodeIndex?: boolean | undefined;
  /**
   * Opt-in: fold host coding-agent sessions the daemon did not spawn into the
   * fleet as read-only observed rows. Off by default (test determinism); the standalone daemon (cli.ts) turns it on.
   */
  readonly observeExternalAgents?: boolean | undefined;
  /** Override the broker store path (default: home-scoped durable store). */
  readonly sessionStorePath?: string | undefined;
  /** Opt-in host power seam for sleep ownership; absent ⇒ non-spawning unavailable seam (test determinism), the standalone daemon (cli.ts) passes createHostPowerSeam(). */
  readonly powerSeam?: PowerPlatformSeam | undefined;
  /**
   * The daemon's state root when the host was told one (`--daemon-home`,
   * `GOODVIBES_DAEMON_HOME`, a test harness's temp tree). Threaded into
   * `SecretsManager` so the override actually MOVES the daemon-scoped
   * credential store; see runtime/secrets-composition.ts for what went wrong
   * while it did not. Absent = the machine default.
   */
  readonly daemonHome?: string | undefined;
}

export interface RuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /**
   * The `.goodvibes/<surface root>/` segment this composition's own state lives
   * under. Already returned by createRuntimeServices; declaring it here is what
   * lets a consumer ask for it instead of deriving a second one, the omission
   * that produced the unscoped pre-split control-plane store.
   */
  readonly surfaceRoot: string;
  /** SDK-owned memory governance: samples RSS/heap, sheds caches, pauses jobs, trips on leaks. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can observe and shrink. */
  readonly cacheRegistry: CacheRegistry;
  /** Backpressure seam the governor drives to pause/resume deferrable background jobs. */
  readonly pauseController: PauseController;
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
  /**
   * The trigger family's supervisor (stream watchers, model-free condition
   * checks, on-exit process triggers). This factory always constructs one, and
   * it does no work while `watchers.triggers.enabled` is false.
   *
   * OPTIONAL because hosts hand-compose RuntimeServices: goodvibes-agent builds
   * its own object literal, and a required field here turned "this host has no
   * trigger family" into a TypeError on daemon shutdown. Absence must mean no
   * triggers, never a crash, the same contract the fleet registry's
   * `triggerSupervisor` dep already honours.
   */
  readonly triggerManager?: TriggerManager | undefined;
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
  /** Repo code index (Stage A): schema-initialized eagerly; the build is never auto-triggered here (would walk arbitrary workingDirectories incl. test fixtures). */
  readonly codeIndexStore: CodeIndexStore;
  /** Stage B tool-site incremental reindex scheduler (bound to codeIndexStore). */
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler;
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (same lifecycle posture as processRegistry, hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  /** Periodic re-sweep of every registered append-only store (startup alone never prunes a daemon that stays up for weeks); unref'd timers, stop() on teardown. */
  readonly appendOnlyRetentionScheduler: AppendOnlyRetentionScheduler;
  /** Idle+schedule memory consolidation driver (this runtime is the store's single writer); unref'd timers, stop() on teardown. */
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  /** Sleep ownership: work inhibition, keep-awake toggle, sleep-edge hooks (platform/power). */
  readonly powerManager: PowerManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  /** Relay WebAuthn step-up ceremony service (shared by the stepup.* verbs and the relay gate's verifier). */
  readonly stepUpService: StepUpService;
  readonly subscriptionManager: SubscriptionManager;
  /** Per-pairing named revocable operator tokens (device-scoped). */
  readonly pairingTokens: PairingTokenManager;
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
  /** Settable holder for the context_accounting tool's session source; an interactive consumer binds its Orchestrator-backed source here. */
  readonly contextAccountingHolder: ContextAccountingHolder;
  /** Settable holder an interactive consumer binds its Orchestrator into, powering sessions.toolCalls.cancel + sessions.queuedMessages.* (same pattern as contextAccountingHolder). */
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  readonly wrfcController: WrfcController;
  /** Orchestration engine (alongside wrfcController; controller-compat.ts): opt-in pipeline scheduler, never auto-started. */
  readonly orchestrationEngine: OrchestrationEngine;
  readonly processManager: ProcessManager;
  /** Live process registry (fleet aggregation). No dispose seam exists; the unref'd tick runs only while subscribers exist, hosts dispose() themselves. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  readonly integrationHelpers: IntegrationHelperService;
  /** Re-root path-bound services to a new working directory (WorkspaceSwapManager). MemoryStore + ProjectIndex re-root in-process; others warn and keep their path until restart. @throws INVALID_PATH on failure. */
  rerootStores(newWorkingDir: string): Promise<void>;
  /**
   * Stop every poller this graph started (config watch, fleet tick, memory
   * governor, watcher registry, cross-session sweep, orchestration writer, push
   * sweep, knowledge scheduler, retention schedulers) and release their handles.
   *
   * Best-effort, total and idempotent: an owner that throws is logged and the
   * rest still come down. Dispose only a graph you constructed, a DaemonServer
   * handed runtime services by its caller does not own them.
   */
  dispose(): void;
}

export {
  applyProviderOptimizerConfigMode,
  bindProviderOptimizerFeatureFlag,
} from './provider-optimizer-wiring.js';

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const disposalScope = createDisposalScope('RuntimeServices'); // see ./disposal.ts
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'RuntimeServicesOptions surfaceRoot');
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const configManager = options.configManager;
  const featureFlags = resolveRuntimeFeatureFlags({ configManager, featureFlags: options.featureFlags });
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
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    surfaceRoot,
    configManager,
    ...(options.daemonHome === undefined ? {} : { daemonHome: options.daemonHome }),
  });
  // Provider subscriptions (OAuth sessions like the 'openai-subscriber' login)
  // live in the platform's SHARED tier, not this surface's own root: the
  // daemon hosts every conversational turn, and a login completed on another
  // surface (the TUI, the agent) must be visible to it. `legacyPath` is the
  // pre-shared-tier per-surface store this surface used to own; the manager
  // folds any newer records it finds there into the shared store once, at
  // construction, and never writes to or deletes it.
  const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), {
    legacyPath: shellPaths.resolveUserPath(surfaceRoot, 'subscriptions.json'),
  });
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath(surfaceRoot, 'services.json'), {
    secretsManager,
    subscriptionManager,
  });
  // The model stack, one implementation, shared with the pure-client
  // composition (provider-stack.ts): stores, registry, the live credential
  // chain, the tool LLM and the optimizer bound to its flag and config mode.
  const {
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    providerOptimizer,
  } = createProviderStack({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    featureFlags,
    runtimeBus: options.runtimeBus,
    shellPaths,
    surfaceRoot,
  });
  const localUserAuthManager = new UserAuthManager({ bootstrapFilePath: shellPaths.resolveUserPath(surfaceRoot, 'auth-users.json'), bootstrapCredentialPath: shellPaths.resolveUserPath(surfaceRoot, 'auth-bootstrap.txt') });
  // Per-pairing named revocable operator tokens (device-scoped); consulted by the operator-auth path. The cap is read per mint, so a `device.nodes.maxPaired` change applies to the next pairing without a restart.
  const pairingTokens = new PairingTokenManager(controlPlaneStorePath(shellPaths, surfaceRoot, 'pairing-tokens.json'), { maxPaired: () => configManager.get('device.nodes.maxPaired') });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(surfaceRoot, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(surfaceRoot, 'bookmarks'));
  const sessionManager = new SessionManager(workingDirectory, { surfaceRoot });
  // NOTE: sessionOrchestration is constructed AFTER sessionBroker (below), not
  // here, because its constructor reaps immediately and its owner-existence
  // predicate closes over the broker, building it here would hit a temporal
  // dead zone on the very first sweep.
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'watchers.json'),
    featureFlags,
    recoveryWindowMinutes: () => Number(configManager.get('watchers.recoveryWindowMinutes')), // read per restore
  });
  watcherRegistry.attachRuntime({ runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus });
  // The agent graph in its one working order, shared with the pure-client
  // composition (agent-graph.ts), because the two post-construction links
  // (conversation sink, cancellation source) are easy to omit and silent when
  // omitted.
  const { archetypeLoader, agentMessageBus, agentOrchestrator, agentManager } = createAgentGraph({
    runtimeBus: options.runtimeBus,
    configManager,
    providerRegistry,
    workingDirectory,
  });
  const wrfcController = new WrfcController(options.runtimeBus, agentMessageBus, {
    agentManager,
    configManager,
    projectRoot: workingDirectory,
    surfaceRoot,
  });
  agentManager.setWrfcController(wrfcController);
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({ hookDispatcher, configManager });
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'control-plane', 'approvals.json'),
  });
  // ONE home-scoped durable session store; project is DATA on each record.
  // `conversationGateConfig` keeps the live-agent handover behind the gate.
  const sessionBroker = new SharedSessionBroker({
    // Surface-SCOPED, like every other store this composition owns. The
    // default here was `resolveUserPath('control-plane', 'sessions.json')`,
    // no surface segment, so a composition that did not pass its own path got
    // the unscoped orphan directory. Same omission as the control-plane stores
    // beside it, same resolver now (control-plane-store-paths.ts).
    storePath: options.sessionStorePath ?? controlPlaneStorePath(shellPaths, surfaceRoot, 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    conversationGateConfig: configManager,
  });
  // Built here, after the broker, so the owner-existence predicate below has a
  // live broker to ask (see the note at sessionManager's construction).
  //
  // The broker is the authoritative register of session identity: every surface
  // that opens a session registers it here, and the task tool now keys its refs
  // on that same runtime session id rather than on a model-supplied argument.
  // Before that binding this predicate could not have been written honestly,
  // the graph was keyed by a free-form tool parameter that defaulted to the
  // literal 'local', which no register could ever resolve.
  //
  // Reaping on a "no" is still not the same as reaping on a certainty, so it is
  // deliberately not the only guard: the reaper additionally requires a record
  // to be older than its ownerless grace floor, and it never applies this
  // predicate to the legacy 'local' namespace at all. That way a broker that is
  // merely late, starting up, mid-reconnect, a session registering in another
  // process, costs nothing, and only a record that is both unowned AND stale
  // is collected.
  const sessionOrchestration = new CrossSessionTaskRegistry(
    shellPaths.resolveProjectPath(surfaceRoot, 'sessions', 'task-graph.json'),
    { sessionExists: (sessionId: string) => sessionBroker.getSession(sessionId) !== null },
  );
  // Created here so it can be handed to the agent tool registry below and
  // filled by registerGatewayVerbGroups further down, which is where the owner
  // profile store and occasions service are actually built.
  const personalCapture = new PersonalCaptureHolder();
  sessionBroker.setContinuationRunner(async ({ task, input }) => {
    const record = agentManager.spawn({
      mode: 'spawn',
      task,
      // Conversation first: a follow-up gets an answer, not a review chain,
      // only the authorization marker or a local surface opens one.
      ...continuationChainOptions(input, { configReader: configManager }),
      // The tools, the instruction and the bound write authority for a
      // conversational turn. The routing builder sets `restrictTools: true` and
      //, unless the routing intent named tools, no tool list at all, which
      // AgentManager reads as "only these" over an empty set. The turn then ran
      // with an empty registry and could record nothing the owner told it about
      // himself. Spread FIRST so a routing intent that DID name tools still
      // wins: that builder only emits a `tools` key when it has one.
      ...conversationalTurnSpawnOptions(input, { configReader: configManager }),
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true, modelCandidates: providerRegistry.listModels() }),
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
  // Repo source-tree code index (Stage A), shares memoryEmbeddingRegistry so
  // code + memory embeddings use one provider and one dimensionality. Schema
  // init only; build is not auto-triggered here (see codeIndexStore doc).
  const codeIndexDbPath = join(workingDirectory, '.goodvibes', surfaceRoot, 'code-index.sqlite');
  // Memory governance seams built EARLY so scheduler gates and the knowledge
  // background job can consult the pause controller before the MemoryGovernor
  // (constructed at the composition tail) drives it.
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  // Late-bound admission gate: the expensive entry points (knowledge job runs,
  // ingestion, semantic reindex/self-improve, consolidation, code-index) are
  // constructed before the MemoryGovernor; they capture this closure, and the
  // governor binds into it at the composition tail. Until then everything is
  // admitted (the daemon is still booting).
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const codeIndexStore = new CodeIndexStore(workingDirectory, codeIndexDbPath, memoryEmbeddingRegistry);
  codeIndexStore.init();
  if (options.autoStartCodeIndex) {
    codeIndexStore.scheduleBuild();
  }
  // Stage B: tool-site incremental reindex. Gated on autoStartCodeIndex AND the
  // built-state check inside the scheduler, an unbuilt index is a no-op.
  const codeInjectionSettingEnabled = (): boolean => options.autoStartCodeIndex === true;
  const codeIndexReindexScheduler = new CodeIndexReindexScheduler({
    target: codeIndexStore,
    workingDirectory,
    // Honor governor backpressure: a paused code-index reindex job stops
    // scheduling new work until the governor resumes it, and the critical
    // memory tier refuses new reindex work outright.
    isEnabled: () => codeInjectionSettingEnabled() && !pauseController.isPaused('code-index-reindex') && admitExpensiveWork('code-index reindex').allowed,
  });
  // Daily snapshots of every SQLite store, bounded by the retention engine (unref'd timers).
  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [{ name: 'memory store', dbPath: memoryDbPath }, { name: 'memory vector index', dbPath: resolveMemoryVectorDbPath(memoryDbPath) }, { name: 'code index store', dbPath: codeIndexDbPath }],
  });
  storeSnapshotScheduler.start();
  // Start-time janitor: one retention pass over every registered append-only
  // store (best-effort). Every root the composition knows is passed, omitting
  // logDir/telemetryDir/homeDirectory would silently skip the activity-log,
  // telemetry-ledger, and recovery-snapshot stores on every sweep.
  const appendOnlyRetentionRoots = {
    workingDirectory,
    surfaceRoot,
    homeDirectory,
    logDir: shellPaths.resolveUserPath('logs'),
    telemetryDir: shellPaths.resolveUserPath('telemetry'),
  };
  const appendOnlyRetentionConfigGet = (k: string): unknown => configManager.get(k as never);
  runStartupAppendOnlySweep(appendOnlyRetentionRoots, appendOnlyRetentionConfigGet);
  // ...and again every few hours for as long as this runtime lives. A daemon
  // that stays up for weeks would otherwise never sweep any of those six
  // stores again after boot, which is precisely the window in which they
  // grow. Unref'd timers; the host that tears a runtime down stop()s it, the
  // same posture as storeSnapshotScheduler above.
  const appendOnlyRetentionScheduler = new AppendOnlyRetentionScheduler({
    roots: appendOnlyRetentionRoots,
    configGet: appendOnlyRetentionConfigGet,
  });
  appendOnlyRetentionScheduler.start();
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses, a hand-edited settings file needs no restart. The
  // underlying file watchers are unref'd, so this never pins the event loop.
  const stopConfigWatch = configManager.watchConfigFiles(); // handle kept: dropping it is what left a 250ms poll running forever
  // Memory consolidation runs HERE, this runtime is the memory store's single
  // writer. Idle trigger (no busy broker sessions) + slow schedule fallback;
  // reversible outcomes only, receipts retained, learning.consolidation.* tunes it.
  // Announce-once receipts (constructed HERE, before its first consumer): the
  // consolidation scheduler's run receipts and later the sandbox containment
  // line share the one store.
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler({
    memoryRegistry,
    configSource: configManager,
    // Idle AND not paused by the governor AND admitted at the current memory
    // tier, memory pressure defers consolidation.
    isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed,
    // Attach notice per run that DID something: an SDK-composed daemon records
    // what consolidation merged/decayed/proposed without consumer re-wiring.
    onReceipt: (receipt) => {
      const changed = receipt.merged.length + receipt.archived.length + receipt.decayed.length + receipt.proposed.length;
      if (changed === 0) return;
      announcementStore.record(
        `memory-consolidation:${receipt.runId}`,
        `Memory consolidation ran (${receipt.trigger}): ${receipt.merged.length} merged, ${receipt.decayed.length} decayed, ${receipt.archived.length} archived, ${receipt.proposed.length} proposal${receipt.proposed.length === 1 ? '' : 's'} awaiting review.`,
      );
    },
  });
  memoryConsolidationScheduler.start();
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
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: knowledgeSemanticService,
    admitExpensiveWork,
  });
  knowledgeService.attachRuntimeBus(options.runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    admitExpensiveWork,
    semanticService: agentKnowledgeSemanticService,
  });
  agentKnowledgeService.attachRuntimeBus(options.runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, {
    semanticService: homeGraphSemanticService,
    admitExpensiveWork,
  });
  const projectPlanningService = new ProjectPlanningService(knowledgeStore, {
    defaultProjectId: projectPlanningProjectIdFromPath(workingDirectory),
    runtimeBus: options.runtimeBus,
  });
  wrfcController.setWorkPlanService(projectPlanningService);
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, {
    readConfig: (key) => configManager.get(key as never),
    managedVoiceRoot: shellPaths.resolveUserPath('voice'),
  });
  // Metered voice spend -> attribution ingest; local engines emit nothing.
  const voiceService = new VoiceService(voiceProviders, (usage) => emitProviderVoiceUsage(options.runtimeBus, { sessionId: 'system', traceId: `voice:${Date.now()}`, source: 'voice-service' }, { provider: usage.providerId, modelId: usage.modelId, kind: usage.kind, billableUnits: usage.billableUnits, unit: usage.unit }));
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
  const distributedRuntime = new DistributedRuntimeManager(shellPaths.resolveProjectPath(surfaceRoot, 'remote', 'distributed-runtime.json'));
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
  const policyRuntimeState = createPolicyRuntimeState(configManager, featureFlags);
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
  // wired up immediately rather than only on first explicit use, otherwise
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
  // Same store + same manager wiring the pure-client composition uses (permissions/permission-composition.ts).
  const userPermissionRuleStore = createUserPermissionRuleStore(configManager);
  const backgroundPermissionManager = createBrokeredPermissionManager({
    requestApproval: (input) => approvalBroker.requestApproval(input),
    configManager,
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userRuleStore: userPermissionRuleStore,
  });
  // The interactive session binds its Orchestrator-backed source onto this holder
  // after construction; passing it through here registers the context_accounting
  // tool on the shared roster (every consumer inherits it, like repo_map).
  const contextAccountingHolder = new ContextAccountingHolder();
  // The three handlers that must ride the SAME ask seam as a tool permission
  // (sandbox-boundary escalation, a blocked exec prompt, a loopback fetch) plus
  // the announce-once containment receipt, one implementation, shared with the
  // pure-client composition (permissions/permission-composition.ts).
  // (Announcement store constructed above, before the consolidation scheduler.)
  const {
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
  } = createApprovalDerivedHandlers({
    requestApproval: (input) => approvalBroker.requestApproval(input),
    providerRegistry,
    configManager,
    featureFlags,
    announcementStore,
  });
  // Late-bound CI auto-watch observer (filled by registerGatewayVerbGroups below).
  let ciAutoWatchObserver: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | null = null;
  agentOrchestrator.setDependencies({
    personalCapture,
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
    toolExecutionObserver: (toolName, args, success) => ciAutoWatchObserver?.(toolName, args, success),
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

  // Honest-unpriced dollars + provenance over the ONE pricing resolver (pricing-seams.ts).
  const { priceUsage, priceProvenance } = buildPricingSeams(providerRegistry);

  // Orchestration engine, ships alongside wrfcController, untouched by this change. See the RuntimeServices interface comment.
  const orchestrationEngine = createOrchestrationEngine({
    agentManager,
    configManager,
    runtimeBus: options.runtimeBus,
    projectRoot: workingDirectory,
    priceUsage, priceProvenance, judgeAttempts: createProviderBackedAttemptJudge(providerRegistry), // best-of-N judge (fleet.attempts.judge); never auto-picks unless opted in
    fleetCapacity: () => fleetCapacityProbe(),
    maxItemRetries: 2,
  });
  // The planned-fix path (the single-fixer prompt path is GONE): review
  // findings decompose into dependency-graph workstreams run by the ONE engine.
  wrfcController.setFixWorkstreamRunner(createFixWorkstreamRunner({ engine: orchestrationEngine }));

  // Live process registry, narrow structural deps only, constructed
  // after every source manager exists. See the RuntimeServices interface
  // comment for the dispose story (no RuntimeServices-wide shutdown seam yet).
  // Archive-aware: finished agent/swarm subtrees can be moved out of the
  // live fleet view into a session-scoped archive (see fleet/archive.ts).
  // Hosted third-party coding agents (ACP): permission asks route through the SHARED approval broker (approvals panel + push like any native ask); each hosted agent maps onto a kind-'acp' shared session.
  const acpHost = new AcpHostService({
    requestPermission: (request) => approvalBroker.requestApproval({ request }),
    registerSession: ({ id, title, agentTitle, cwd }) => void sessionBroker
      .register({ sessionId: id, kind: 'acp', title, project: cwd, participant: { surfaceKind: 'service', surfaceId: `acp-host:${agentTitle}`, lastSeenAt: Date.now() } })
      .catch(() => { /* best-effort; the fleet row is authoritative */ }),
  })
  // The ONE fleet ceiling's live probe (fleet.maxSize): native + ACP-hosted +
  // elastic fixers; responsibility only, by construction (fleet-count.ts).
  // Hoisted fn, referenced by the engine above, called only at tick time.
  function fleetCapacityProbe() {
    return makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), agentManager, acpHost })();
  }
;
  // Read-only detection of externally-launched coding-agent sessions on this
  // host (Claude Code / Codex the daemon did not spawn). These fold in as
  // observed rows for visibility + steer; they NEVER count against fleet.maxSize
  // (fleet-count.ts accepts only owned sources by construction). Opt-in so the
  // generic factory never scans the host process table by default; absence (or
  // opt-out) is a quiet empty set.
  const observedAgents = options.observeExternalAgents ? new ObservedAgentSource() : undefined;
  // The trigger family. Constructed unconditionally so `watchers.triggers.enabled`
  // is a real runtime toggle rather than a restart-only one: the manager reads
  // its config live on every access and does no work while the flag is off.
  // Its process host is ProcessManager-backed, so a supervised on-exit child
  // inherits the same credential-env scrub, live output collection and
  // SIGTERM→SIGKILL watchdog as any other background command.
  const triggerManager = new TriggerManager({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'triggers.json'),
    config: () => ({
      enabled: configManager.get('watchers.triggers.enabled'),
      backoffLadderMs: configManager.get('watchers.triggers.backoffLadderMs'),
      breakerStrikes: configManager.get('watchers.triggers.breakerStrikes'),
      defaultCheckIntervalMs: configManager.get('watchers.triggers.defaultCheckIntervalMs'),
      probeTimeoutMs: configManager.get('watchers.triggers.probeTimeoutMs'),
      maxConcurrentChecks: configManager.get('watchers.triggers.maxConcurrentChecks'),
      observationRingSize: configManager.get('watchers.triggers.observationRingSize'),
      runHistoryLimit: configManager.get('watchers.triggers.runHistoryLimit'),
      runHistoryTtlHours: configManager.get('watchers.triggers.runHistoryTtlHours'),
      eventLogLimit: configManager.get('watchers.triggers.eventLogLimit'),
      eventLogTtlHours: configManager.get('watchers.triggers.eventLogTtlHours'),
      sweepIntervalMs: configManager.get('watchers.triggers.sweepIntervalMs'),
      supervisionTickMs: configManager.get('watchers.triggers.supervisionTickMs'),
      streamQueueLimit: configManager.get('watchers.triggers.streamQueueLimit'),
      streamBatchLines: configManager.get('watchers.triggers.streamBatchLines'),
      streamBatchIntervalMs: configManager.get('watchers.triggers.streamBatchIntervalMs'),
      onExitMaxDurationMs: configManager.get('watchers.triggers.onExitMaxDurationMs'),
      onExitStdin: configManager.get('watchers.triggers.onExitStdin'),
      outputTailBytes: configManager.get('watchers.triggers.outputTailBytes'),
    }),
    actions: createTriggerActionExecutor({ agents: agentManager, processManager }),
    processHost: createProcessManagerTriggerHost(processManager),
    streamHost: createBunStreamHost(),
    sessionIsLive: (sessionId: string) => sessionBroker.getSession(sessionId) !== null,
  });

  const processRegistry = withFleetArchive(createProcessRegistry({
    agentManager,
    wrfcController,
    orchestrationEngine,
    processManager,
    watcherRegistry,
    triggerSupervisor: triggerManager,
    workflow: {
      workflowManager: workflow.workflowManager,
      triggerManager: workflow.triggerManager,
      scheduleManager: workflow.scheduleManager,
    },
    approvalBroker,
    sessionBroker,
    runtimeBus: options.runtimeBus,
    priceUsage,
    priceProvenance,
    codeIndexService: codeIndexStore,
    acpHost,
    observedAgents,
  }));

  // Surface fleet lifecycle deltas on the runtime bus `fleet` domain (gateway fans it out; no polling). sessionPresence gates needs-input push suppression. Both subscriptions live for the registry's lifetime.
  attachFleetEmitBridge({ registry: processRegistry, bus: options.runtimeBus });
  // Key-level config changes on the runtime bus `config` domain, so a client whose settings live in the daemon gets live notices instead of polling; secret-bearing keys travel by name only (runtime/config/emit-bridge.ts).
  disposalScope.registry.add('config event bridge', attachConfigEmitBridge({ config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) }, bus: options.runtimeBus }));
  const isAttached = (sessionId: string): boolean => {
    const s = sessionBroker.getSession(sessionId);
    return s ? hasFreshSurfaceParticipant(s, Date.now(), SURFACE_ROUTE_FRESHNESS_MS) : false;
  };
  const stepUpService = new StepUpService({ secrets: secretsManager });
  const sessionLiveTurnControls = new SessionLiveTurnControlsHolder();
  // Sleep ownership: work-signal inhibition, keep-awake toggle, sleep-edge checkpoint + wake catch-up.
  const powerManager = wireRuntimePower({
    seam: options.powerSeam ?? createUnavailablePowerSeam('runtime services constructed without a host power seam'),
    readConfig: (key) => configManager.get(key as never),
    writeConfig: (key, value) => configManager.setDynamic(key as never, value),
    subscribeConfig: (key, cb) => configManager.subscribe(key as never, cb as never),
    runtimeBus: options.runtimeBus,
    sleepCheckpoint: () => storeSnapshotScheduler.tick(),
    wakeCatchUp: [() => memoryConsolidationScheduler.tick(), () => storeSnapshotScheduler.tick(), async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }] });
  // Construct + start the MemoryGovernor (default ON, a safety feature) with the
  // standard KNOWN cache adapters (see wireDaemonMemoryGovernance).
  const { memoryGovernor } = wireDaemonMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath(surfaceRoot, 'memory', 'tripwire-receipt.json'),
    // REAL cache adapters: genuine counts + trims that reclaim (job-run
    // history pruning; broker GC + bucket truncation).
    knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
    sessionBroker,
    // Graceful tripwire shutdown flushes in-flight state via ASYNC store snapshots (fs/promises): sync copyFileSync on a stalled disk would block the event loop, so the governor's 10s shutdown ceiling could never fire, threadpool copies keep it enforceable.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  // Late-bind the admission gate now that the governor exists: the expensive
  // entry points captured `admitExpensiveWork` earlier via this holder.
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);
  // Managed local-voice provisioning: single-flight one-act install +
  // status read carrying live install progress while an install runs
  // (surfaces poll status during the ~209MB provision). Ownership-aware
  // preconfigure, breaker reset, and admission gating live in
  // runtime/voice-setup.ts.
  const managedVoiceRoot = shellPaths.resolveUserPath('voice');
  const voiceSetup = createVoiceSetupService({
    managedVoiceRoot,
    getConfig: (k) => String(configManager.get(k as never) ?? ''),
    setConfig: (k, v) => configManager.setDynamic(k as never, v),
    resetLocalEngineFailureState: () => voiceProviders.get('local')?.resetEngineFailureState?.(),
    admitExpensiveWork: (label) => admitExpensiveWork(label),
  });
  registerGatewayVerbGroups(gatewayMethods, { homeDirectory, processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager, approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input), stampFixSessionOnApproval: (offerCallId, outcome) => approvalBroker.stampFixSession(offerCallId, outcome), watcherRegistry, userPermissionRuleStore, shellPaths, surfaceRoot, runtimeBus: options.runtimeBus, sessionPresence: { isAttached }, configManager, runtimeStore: options.runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker, channelPolicy, workingDirectory, attemptsController: orchestrationEngine, stepUpService, memoryRegistry, pairingTokens, acpHost, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup, credentialWrites: { config: configManager, secrets: secretsManager }, approvalRaise: approvalBroker, disposal: disposalScope.registry, personalCapture, onCiAutoWatch: (observer) => { ciAutoWatchObserver = observer; } }); // see routes/register-gateway-verb-groups.ts
  // Teardown for every poller started above. RuntimePollerOwners is all-required,
  // so a poller added to this graph later cannot compile without being named here.
  registerRuntimePollers(disposalScope.registry, {
    stopConfigWatch, watcherRegistry, storeSnapshotScheduler, appendOnlyRetentionScheduler,
    memoryConsolidationScheduler, codeIndexReindexScheduler, sessionOrchestration,
    knowledgeService, agentKnowledgeService, wrfcController, orchestrationEngine, homeGraphService,
    processRegistry, memoryGovernor, triggerManager, agentOrchestrator, cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
  });
  return {
    workingDirectory,
    homeDirectory,
    surfaceRoot,
    memoryGovernor,
    cacheRegistry,
    pauseController,
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
    triggerManager,
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
    appendOnlyRetentionScheduler,
    memoryConsolidationScheduler,
    powerManager,
    serviceRegistry,
    secretsManager,
    stepUpService,
    subscriptionManager,
    localUserAuthManager,
    pairingTokens,
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
    sessionLiveTurnControls,
    wrfcController,
    orchestrationEngine,
    processManager,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    dispose: (): void => disposalScope.dispose(),
    async rerootStores(newWorkingDir: string): Promise<void> {
      const newMemoryDbPath = join(newWorkingDir, '.goodvibes', surfaceRoot, 'memory.sqlite');
      await memoryStore.reroot(newMemoryDbPath);

      // Re-root the code index alongside memory. Otherwise it keeps
      // pointing at the old tree after a workspace swap.
      const newCodeIndexDbPath = join(newWorkingDir, '.goodvibes', surfaceRoot, 'code-index.sqlite');
      await codeIndexStore.reroot(newWorkingDir, newCodeIndexDbPath);

      await projectIndex.reroot(newWorkingDir);

      // Subsystems that cannot be live-rerooted emit a warn log.
      // They continue operating at their current root path until the next process restart,
      // at which point --working-dir / daemon-settings.json points to the new path.
      // This is acceptable because: (a) the swap endpoint is daemon-token-gated,
      // (b) these services primarily write user-scoped state (auth, bookmarks, profiles)
      // that is not workspace-scoped, and (c) knowledge/artifact stores resolve paths
      // through configManager which does not hot-reload during a running session.
      const cannotReroot = [
        'knowledgeStore (SQLite at configManager-resolved path, restart required)',
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
