import { join } from 'node:path';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { ReadTool } from '@pellux/goodvibes-sdk/platform/tools/read/index';
import { createWriteTool } from './write/index.js';
import { createEditTool } from './edit/index.js';
import { createFindTool } from '@pellux/goodvibes-sdk/platform/tools/find/index';
import { createExecTool } from '@pellux/goodvibes-sdk/platform/tools/exec/index';
import { createAnalyzeTool } from './analyze/index.js';
import { InspectTool } from '@pellux/goodvibes-sdk/platform/tools/inspect/index';
import { createAgentTool } from './agent/index.js';
import { createFetchTool } from './fetch/index.js';
import { createStateTool } from './state/index.js';
import { createWorkflowServices, createWorkflowTool } from '@pellux/goodvibes-sdk/platform/tools/workflow/index';
import { createRegistryTool } from '@pellux/goodvibes-sdk/platform/tools/registry-tool/index';
import { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';
import { createTaskTool } from '@pellux/goodvibes-sdk/platform/tools/task/index';
import { createTeamTool } from '@pellux/goodvibes-sdk/platform/tools/team/index';
import { createWorklistTool } from '@pellux/goodvibes-sdk/platform/tools/worklist/index';
import { createMcpTool } from './mcp/index.js';
import { createPacketTool } from '@pellux/goodvibes-sdk/platform/tools/packet/index';
import { createQueryTool } from '@pellux/goodvibes-sdk/platform/tools/query/index';
import { createRemoteTool } from './remote-trigger/index.js';
import { createReplTool } from './repl/index.js';
import { controlTool } from './control/index.js';
import { createChannelTool } from './channel/index.js';
import { createWebSearchTool } from './web-search/index.js';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools/shared/process-manager';
import type { AgentManager } from './agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import type { WrfcController } from '../agents/wrfc-controller.js';
import type { WebSearchService } from '../web-search/index.js';
import type { ChannelPluginRegistry } from '../channels/index.js';
import type { RemoteRunnerRegistry } from '../runtime/remote/index.js';
import { CrossSessionTaskRegistry } from '@pellux/goodvibes-sdk/platform/sessions/orchestration/index';
import type { SandboxSessionRegistry } from '../runtime/sandbox/session-registry.js';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import type { ServiceRegistry } from '../config/service-registry.js';
import { OverflowHandler } from '@pellux/goodvibes-sdk/platform/tools/shared/overflow';
import type { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions/change-tracker';
import type { ArchetypeLoader } from '@pellux/goodvibes-sdk/platform/agents/archetypes';

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
    serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth'> | null;
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

  registry.register(new ReadTool(projectIndex, fileCache));
  registry.register(createWriteTool({
    projectRoot: workingDirectory,
    fileCache,
    projectIndex,
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registry.register(createEditTool(fileCache, {
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registry.register(createFindTool(workingDirectory, deps.featureFlags));
  registry.register(createExecTool(processManager, {
    featureFlags: deps.featureFlags,
    overflowHandler: deps.overflowHandler,
  }));
  registry.register(createAnalyzeTool(deps.toolLLM, deps.featureFlags, workingDirectory));
  registry.register(new InspectTool(deps.featureFlags, workingDirectory));
  registry.register(createAgentTool({
    manager: agentManager,
    messageBus: agentMessageBus,
    configManager: deps.configManager,
    ...(archetypeLoader ? { archetypeLoader } : {}),
    ...(wrfcController ? { wrfcController } : {}),
  }));
  const kvState = new KVState(undefined, workingDirectory);
  const hookDispatcher = new HookDispatcher();
  registry.register(createStateTool(kvState, projectIndex, {
    memoryDir: join(workingDirectory, '.goodvibes', 'memory'),
    hookDispatcher,
    modeManager,
  }));
  registry.register(createWorkflowTool(workflowServices));
  registry.register(createFetchTool({
    serviceRegistry: deps.serviceRegistry,
    featureFlags: deps.featureFlags,
  }));
  if (webSearchService) {
    registry.register(createWebSearchTool(webSearchService));
  }
  registry.register(createRegistryTool(registry, {
    workingDirectory,
    homeDirectory: deps.configManager.getHomeDirectory() ?? undefined,
  }));
  registry.register(createTaskTool(sessionOrchestration));
  registry.register(createTeamTool({ surfaceRoot: deps.surfaceRoot }));
  registry.register(createWorklistTool({ surfaceRoot: deps.surfaceRoot }));
  if (mcpRegistry) {
    registry.register(createMcpTool(mcpRegistry));
  }
  registry.register(createPacketTool({ workingDirectory, surfaceRoot: deps.surfaceRoot }));
  registry.register(createQueryTool({ workingDirectory, surfaceRoot: deps.surfaceRoot }));
  if (remoteRunnerRegistry) {
    registry.register(createRemoteTool(remoteRunnerRegistry));
  }
  registry.register(createReplTool(deps.configManager, deps.sandboxSessionRegistry, {
    surfaceRoot: deps.surfaceRoot,
  }));
  registry.register(controlTool);
  registry.register(createChannelTool(channelRegistry));
  return { fileCache, projectIndex };
}
