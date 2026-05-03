export type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.js';
export type {
  UiRemoteSnapshot,
  UiRemoteReadModels,
} from './ui-read-models-observability-remote.js';
export type {
  UiIntelligenceSnapshot,
  UiMarketplaceSnapshot,
  UiCockpitSnapshot,
  UiHealthSnapshot,
  UiSystemObservabilityReadModels,
} from './ui-read-models-observability-system.js';
export type {
  UiSecuritySnapshot,
  UiMcpServerSnapshot,
  UiMcpSnapshot,
  UiLocalAuthSnapshot,
  UiSecurityObservabilityReadModels,
} from './ui-read-models-observability-security.js';
export type {
  UiSettingsSnapshot,
  UiContinuitySnapshot,
  UiWorktreeSnapshot,
  UiMaintenanceObservabilityReadModels,
} from './ui-read-models-observability-maintenance.js';

import type { RuntimeServices } from './services.js';
import { createRemoteReadModels, type UiRemoteReadModels } from './ui-read-models-observability-remote.js';
import {
  createSystemObservabilityReadModels,
  type UiSystemObservabilityReadModels,
} from './ui-read-models-observability-system.js';
import {
  createSecurityObservabilityReadModels,
  type UiSecurityObservabilityReadModels,
} from './ui-read-models-observability-security.js';
import {
  createMaintenanceObservabilityReadModels,
  type UiMaintenanceObservabilityReadModels,
} from './ui-read-models-observability-maintenance.js';
import type { UiObservabilityReadModelOptions } from './ui-read-models-observability-options.js';

export interface UiObservabilityReadModels
  extends UiRemoteReadModels,
    UiSystemObservabilityReadModels,
    UiSecurityObservabilityReadModels,
    UiMaintenanceObservabilityReadModels {}

export function createObservabilityReadModels(
  runtimeServices: RuntimeServices,
  options: UiObservabilityReadModelOptions = {},
): UiObservabilityReadModels {
  return {
    ...createRemoteReadModels(runtimeServices),
    ...createSystemObservabilityReadModels(runtimeServices, options),
    ...createSecurityObservabilityReadModels(runtimeServices, options),
    ...createMaintenanceObservabilityReadModels(runtimeServices),
  };
}
