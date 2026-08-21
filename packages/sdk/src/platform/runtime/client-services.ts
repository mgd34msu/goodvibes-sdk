/**
 * client-services.ts, the composition shape for a surface that runs its own
 * interactive loop and reaches a daemon for everything else.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * `RuntimeServices` (services.ts) is the DAEMON-GRADE graph: a hundred-odd
 * required fields, several of them concretely typed daemon furniture, the
 * persisting `SharedSessionBroker`, the `GatewayMethodCatalog` that SERVES
 * verbs, the watcher registry, channel delivery, automation, pairing tokens.
 * A product whose job is a terminal or a chat surface cannot type-check against
 * it without constructing all of that, which is how both surface products ended
 * up embedding a daemon they did not want.
 *
 * `ClientRuntimeServices` is the other shape: what a surface's turn genuinely
 * needs IN-PROCESS. Nothing here is removed from `RuntimeServices` and nothing
 * about it changes, this is purely additive, and the daemon-grade graph still
 * satisfies the shared part of this shape unchanged (see
 * {@link ClientRuntimeServicesFromHost} and the compile-pin in the tests).
 *
 * ── What is in, and why ────────────────────────────────────────────────────
 *
 * The rule applied to every field: it belongs here when the surface's own turn
 * cannot run correctly without it in-process. Everything a daemon can answer
 * over a verb is out.
 *
 * IN, the loop itself (agent graph, tool-facing state, workflow services,
 * sandbox session registry, the two settable holders an interactive session
 * binds its orchestrator into), the model stack (registry, optimizer, limits,
 * favourites, benchmarks, tool LLM), permissions AS A CLIENT (a manager, a
 * local rule store for approvals this surface remembers, and the raise seam
 * that carries an ask to whoever prompts), config + secrets + services, the
 * event bus/store/dispatch, hooks, plugins, MCP, the local file cache and
 * project index the file tools read, transcript persistence, and the two spine
 * CLIENTS through which session identity and memory reach the daemon.
 *
 * OUT, the session broker as a SERVER (only the dispatch seam remains, see
 * below), the gateway method catalog, watchers, channels and delivery routing,
 * automation, cluster, device posture, the knowledge/home-graph/code-index
 * stores and their schedulers, voice and media services, fleet aggregation,
 * remote runner supervision, retention and snapshot schedulers, the memory
 * governor. Each is either something the daemon serves over an existing verb
 * family or something only one process on a machine may own.
 *
 * This is a FLOOR, not a ceiling. A surface that wants more, the review/fix
 * workstream controller, a voice path, its own fleet view, builds it over the
 * pieces here; none of those need daemon furniture either, they are simply not
 * required for a turn to run.
 *
 * ── The two narrowings ─────────────────────────────────────────────────────
 *
 * `sessionBroker` and `userPermissionRuleStore` keep their `RuntimeServices`
 * names (that is what lets a daemon-grade graph satisfy this shape without a
 * single change to it) but are typed as INTERFACES rather than the concrete
 * classes:
 *
 * - `sessionBroker: SessionContinuationDispatch`, the inbound-dispatch seam
 *   only. A surface still runs the loop, so it must be able to bind "work
 *   arrived for a session I host" to its own runner; it must NOT have to own a
 *   persisting broker to do so. `SharedSessionBroker` satisfies this, and so
 *   does a wire-backed dispatch that polls `sessions.inputs.list` and calls the
 *   same runner.
 * - `userPermissionRuleStore: UserPermissionRuleAccess`, read the remembered
 *   rules, add one. Local remembering by a surface is legitimate (it is the
 *   surface that prompted); the canonical store and its `permissions.rules.*`
 *   verbs stay with the daemon. `PermissionManager` already took exactly this
 *   Pick, so this narrowing renames an idiom rather than inventing one.
 */

