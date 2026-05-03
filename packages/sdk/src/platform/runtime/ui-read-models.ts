export type { UiReadModel } from './ui-read-models-base.js';
export type {
  UiCoreReadModels,
  UiProvidersSnapshot,
  UiSessionSnapshot,
  UiAgentsSnapshot,
  UiTasksSnapshot,
} from './ui-read-models-core.js';
export type {
  UiOperationsReadModels,
  UiAutomationSnapshot,
  UiRoutesSnapshot,
  UiWatchersSnapshot,
  UiOrchestrationSnapshot,
  UiCommunicationSnapshot,
  UiControlPlaneSnapshot,
} from './ui-read-models-operations.js';
export type {
  UiObservabilityReadModels,
  UiRemoteSnapshot,
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiSecuritySnapshot,
  UiHealthSnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
} from './ui-read-models-observability.js';
export type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.js';

import type { RuntimeServices } from './services.js';
import { createCoreReadModels, type UiCoreReadModels } from './ui-read-models-core.js';
import {
  createOperationsReadModels,
  type UiOperationsReadModels,
  type UiOperationsReadModelOptions,
} from './ui-read-models-operations.js';
import {
  createObservabilityReadModels,
  type UiObservabilityReadModels,
  type UiObservabilityReadModelOptions,
} from './ui-read-models-observability.js';

export type UiReadModelOptions = UiOperationsReadModelOptions & UiObservabilityReadModelOptions;

export type UiReadModels = UiCoreReadModels & UiOperationsReadModels & UiObservabilityReadModels;

export function createUiReadModels(
  runtimeServices: RuntimeServices,
  options: UiReadModelOptions = {},
): UiReadModels {
  return {
    ...createCoreReadModels(runtimeServices),
    ...createOperationsReadModels(runtimeServices, options),
    ...createObservabilityReadModels(runtimeServices, options),
  };
}
