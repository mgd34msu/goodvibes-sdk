import type { ForensicsRegistry } from './forensics/index.js';
import type { PolicyRegistry } from './permissions/policy-registry.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { MemoryRegistry } from '../state/memory-store.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { HookWorkbench } from '../hooks/workbench.js';

export interface CommandExtensionShellServices {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly policyRegistry?: PolicyRegistry;
  readonly policyRuntimeState?: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export interface CreateShellExtensionServicesOptions {
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export function createShellExtensionServices(
  options: CreateShellExtensionServicesOptions,
): CommandExtensionShellServices {
  const {
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  } = options;

  return {
    forensicsRegistry,
    policyRegistry: policyRuntimeState.getRegistry(),
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  };
}
