import { join } from 'node:path';
import { ToolRegistry } from './registry.js';
import type { Tool } from '../types/tools.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import { ModeManager } from '../state/mode-manager.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { FileUndoManager } from '../state/file-undo.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { ReadTool } from './read/index.js';
import { createWriteTool } from './write/index.js';
import { createEditTool } from './edit/index.js';
import { TypeScriptSyntaxDiagnosticsProvider } from './shared/post-edit-diagnostics.js';
import { createRepoMapTool } from './repo-map/index.js';
import { ContextAccountingHolder, createContextAccountingTool } from './context-accounting/index.js';
import { createFindTool } from './find/index.js';
import { createExecTool } from './exec/index.js';
import type { CredentialEnvScrubConfig } from './exec/credential-env.js';
import {
  detectSandboxAvailability,
  probeSandboxHost,
  type ExecSandboxRuntime,
} from './exec/sandbox.js';
import { createAnalyzeTool } from './analyze/index.js';
import { InspectTool } from './inspect/index.js';
import { createAgentTool } from './agent/index.js';
import { createFetchTool } from './fetch/index.js';
import { createStateTool } from './state/index.js';
import { createWorkflowServices, createWorkflowTool } from './workflow/index.js';
import { createRegistryTool } from './registry-tool/index.js';
import { KVState } from '../state/kv-state.js';
import { createTaskTool } from './task/index.js';
import { createTeamTool } from './team/index.js';
import { createWorklistTool } from './worklist/index.js';
import { createMcpTool } from './mcp/index.js';
import { createPacketTool } from './packet/index.js';
import { createQueryTool } from './query/index.js';
import { createRemoteTool } from './remote-trigger/index.js';
import { createReplTool } from './repl/index.js';
import { controlTool } from './control/index.js';
import { createChannelTool } from './channel/index.js';
import { createWebSearchTool } from './web-search/index.js';
import { ProcessManager } from './shared/process-manager.js';
import type { AgentManager } from './agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import type { WrfcController } from '../agents/wrfc-controller.js';
import type { WebSearchService } from '../web-search/index.js';
import type { ChannelPluginRegistry } from '../channels/index.js';
import type { RemoteRunnerRegistry } from '../runtime/remote/index.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import type { SandboxSessionRegistry } from '../runtime/sandbox/session-registry.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SecretsManager } from '../config/secrets.js';
import { OverflowHandler } from './shared/overflow.js';
import type { SessionChangeTracker } from '../sessions/change-tracker.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import {
  createGoodVibesContextTool,
  createGoodVibesSettingsTool,
} from './goodvibes-runtime/index.js';

export { ToolRegistry } from './registry.js';
export { ProcessManager } from './shared/process-manager.js';
export type { BackgroundProcess, BgCommandResult, SpawnOptions } from './shared/process-manager.js';
export { AGENT_TEMPLATES, AgentManager } from './agent/index.js';
export type { AgentExecutor, AgentRecord } from './agent/index.js';
export {
  AutoHealer,
} from './shared/auto-heal.js';
export {
  appendSchemaFingerprint,
  computeSchemaFingerprint,
  computeSchemaFingerprintSync,
  getSchemaShapeId,
  SCHEMA_SHAPE_IDS,
} from './shared/schema-fingerprint.js';
export type { SchemaFingerprintMeta } from './shared/schema-fingerprint.js';
export { OverflowHandler, createSpillBackend } from './shared/overflow.js';
export {
  DiagnosticsBackend,
  FileBackend,
  LedgerBackend,
  overflowCleanup,
} from './shared/overflow.js';
export type {
  OverflowHandlerConfig,
  OverflowOptions,
  OverflowResult,
  RetentionPolicyConfig,
  SpillBackend,
  SpillBackendType,
  SpillEntry,
} from './shared/overflow.js';
export {
  WORKFLOW_DEFINITIONS,
  TriggerManager,
  WorkflowManager,
  ScheduleManager,
  createWorkflowServices,
  createWorkflowTool,
  parseInterval,
} from './workflow/index.js';
export type { TriggerDefinition, WorkflowServices } from './workflow/index.js';
export { loadSkillByTrigger } from './registry-tool/skill-loader.js';
export type { SkillLoaderRoots } from './registry-tool/skill-loader.js';
export { ReadTool } from './read/index.js';
export { createWriteTool } from './write/index.js';
export { createEditTool } from './edit/index.js';
export { createRepoMapTool } from './repo-map/index.js';
export {
  ContextAccountingHolder,
  createContextAccountingTool,
} from './context-accounting/index.js';
export type {
  ContextAccountingSource,
  ContextTokenState,
} from './context-accounting/index.js';
export type { EditToolOptions } from './edit/index.js';
export type { EditItem, EditInput } from './edit/types.js';
export { createFindTool } from './find/index.js';
export { createExecTool } from './exec/index.js';
// The per-command exec sandbox is wired internally by registerAllTools from the
// sandbox.* config + the exec-sandbox flag; only its types are re-exported here
// (type re-exports are erased at runtime, so they carry no bundle cost) so a
// consumer calling createExecTool directly can still name the option shape. The
// runner functions stay importable from the exec/sandbox module.
export type {
  ExecSandboxConfig,
  ExecSandboxRuntime,
  ExecSandboxPlan,
  SandboxAvailability,
  SandboxHostProbe,
  SandboxNetworkState,
  BwrapArgvInput,
  ResolveSandboxPlanInput,
} from './exec/sandbox.js';
export { formatDenialResponse, guardExecCommand } from './exec/ast-guard.js';
export { createAnalyzeTool } from './analyze/index.js';
export { InspectTool } from './inspect/index.js';
export { createAgentTool } from './agent/index.js';
export { createChannelTool } from './channel/index.js';
export { registerChannelAgentTools } from './channel/agent-tools.js';
export { controlTool } from './control/index.js';
export { createFetchTool } from './fetch/index.js';
export { applySanitizer, resolveSanitizeMode } from './fetch/sanitizer.js';
export type { SanitizeMode } from './fetch/sanitizer.js';
export {
  TRUST_TIER_EVENTS,
  classifyHostTrustTier,
  extractHostname,
} from './fetch/trust-tiers.js';
export type { TrustTierConfig } from './fetch/trust-tiers.js';
export { repairToolCall } from './auto-repair.js';
export { createMcpTool } from './mcp/index.js';
export { createPacketTool } from './packet/index.js';
export { createQueryTool } from './query/index.js';
export { createRegistryTool } from './registry-tool/index.js';
export { createRemoteTool } from './remote-trigger/index.js';
export { createReplTool } from './repl/index.js';
export { createStateTool } from './state/index.js';
export { createTaskTool } from './task/index.js';
export { createTeamTool } from './team/index.js';
export { createWebSearchTool } from './web-search/index.js';
export { createWorklistTool } from './worklist/index.js';

