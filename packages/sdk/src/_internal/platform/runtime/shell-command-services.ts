import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ForensicsRegistry } from './forensics/index.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { HookWorkbench } from '../hooks/workbench.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { WorktreeRegistry } from './worktree/registry.js';
import type { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { createShellExtensionServices, type CommandExtensionShellServices } from './shell-command-extensions.js';
import { createShellOpsServices, createShellPlanRuntime, createShellRemoteCommandService, type CommandOpsShellServices, type PlanRuntimeService, type RemoteCommandService } from './shell-command-ops.js';
import { createShellPlatformServices, type CommandPlatformShellServices } from './shell-command-platform.js';
import { createShellWorkspaceServices, type CommandWorkspaceShellServices } from './shell-command-workspace.js';

export type { CommandWorkspaceShellServices } from './shell-command-workspace.js';
export type { CommandPlatformShellServices } from './shell-command-platform.js';
export type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from './shell-command-ops.js';
export type { CommandOpsShellServices, PlanRuntimeService, RemoteCommandService } from './shell-command-ops.js';
export type { CommandExtensionShellServices } from './shell-command-extensions.js';

export interface BootstrapCommandShellServices {
  readonly workspace: CommandWorkspaceShellServices;
  readonly platform: CommandPlatformShellServices;
  readonly ops: CommandOpsShellServices;
  readonly extensions: CommandExtensionShellServices;
}

export interface CreateBootstrapCommandShellServicesOptions {
  readonly agentManager?: import('./shell-command-ops.js').ShellAgentManagerService;
  readonly acpManager?: import('./shell-command-ops.js').ShellAcpManagerService;
  readonly automationManager?: import('./shell-command-ops.js').ShellAutomationManagerRuntimeService;
  readonly modeManager?: import('./shell-command-ops.js').ShellModeManagerService;
  readonly planManager?: import('./shell-command-ops.js').ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: import('./shell-command-ops.js').ShellSessionOrchestrationService;
  readonly shellPaths: ShellPathService;
  readonly componentHealthMonitor: ComponentHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly readModels: import('./ui-read-models.js').UiReadModels;
  readonly serviceRegistry?: import('../config/service-registry.js').ServiceRegistry;
  readonly subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.js').SecretsManager;
  readonly localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security/user-auth').UserAuthManager;
  readonly tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security/token-audit').ApiTokenAuditor;
  readonly replayEngine?: import('@pellux/goodvibes-sdk/platform/core/deterministic-replay').DeterministicReplayEngine;
  readonly webhookNotifier?: import('../integrations/webhooks.js').WebhookNotifier;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: import('../state/memory-store.js').MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export function createBootstrapCommandShellServices(
  options: CreateBootstrapCommandShellServicesOptions,
): BootstrapCommandShellServices {
  const {
    agentManager,
    acpManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    shellPaths,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    remoteRuntime,
    planRuntime,
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  } = options;

  return {
    workspace: createShellWorkspaceServices({
      shellPaths,
      componentHealthMonitor,
      worktreeRegistry,
      sandboxSessionRegistry,
    }),
    platform: createShellPlatformServices({
      readModels,
      serviceRegistry,
      subscriptionManager,
      secretsManager,
      localUserAuthManager,
      tokenAuditor,
      replayEngine,
      webhookNotifier,
    }),
    ops: createShellOpsServices({
      agentManager,
      acpManager,
      automationManager,
      modeManager,
      planManager,
      adaptivePlanner,
      sessionOrchestration,
      remoteRuntime,
      planRuntime,
    }),
    extensions: createShellExtensionServices({
      forensicsRegistry,
      policyRuntimeState,
      memoryRegistry,
      integrationHelpers,
      knowledgeService,
      pluginManager,
      hookWorkbench,
    }),
  };
}

export { createShellRemoteCommandService, createShellPlanRuntime } from './shell-command-ops.js';
