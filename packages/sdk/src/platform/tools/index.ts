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
import { createFindTool } from './find/index.js';
import { createExecTool } from './exec/index.js';
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
export type { AgentRecord } from './agent/index.js';

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
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(
  registry: ToolRegistry,
  deps?: {
    fileCache?: FileStateCache;
    projectIndex?: ProjectIndex;
    fileUndoManager: FileUndoManager;
    modeManager: ModeManager;
    processManager: ProcessManager;
    agentManager?: AgentManager;
    agentMessageBus: AgentMessageBus;
    wrfcController?: WrfcController;
    webSearchService?: WebSearchService;
    channelRegistry?: ChannelPluginRegistry | null;
    remoteRunnerRegistry?: RemoteRunnerRegistry;
    workflowServices: ReturnType<typeof createWorkflowServices>;
    mcpRegistry?: import('../mcp/registry.js').McpRegistry;
    sessionOrchestration?: CrossSessionTaskRegistry;
    sandboxSessionRegistry?: SandboxSessionRegistry;
    workingDirectory: string;
    surfaceRoot: string;
    archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'>;
    configManager?: ConfigManager;
    providerRegistry?: ProviderRegistry;
    toolLLM?: ToolLLM;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
    serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth' | 'getAll' | 'inspect'> | null;
    secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null;
    overflowHandler?: OverflowHandler;
    changeTracker?: SessionChangeTracker;
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
  registerTool(createWriteTool({
    projectRoot: workingDirectory,
    fileCache,
    projectIndex,
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registerTool(createEditTool(fileCache, {
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registerTool(createFindTool(workingDirectory, deps.featureFlags));
  registerTool(createExecTool(processManager, {
    featureFlags: deps.featureFlags,
    overflowHandler: deps.overflowHandler,
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
  const kvState = new KVState(undefined, workingDirectory);
  const hookDispatcher = new HookDispatcher();
  registerTool(createStateTool(kvState, projectIndex, {
    memoryDir: join(workingDirectory, '.goodvibes', 'memory'),
    hookDispatcher,
    modeManager,
  }));
  registerTool(createWorkflowTool(workflowServices));
  registerTool(createFetchTool({
    serviceRegistry: deps.serviceRegistry,
    featureFlags: deps.featureFlags,
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