import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { SubscriptionManager, sharedSubscriptionsPath } from '../config/subscriptions.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { createRuntimeSecretsManager } from './secrets-composition.js';
import { ArtifactStore } from '../artifacts/index.js';
import { SessionLiveTurnControlsHolder } from '../control-plane/index.js';
import type { SharedSessionContinuationRunner } from '../control-plane/session-intents.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { cancelAllAgentRuns, type AgentManager } from '../tools/agent/index.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import { ProcessManager } from '../tools/shared/process-manager.js';
import { OverflowHandler } from '../tools/shared/overflow.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import { HookActivityTracker } from '../hooks/activity.js';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '../hooks/index.js';
import { PluginManager } from '../plugins/manager.js';
import { SessionManager } from '../sessions/manager.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import { McpRegistry } from '../mcp/registry.js';
import { createMcpElicitationApprovalHandler } from '../mcp/elicitation.js';
import { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.js';
import { PermissionManager } from '../permissions/manager.js';
import { bindPermissionModeChangeEvent } from '../permissions/mode-change-emitter.js';
import type { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { FavoritesStore } from '../providers/favorites.js';
import type { BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelLimitsService } from '../providers/model-limits.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createWorkflowServices, type WorkflowServices } from '../tools/workflow/index.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { createShellPathService, type ShellPathService } from './shell-paths.js';
import { claimSurfaceHome } from './home-single-writer.js';
import { requireSurfaceRoot } from './surface-root.js';
import { createDisposalScope } from './disposal.js';
import { createDomainDispatch, type DomainDispatch, type RuntimeStore } from './store/index.js';
import type { RuntimeEventBus } from './events/index.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import { resolveRuntimeFeatureFlags } from './feature-flag-composition.js';
import { createProviderStack } from './provider-stack.js';
import type { ProviderModelDiscoveryMode, ProviderRegistryFactory } from './provider-stack.js';
import { createAgentGraph } from './agent-graph.js';
import { attachConfigEmitBridge } from './config/index.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from './feature-announcements.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import {
  createApprovalDerivedHandlers,
  createBrokeredPermissionManager,
  createPolicyRuntimeState,
  createUserPermissionRuleStore,
  type ApprovalRaiser,
  type UserPermissionRuleAccess,
} from './permissions/permission-composition.js';
import type { SessionSpineClient } from './session-spine/index.js';
import { MemorySpineClient, type MemoryAccess, type MemoryTransport } from './memory-spine/index.js';

export type { ApprovalRaiser, UserPermissionRuleAccess } from './permissions/permission-composition.js';
// The three floor options a product may need to preserve a posture the default
// would silently reverse, launch tolerance, discovery timing, and whether a
// hook can reach the agent manager. Re-exported here so a caller configures the
// floor through one import rather than reaching into provider-stack.
export type {
  ProviderModelDiscoveryMode,
  ProviderRegistryConstructionOptions,
  ProviderRegistryFactory,
} from './provider-stack.js';
// The manager itself, beside the two types this module already published. Every
// composition that brokers its asks, this one, the SDK's daemon-grade graph,
// and the daemon product's, needs the same mapping from a background-agent
// attribution to the raise's routeId/metadata, and a composition that cannot
// import it writes that mapping out again.
export { createBrokeredPermissionManager } from './permissions/permission-composition.js';
export type { BrokeredPermissionManagerOptions } from './permissions/permission-composition.js';

/**
 * The inbound-dispatch seam: how a surface binds its loop to work that arrives
 * for a session it is hosting (a steer, a follow-up, a continuation).
 *
 * Deliberately one method. A surface needs to RECEIVE dispatch; it does not
 * need to own the register that decides who receives it. `SharedSessionBroker`
 * satisfies this structurally, so a daemon-grade composition needs no adapter;
 * a client-mode surface satisfies it with an inbound poller over
 * `sessions.inputs.list`/`sessions.inputs.deliver`.
 */
export interface SessionContinuationDispatch {
  setContinuationRunner(runner: SharedSessionContinuationRunner | null): void;
}

/**
 * A dispatch seam that holds the runner and nothing else, for a surface with
 * no inbound source yet, and for tests. `runner()` returns whatever was bound,
 * so a caller that later grows an inbound source can drive it.
 */
export function createHeldSessionDispatch(): SessionContinuationDispatch & {
  runner(): SharedSessionContinuationRunner | null;
} {
  let held: SharedSessionContinuationRunner | null = null;
  return {
    setContinuationRunner(runner) { held = runner; },
    runner() { return held; },
  };
}

/**
 * What a surface's interactive loop composes. See the module header for the
 * in/out rule and the two narrowings.
 */
export interface ClientRuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** This product's storage root (`tui`, `agent`, …); every per-product path derives from it. */
  readonly surfaceRoot: string;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;

  // Credentials this surface reads as a client of its own config tree.
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly subscriptionManager: SubscriptionManager;

  // The model stack.
  readonly providerRegistry: ProviderRegistry;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly providerOptimizer: ProviderOptimizer;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly toolLLM: ToolLLM;

  // The loop.
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly workflow: WorkflowServices;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly processManager: ProcessManager;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly overflowHandler: OverflowHandler;
  /** Settable holder for the context_accounting tool's session source. */
  readonly contextAccountingHolder: ContextAccountingHolder;
  /** Settable holder an interactive consumer binds its Orchestrator into (turn cancel, queued-message edits). */
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;

  // Tools that execute in this process.
  readonly mcpRegistry: McpRegistry;
  readonly artifactStore: ArtifactStore;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;

  // Hooks, policy, permissions.
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly policyRuntimeState: PolicyRuntimeState;
  /** Durable rules this surface remembered for its OWN asks, the interface, not the daemon's store. */
  readonly userPermissionRuleStore: UserPermissionRuleAccess;
  /** The foreground permission gate for this surface's turns. */
  readonly permissionManager: PermissionManager;
  /** Raise an ask. In-process for an embedded surface; `approvals.raise` + a local prompt for a client. */
  readonly requestApproval: ApprovalRaiser;

  /**
   * The inbound-dispatch seam. Named `sessionBroker` because that is the field
   * a daemon-grade `RuntimeServices` already carries, the NAME is shared so
   * the graphs stay interchangeable; the TYPE is narrowed to what a surface
   * needs (see {@link SessionContinuationDispatch}).
   */
  readonly sessionBroker: SessionContinuationDispatch;

  // The two spine clients. Null means "this surface mirrors nowhere", an
  // honest offline posture, not a missing dependency.
  readonly sessionSpine: SessionSpineClient | null;
  readonly memoryAccess: MemorySpineClient | null;

  // Local file-tool state (surface-local by design: the editor, the file cache
  // and the project index read this machine's tree).
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;

  /** Stop every poller and bridge this composition started. Idempotent. */
  dispose(): void;
}

/**
 * The members of {@link ClientRuntimeServices} that a pure client adds on top
 * of what a daemon-grade graph already provides.
 *
 * Each is something the daemon composition IS rather than HAS: it does not
 * carry a foreground permission manager (it prompts nobody), it does not carry
 * spine clients (it is the spine), it does not carry the file-tool caches at
 * the top level, and its `surfaceRoot` is a construction option rather than a
 * field.
 */
export type ClientOnlyServiceMember =
  | 'surfaceRoot'
  | 'permissionManager'
  | 'requestApproval'
  | 'sessionSpine'
  | 'memoryAccess'
  | 'fileCache'
  | 'projectIndex';

/**
 * The part of the client shape a daemon-grade `RuntimeServices` already
 * satisfies, field for field, with no change to it whatsoever.
 *
 * This is the type SDK code should take when it wants "a composition that can
 * run a turn" and should not care which product built it. The compile-pin in
 * client-services.test.ts asserts `RuntimeServices` is assignable here; if a
 * future field is added to the client shape that the daemon graph does not
 * carry, that pin fails and the field has to be named in
 * {@link ClientOnlyServiceMember} deliberately rather than by accident.
 */
export type ClientRuntimeServicesFromHost = Omit<ClientRuntimeServices, ClientOnlyServiceMember>;

export interface ClientRuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  /** This product's storage root (`tui`, `agent`, …). */
  readonly surfaceRoot: string;
  readonly workingDir: string;
  readonly homeDirectory: string;
  readonly featureFlags?: FeatureFlagManager | undefined;
  /**
   * How an ask reaches whoever answers it. A surface with an adopted daemon
   * posts `approvals.raise` and prompts locally; an embedded surface passes its
   * own broker's `requestApproval`.
   */
  readonly requestApproval: ApprovalRaiser;
  /** Inbound dispatch for sessions this surface hosts. Default: a held dispatch (nothing inbound yet). */
  readonly sessionDispatch?: SessionContinuationDispatch | undefined;
  /** Session-identity mirror to the adopted daemon. Absent ⇒ this surface mirrors nowhere. */
  readonly sessionSpine?: SessionSpineClient | undefined;
  /**
   * Memory for this surface's turns: the offline local access always, plus the
   * wire transport once a compatible daemon is adopted. Absent ⇒ no memory
   * (turns run; recall is empty).
   */
  readonly memory?: {
    readonly local: MemoryAccess;
    readonly transport?: MemoryTransport | undefined;
  } | undefined;
  /**
   * Whether a session id still has an owner, for the cross-session task
   * reaper. Default: always true, an unknown session is treated as still
   * owned, so ignorance never reaps.
   */
  readonly isSessionLive?: ((sessionId: string) => boolean) | undefined;
  /** The daemon's state root when this host was told one; threaded into the secrets manager. */
  readonly daemonHome?: string | undefined;
  /**
   * How the provider registry is constructed. Default: `new ProviderRegistry`.
   *
   * A product that must boot with broken or absent provider credentials passes
   * `createLaunchTolerantProviderRegistry`. Without this, adopting the floor
   * would silently trade launch tolerance for a crash before the first frame.
   */
  readonly providerRegistryFactory?: ProviderRegistryFactory | undefined;
  /**
   * Whether provider model discovery runs at construction. Default: `run`.
   *
   * `skip` is for a composition that will not outlive discovery's unawaited
   * write, a suite against a temp workspace, a one-shot subcommand.
   */
  readonly modelDiscovery?: ProviderModelDiscoveryMode | undefined;
  /**
   * Whether the hook dispatcher is handed the agent manager. Default: `attach`.
   *
   * `withhold` is a deliberate capability boundary, not an oversight: a hook
   * that cannot reach the agent manager cannot spawn an agent, and at least one
   * product pins that refusal as a feature. It is spelled out as an option
   * precisely so the absence stays legible, an omitted dependency reads as a
   * wiring bug to the next person, a named `withhold` reads as the decision it is.
   */
  readonly hookAgentManager?: 'attach' | 'withhold' | undefined;
  /**
   * Whether this composition claims its surface home as the single live writer.
   * Default: `off`.
   *
   * `claim` refuses to compose when another LIVE process already owns
   * `<homeDirectory>/.goodvibes/<surfaceRoot>/`, throwing
   * `SurfaceHomeInUseError`, whose message names the holding pid
   * (runtime/home-single-writer.ts). It is the boot-time answer to a second
   * copy of a singleton product being started onto a home that is already in
   * use: two writers over one session store is what leaves torn files and
   * ghost "active" sessions behind.
   *
   * It is OFF by default because it is not true of every surface. A terminal is
   * legitimately run twice over one project, refusing the second window would
   * break a shape people use every day. A product that IS a singleton (the
   * agent: one per machine, holding one home) passes `claim`.
   *
   * Several graphs in ONE process over one home are always fine: the claim is
   * per-pid and counted, so a daemon building a floor per hosted workspace
   * never refuses itself.
   */
  readonly homeSingleWriter?: 'claim' | 'off' | undefined;
}