type ToolContractFeatureFlags = Pick<FeatureFlagManager, 'isEnabled'>;

export function registerToolWithContractGate(
  registry: ToolRegistry,
  tool: Tool,
  featureFlags?: ToolContractFeatureFlags | null,
): void {
  const verifyContracts = featureFlags?.isEnabled('tool-contract-verification') ?? true;
  if (!verifyContracts) {
    registry.register(tool);
    return;
  }

  registry.registerWithContract(tool, {
    strictIdempotency: false,
    strictPermissionClass: false,
  });
}

/**
 * Split a comma-separated host config value (fetch.trustedHosts / blockedHosts)
 * into a trimmed, non-empty host list. Returns undefined when empty so the fetch
 * runtime keeps its "no default list" semantics.
 */
function splitHostConfig(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const hosts = value
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(
  registry: ToolRegistry,
  deps?: {
    fileCache?: FileStateCache | undefined;
    projectIndex?: ProjectIndex | undefined;
    fileUndoManager: FileUndoManager;
    modeManager: ModeManager;
    processManager: ProcessManager;
    agentManager?: AgentManager | undefined;
    agentMessageBus: AgentMessageBus;
    wrfcController?: WrfcController | undefined;
    webSearchService?: WebSearchService | undefined;
    channelRegistry?: ChannelPluginRegistry | null | undefined;
    remoteRunnerRegistry?: RemoteRunnerRegistry | undefined;
    workflowServices: ReturnType<typeof createWorkflowServices>;
    mcpRegistry?: import('../mcp/registry.js').McpRegistry | undefined;
    sessionOrchestration?: CrossSessionTaskRegistry | undefined;
    sandboxSessionRegistry?: SandboxSessionRegistry | undefined;
    workingDirectory: string;
    surfaceRoot: string;
    archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
    configManager?: ConfigManager | undefined;
    providerRegistry?: ProviderRegistry | undefined;
    toolLLM?: ToolLLM | undefined;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
    serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth' | 'getAll' | 'inspect'> | null | undefined;
    secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null | undefined;
    overflowHandler?: OverflowHandler | undefined;
    changeTracker?: SessionChangeTracker | undefined;
    /** Project memory registry — when present, `state mode=memory set` mirrors writes into retrievable records. */
    memoryRegistry?: import('../state/index.js').MemoryRegistry | undefined;
    /**
     * Post-edit diagnostics provider for write/edit tool results. Defaults to
     * the in-process tree-sitter syntax provider; pass null to disable, or a
     * custom provider to override.
     */
    diagnosticsProvider?: import('./shared/post-edit-diagnostics.js').DiagnosticsProvider | null | undefined;
    /**
     * Credential-bearing env-var scrub applied to every spawned exec command's
     * environment. Threaded straight into createExecTool so a consumer can wire
     * its `permissions.exec.*` config (master switch + allowlist) at the
     * composition root instead of the scrub always resolving to its built-in
     * default. Omitted → scrub enabled with the default allowlist (see
     * resolveCredentialEnvScrub).
     */
    credentialEnvScrub?: CredentialEnvScrubConfig | undefined;
    /**
     * Per-file read-permission decision shared with search / list / map tools
     * (find, repo_map). Wired at the composition root to
     * PermissionManager.previewReadAccess so a file the read tool would gate
     * never leaks its content through a search. Omitted → all files allowed.
     */
    readAccessFilter?: import('./shared/read-access.js').ReadAccessFilter | undefined;
    /**
     * Settable holder for the context_accounting tool's session source. The tool
     * is always registered (consumers inherit it like repo_map); the interactive
     * session binds its Orchestrator-backed source onto this holder after
     * construction. Omitted → the tool registers with a fresh empty holder and
     * honestly reports "no live session context bound".
     */
    contextAccountingHolder?: ContextAccountingHolder | undefined;
    /**
     * Broker a per-command exec-sandbox host-access escalation (network,
     * host-privilege escalation) through the approval broker before the command
     * runs. Wired at the composition root to the sandbox-escalation seam.
     * Omitted → escalations are not asked (today's behavior).
     */
    sandboxEscalationHandler?: ((input: {
      readonly command: string;
      readonly escalations: readonly string[];
      readonly boundary: string;
      readonly policyReasons: readonly string[];
      readonly workingDirectory?: string | undefined;
    }) => Promise<boolean>) | undefined;
  },
): { fileCache: FileStateCache; projectIndex: ProjectIndex } {
  const fileCache = deps?.fileCache ?? new FileStateCache();
  if (!deps?.fileUndoManager || !deps?.modeManager || !deps?.processManager || !deps?.agentMessageBus || !deps?.workflowServices) {
    throw new Error('registerAllTools requires explicit fileUndoManager, modeManager, processManager, agentMessageBus, and workflowServices ownership.');
  }
  const fileUndoManager = deps.fileUndoManager;
  const modeManager = deps.modeManager;
  const processManager = deps.processManager;
  const agentManager = deps?.agentManager
    ?? (deps?.remoteRunnerRegistry
      ? (deps.remoteRunnerRegistry as unknown as { agentManager?: AgentManager | null }).agentManager ?? null
      : null);
  if (!agentManager) {
    throw new Error('registerAllTools requires agentManager');
  }
  const agentMessageBus = deps.agentMessageBus;
  const wrfcController = deps?.wrfcController;
  const archetypeLoader = deps?.archetypeLoader;
  const webSearchService = deps?.webSearchService;
  const channelRegistry = deps?.channelRegistry ?? null;
  const remoteRunnerRegistry = deps?.remoteRunnerRegistry;
  const workflowServices = deps.workflowServices;
  const mcpRegistry = deps?.mcpRegistry;
  if (!deps?.configManager || !deps?.providerRegistry || !deps?.toolLLM) {
    throw new Error('registerAllTools requires configManager, providerRegistry, and toolLLM');
  }
  if (!deps?.sandboxSessionRegistry) {
    throw new Error('registerAllTools requires sandboxSessionRegistry');
  }
  if (!deps?.sessionOrchestration) {
    throw new Error('registerAllTools requires sessionOrchestration');
  }
  const sessionOrchestration = deps.sessionOrchestration;
  const workingDirectory = deps?.workingDirectory;
  if (!workingDirectory) {
    throw new Error('registerAllTools requires workingDirectory');
  }
  if (!deps?.surfaceRoot || deps.surfaceRoot.trim().length === 0) {
    throw new Error('registerAllTools requires surfaceRoot');
  }
  const projectIndex = deps?.projectIndex ?? new ProjectIndex(workingDirectory);
  const registerTool = (tool: Tool): void => {
    registerToolWithContractGate(registry, tool, deps.featureFlags);
  };

  registerTool(createGoodVibesContextTool({
    configManager: deps.configManager,
    providerRegistry: deps.providerRegistry,
    toolRegistry: registry,
    channelRegistry,
    serviceRegistry: deps.serviceRegistry as Pick<ServiceRegistry, 'getAll' | 'inspect'> | null | undefined,
    secretsManager: deps.secretsManager ?? null,
    workingDirectory,
    homeDirectory: deps.configManager.getHomeDirectory() ?? undefined,
    surfaceRoot: deps.surfaceRoot,
  }));
  registerTool(createGoodVibesSettingsTool({
    configManager: deps.configManager,
  }));
  registerTool(new ReadTool(projectIndex, fileCache));
  // One post-edit diagnostics provider shared by write and edit. Default: the
  // in-process tree-sitter syntax provider (no process spawn). `null` disables.
  const diagnosticsProvider = deps.diagnosticsProvider === null
    ? undefined
    : deps.diagnosticsProvider ?? new TypeScriptSyntaxDiagnosticsProvider();
  registerTool(createWriteTool({
    projectRoot: workingDirectory,
    fileCache,
    projectIndex,
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
    diagnosticsProvider,
  }));
  registerTool(createEditTool(fileCache, {
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
    diagnosticsProvider,
  }));
  registerTool(createFindTool(workingDirectory, deps.featureFlags, undefined, deps.readAccessFilter));
  registerTool(createRepoMapTool({ projectRoot: workingDirectory, ...(deps.readAccessFilter ? { readAccessFilter: deps.readAccessFilter } : {}) }));
  registerTool(createContextAccountingTool(deps.contextAccountingHolder ?? new ContextAccountingHolder()));
  // Per-command exec sandbox: only probe the host (a bwrap spawn) when the
  // graduation-gated flag AND the sandbox.enabled config switch are both on, so
  // the default path stays zero-cost and byte-for-byte unchanged.
  const sandboxCategory = deps.configManager.getCategory('sandbox');
  const execSandbox: ExecSandboxRuntime | null =
    (deps.featureFlags?.isEnabled('exec-sandbox') ?? false) && sandboxCategory.enabled
      ? {
          config: {
            enabled: sandboxCategory.enabled,
            egressAllowlist: sandboxCategory.egressAllowlist ?? [],
            workspaceWritable: sandboxCategory.workspaceWritable ?? [],
          },
          availability: detectSandboxAvailability(probeSandboxHost()),
          featureEnabled: true,
          homeDir: deps.configManager.getHomeDirectory() ?? undefined,
          ...(deps.sandboxEscalationHandler ? { requestEscalation: deps.sandboxEscalationHandler } : {}),
        }
      : null;
  registerTool(createExecTool(processManager, {
    featureFlags: deps.featureFlags,
    overflowHandler: deps.overflowHandler,
    defaultWorkingDirectory: workingDirectory,
    ...(deps.credentialEnvScrub ? { credentialEnvScrub: deps.credentialEnvScrub } : {}),
    ...(execSandbox ? { sandbox: execSandbox } : {}),
  }));
  registerTool(createAnalyzeTool(deps.toolLLM, deps.featureFlags, workingDirectory));
  registerTool(new InspectTool(deps.featureFlags, workingDirectory));
  registerTool(createAgentTool({
    manager: agentManager,
    messageBus: agentMessageBus,
    configManager: deps.configManager,
    ...(archetypeLoader ? { archetypeLoader } : {}),
    ...(wrfcController ? { wrfcController } : {}),
  }));
  const kvState = new KVState({ stateDir: join(workingDirectory, '.goodvibes', 'state') });
  const hookDispatcher = new HookDispatcher();
  registerTool(createStateTool(kvState, projectIndex, {
    memoryDir: join(workingDirectory, '.goodvibes', 'memory'),
    hookDispatcher,
    modeManager,
    ...(deps.memoryRegistry ? { memoryRegistry: deps.memoryRegistry } : {}),
  }));
  registerTool(createWorkflowTool(workflowServices));
  registerTool(createFetchTool({
    serviceRegistry: deps.serviceRegistry,
    featureFlags: deps.featureFlags,
    defaultSanitizeMode: deps.configManager.get('fetch.sanitizeMode'),
    defaultTrustedHosts: splitHostConfig(deps.configManager.get('fetch.trustedHosts')),
    defaultBlockedHosts: splitHostConfig(deps.configManager.get('fetch.blockedHosts')),
  }));
  if (webSearchService) {
    registerTool(createWebSearchTool(webSearchService));
  }
  registerTool(createRegistryTool(registry, {
    workingDirectory,
    homeDirectory: deps.configManager.getHomeDirectory() ?? undefined,
  }));
  registerTool(createTaskTool(sessionOrchestration));
  registerTool(createTeamTool({ surfaceRoot: deps.surfaceRoot }));
  registerTool(createWorklistTool({ surfaceRoot: deps.surfaceRoot }));
  if (mcpRegistry) {
    registerTool(createMcpTool(mcpRegistry));
  }
  registerTool(createPacketTool({ workingDirectory, surfaceRoot: deps.surfaceRoot }));
  registerTool(createQueryTool({ workingDirectory, surfaceRoot: deps.surfaceRoot }));
  if (remoteRunnerRegistry) {
    registerTool(createRemoteTool(remoteRunnerRegistry));
  }
  registerTool(createReplTool(deps.configManager, deps.sandboxSessionRegistry, {
    surfaceRoot: deps.surfaceRoot,
  }));
  registerTool(controlTool);
  registerTool(createChannelTool(channelRegistry));
  return { fileCache, projectIndex };
}
