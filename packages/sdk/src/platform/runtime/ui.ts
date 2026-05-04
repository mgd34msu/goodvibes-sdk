/**
 * Platform runtime UI surface barrel.
 *
 * Source file: `packages/sdk/src/platform/runtime/ui.ts`
 * Public path: `@pellux/goodvibes-sdk/platform/runtime/ui`
 *
 * NOTE: This is NOT a re-export of the `runtime/ui/` subdirectory.
 * The `ui/` subdirectory contains model-picker and provider-health data
 * providers — several of which ARE re-exported here. This file is the
 * curated public surface that the `./platform/runtime/ui` export map path
 * resolves to. The source was previously named `ui-surface.ts` and renamed
 * to `ui.ts` (MAJ-04 fix) so the source filename matches the export path.
 *
 * See `docs/public-surface.md` for the canonical surface table.
 */
export * from './ui/index.js';
export * from './host-ui.js';
export * from './ui-events.js';
export * from './ui-read-models-base.js';
export * from './ui-read-models-core.js';
export * from './ui-read-models-observability.js';
export * from './ui-read-models-observability-maintenance.js';
export * from './ui-read-models-observability-options.js';
export * from './ui-read-models-observability-remote.js';
export * from './ui-read-models-observability-security.js';
export * from './ui-read-models-observability-system.js';
export * from './ui-read-models-operations.js';
export * from './ui-service-queries.js';
export { createUiRuntimeServices } from './ui-services.js';
export type { UiRuntimeServices } from './ui-services.js';
export {
  dismissGuidance,
  evaluateContextualGuidance,
  formatGuidanceItems,
  resetGuidance,
} from './guidance.js';
export type {
  ContextualGuidanceSnapshot,
  GuidanceCategory,
  GuidanceItem,
  GuidancePersistenceOptions,
} from './guidance.js';
export { IntegrationHelperService } from './integration/helpers.js';
export type {
  ContinuitySnapshot,
  IntegrationHelpersContext,
  PanelSnapshot,
  SettingsSnapshot,
  WorktreeSnapshot,
} from './integration/helpers.js';
export {
  enrichModelEntries,
  groupEntriesByProvider,
} from './ui/model-picker/health-enrichment.js';
export { ModelPickerDataProvider, createModelPickerData } from './ui/model-picker/index.js';
export type { ModelPickerDataProviderOptions } from './ui/model-picker/index.js';
export { ProviderHealthDataProvider, buildFallbackChainData, createProviderHealthData } from './ui/provider-health/index.js';
export { NotificationRouter, createNotificationRouter } from './notifications/index.js';
export type {
  Notification,
  NotificationLevel,
  NotificationTag,
  NotificationTarget,
  DomainVerbosity,
  RoutingDecision,
} from './notifications/types.js';
export {
  applyModeContextPolicy,
  BurstPolicy,
} from './notifications/policies/index.js';
export * from './settings/control-plane.js';
export * from './settings/control-plane-store.js';