/**
 * Compose the interactive-loop essentials for a surface product.
 *
 * Not a fork of `createRuntimeServices`: every piece both compositions build
 * the same way comes from the same free function (feature-flag-composition.ts,
 * provider-stack.ts, agent-graph.ts, permissions/permission-composition.ts,
 * secrets-composition.ts), so there is one implementation of each and no way
 * for the two graphs to drift on it.
 */
export function createClientRuntimeServices(options: ClientRuntimeServicesOptions): ClientRuntimeServices {
  const disposalScope = createDisposalScope('ClientRuntimeServices');
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'ClientRuntimeServicesOptions surfaceRoot');

  // Single-writer claim FIRST, before anything opens a file under the home: a
  // refusal has to happen before this process has started writing, not after.
  // Throws SurfaceHomeInUseError, whose message names the holding pid.
  if (options.homeSingleWriter === 'claim') {
    const claim = claimSurfaceHome({ homeDirectory, surfaceRoot });
    disposalScope.registry.add('surface home claim', () => claim.release());
  }

  const configManager = options.configManager;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const featureFlags = resolveRuntimeFeatureFlags({ configManager, featureFlags: options.featureFlags });
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);

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

  const providers = createProviderStack({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    featureFlags,
    runtimeBus: options.runtimeBus,
    shellPaths,
    surfaceRoot,
    ...(options.providerRegistryFactory === undefined ? {} : { providerRegistryFactory: options.providerRegistryFactory }),
    ...(options.modelDiscovery === undefined ? {} : { modelDiscovery: options.modelDiscovery }),
  });

  const agents = createAgentGraph({
    runtimeBus: options.runtimeBus,
    configManager,
    providerRegistry: providers.providerRegistry,
    workingDirectory,
  });

  const hookActivityTracker = new HookActivityTracker();
  const hookDispatcher = new HookDispatcher(
    {
      // Withheld only when the caller says so by name, see `hookAgentManager`.
      ...((options.hookAgentManager ?? 'attach') === 'attach' ? { agentManager: agents.agentManager } : {}),
      toolLLM: providers.toolLLM,
      projectRoot: workingDirectory,
    },
    hookActivityTracker,
  );
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({ hookDispatcher, configManager });

  const workflow = createWorkflowServices();
  hookDispatcher.setTriggerManager(workflow.triggerManager);

  const policyRuntimeState = createPolicyRuntimeState(configManager, featureFlags);
  const userPermissionRuleStore = createUserPermissionRuleStore(configManager);
  const permissionManager = createBrokeredPermissionManager({
    requestApproval: options.requestApproval,
    configManager,
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userRuleStore: userPermissionRuleStore,
  });
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  const approvalHandlers = createApprovalDerivedHandlers({
    requestApproval: options.requestApproval,
    providerRegistry: providers.providerRegistry,
    configManager,
    featureFlags,
    announcementStore,
  });

  const artifactStore = new ArtifactStore({ configManager });
  const webSearchProviders = new WebSearchProviderRegistry({ env: process.env, serviceRegistry });
  const webSearchService = new WebSearchService(webSearchProviders, { serviceRegistry, featureFlags });

  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const mcpRegistry = new McpRegistry({ hookDispatcher, sandboxSessions: sandboxSessionRegistry });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  mcpRegistry.setSandboxRuntime(configManager, sandboxSessionRegistry);
  // MCP elicitation/create requests ride the SAME ask seam as a permission ask.
  mcpRegistry.setElicitationHandler(createMcpElicitationApprovalHandler((input) => options.requestApproval(input)));

  const pluginManager = new PluginManager({
    pathOptions: { cwd: shellPaths.workingDirectory, homeDir: shellPaths.homeDirectory },
    stateFilePath: shellPaths.resolveUserPath(surfaceRoot, 'plugins.json'),
  });

  const sessionManager = new SessionManager(workingDirectory, { surfaceRoot });
  const isSessionLive = options.isSessionLive ?? ((): boolean => true);
  const sessionOrchestration = new CrossSessionTaskRegistry(
    shellPaths.resolveProjectPath(surfaceRoot, 'sessions', 'task-graph.json'),
    { sessionExists: (sessionId: string) => isSessionLive(sessionId) },
  );

  const processManager = new ProcessManager();
  const modeManager = new ModeManager({ featureFlags });
  const fileUndoManager = new FileUndoManager();
  const overflowHandler = new OverflowHandler({
    baseDir: workingDirectory,
    featureFlags,
    spillBackend: configManager.get('tools.overflowSpillBackend'),
  });
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  const contextAccountingHolder = new ContextAccountingHolder();
  const sessionLiveTurnControls = new SessionLiveTurnControlsHolder();

  agents.agentOrchestrator.setDependencies({
    sandboxEscalationHandler: approvalHandlers.sandboxEscalationHandler,
    execPromptAnswerHandler: approvalHandlers.execPromptAnswerHandler,
    localhostFetchApproval: approvalHandlers.localhostFetchApproval,
    onSandboxedRun: approvalHandlers.onSandboxedRun,
    permissionManager,
    contextAccountingHolder,
    fileCache,
    projectIndex,
    workingDirectory,
    surfaceRoot,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus: agents.agentMessageBus,
    webSearchService,
    archetypeLoader: agents.archetypeLoader,
    configManager,
    providerRegistry: providers.providerRegistry,
    providerOptimizer: providers.providerOptimizer,
    toolLLM: providers.toolLLM,
    serviceRegistry,
    secretsManager,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
  });

  // Poll-free runtime event for permission-mode changes so surfaces can render a live mode pill.
  bindPermissionModeChangeEvent(configManager, options.runtimeBus, 'runtime');
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses. The underlying file watchers are unref'd.
  const stopConfigWatch = configManager.watchConfigFiles();
  disposalScope.registry.add('config file watch', stopConfigWatch);
  // Key-level config changes on the runtime bus `config` domain.
  disposalScope.registry.add('config event bridge', attachConfigEmitBridge({
    config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) },
    bus: options.runtimeBus,
  }));
  disposalScope.registry.add('cross-session task registry', () => sessionOrchestration.dispose());
  disposalScope.registry.add('agent orchestrator', () => agents.agentOrchestrator.dispose());
  disposalScope.registry.add('hosted agent runs', () => { cancelAllAgentRuns(agents.agentManager); });

  const memoryAccess = options.memory
    ? new MemorySpineClient({
        local: options.memory.local,
        ...(options.memory.transport === undefined ? {} : { transport: options.memory.transport }),
      })
    : null;

  return {
    workingDirectory,
    homeDirectory,
    surfaceRoot,
    shellPaths,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    secretsManager,
    serviceRegistry,
    subscriptionManager,
    providerRegistry: providers.providerRegistry,
    providerCapabilityRegistry: providers.providerCapabilityRegistry,
    providerOptimizer: providers.providerOptimizer,
    cacheHitTracker: providers.cacheHitTracker,
    favoritesStore: providers.favoritesStore,
    benchmarkStore: providers.benchmarkStore,
    modelLimitsService: providers.modelLimitsService,
    toolLLM: providers.toolLLM,
    archetypeLoader: agents.archetypeLoader,
    agentManager: agents.agentManager,
    agentMessageBus: agents.agentMessageBus,
    agentOrchestrator: agents.agentOrchestrator,
    sessionManager,
    sessionOrchestration,
    workflow,
    sandboxSessionRegistry,
    processManager,
    modeManager,
    fileUndoManager,
    overflowHandler,
    contextAccountingHolder,
    sessionLiveTurnControls,
    mcpRegistry,
    artifactStore,
    webSearchProviders,
    webSearchService,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    policyRuntimeState,
    userPermissionRuleStore,
    permissionManager,
    requestApproval: options.requestApproval,
    sessionBroker: options.sessionDispatch ?? createHeldSessionDispatch(),
    sessionSpine: options.sessionSpine ?? null,
    memoryAccess,
    fileCache,
    projectIndex,
    dispose: (): void => disposalScope.dispose(),
  };
}

/**
 * Read the shared part of the client shape off any composition that carries it
 *, a daemon-grade `RuntimeServices` included. A convenience for call sites
 * that hold one graph and want to hand a turn-runner the narrow view.
 */
export function asClientRuntimeView<T extends ClientRuntimeServicesFromHost>(services: T): ClientRuntimeServicesFromHost {
  return services;
}
