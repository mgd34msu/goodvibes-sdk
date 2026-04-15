import { listHookPointContracts } from '../hooks/index.js';
import type { HookApi } from '../hooks/hook-api.js';
import type { KnowledgeApi } from '../knowledge/knowledge-api.js';
import type { McpApi } from '../mcp/mcp-api.js';
import type { ProviderApi } from '../providers/provider-api.js';
import type { RuntimeServices } from './services.js';
import {
  createDirectTransportServices,
  type DirectTransportServices,
  type OperatorClientServicesOptions,
} from './foundation-services.js';
import type { OpsApi } from './ops-api.js';
import type { OpsControlPlane } from './ops/control-plane.js';
import { createRuntimeHookApi } from './runtime-hook-api.js';
import { createRuntimeKnowledgeApi } from './runtime-knowledge-api.js';
import { createRuntimeMcpApi } from './runtime-mcp-api.js';
import { createRuntimeOpsApi } from './runtime-ops-api.js';
import { createRuntimeProviderApi } from './runtime-provider-api.js';
import type { TaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';
import { createDirectTransportFromServices, type DirectTransport } from './transports/direct.js';
import type { UiTasksSnapshot } from './ui-read-models.js';

export interface RuntimeFoundationClientsOptions extends OperatorClientServicesOptions {
  readonly runtimeServices: RuntimeServices;
  readonly tasksReadModel: {
    getSnapshot(): UiTasksSnapshot;
  };
  readonly taskManager: TaskManager;
  readonly opsControlPlane?: OpsControlPlane;
}

export interface RuntimeFoundationClients {
  readonly transportServices: DirectTransportServices;
  readonly directTransport: DirectTransport;
  readonly providerApi: ProviderApi;
  readonly knowledgeApi: KnowledgeApi;
  readonly hookApi: HookApi;
  readonly mcpApi: McpApi;
  readonly opsApi: OpsApi;
}

export function createRuntimeFoundationClients(
  options: RuntimeFoundationClientsOptions,
): RuntimeFoundationClients {
  const {
    runtimeServices,
    tasksReadModel,
    taskManager,
    opsControlPlane,
    getControlPlaneRecentEvents,
  } = options;

  const transportServices = createDirectTransportServices(runtimeServices, {
    ...(getControlPlaneRecentEvents ? { getControlPlaneRecentEvents } : {}),
  });
  const directTransport = createDirectTransportFromServices(transportServices);

  return {
    transportServices,
    directTransport,
    providerApi: createRuntimeProviderApi(runtimeServices),
    knowledgeApi: createRuntimeKnowledgeApi(runtimeServices),
    hookApi: createRuntimeHookApi({
      dispatcher: {
        listHooks: () => runtimeServices.hookDispatcher.listHooks(),
        listChains: () => runtimeServices.hookWorkbench.listManagedChains(),
      },
      workbench: runtimeServices.hookWorkbench,
      listContracts: () => listHookPointContracts(),
    }),
    mcpApi: createRuntimeMcpApi(runtimeServices.mcpRegistry),
    opsApi: createRuntimeOpsApi({
      tasksReadModel,
      taskManager,
      opsControlPlane,
    }),
  };
}
