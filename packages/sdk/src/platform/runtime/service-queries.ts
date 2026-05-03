// Surface-agnostic service query interfaces for the platform layer.
// These are pure data contracts with no TUI dependencies.
export type {
  EnvironmentVariableQuery,
  ServiceInspectionQuery,
  SubscriptionAccessQuery,
  LocalAuthInspectionQuery,
  SessionBrowserQuery,
  SessionMemoryQuery,
  ToolCatalogQuery,
  ProviderModelCatalogQuery,
  ProviderAccountInspectionQuery,
  ProviderRuntimeInspectionQuery,
  PlanDashboardQuery,
  OpsStrategyQuery,
} from './ui-service-queries.js';

export {
  createEnvironmentVariableQuery,
  createProviderRuntimeInspectionQuery,
} from './ui-service-queries.js';
