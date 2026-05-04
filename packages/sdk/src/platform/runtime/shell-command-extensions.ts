import type { ForensicsRegistry } from './forensics/index.js';
import type { PolicyRegistry } from './permissions/policy-registry.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { MemoryRegistry } from '../state/memory-store.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { HookWorkbench } from '../hooks/workbench.js';

export interface CommandExtensionShellServices {
  readonly forensicsRegistry?: ForensicsRegistry | undefined;
  readonly policyRegistry?: PolicyRegistry | undefined;
  readonly policyRuntimeState?: PolicyRuntimeState | undefined;
  readonly memoryRegistry?: MemoryRegistry | undefined;
  readonly integrationHelpers?: IntegrationHelperService | undefined;
  readonly knowledgeService?: KnowledgeService | undefined;
  readonly pluginManager?: PluginManager | undefined;
  readonly hookWorkbench?: HookWorkbench | undefined;
}

export interface CreateShellExtensionServicesOptions {
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry | undefined;
  readonly integrationHelpers?: IntegrationHelperService | undefined;
  readonly knowledgeService?: KnowledgeService | undefined;
  readonly pluginManager?: PluginManager | undefined;
  readonly hookWorkbench?: HookWorkbench | undefined;
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
