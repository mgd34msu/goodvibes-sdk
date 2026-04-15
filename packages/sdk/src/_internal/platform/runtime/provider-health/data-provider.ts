/**
 * ProviderHealthDataProvider — enriched provider health data surface.
 *
 * Combines ProviderHealthDomainState and ModelDomainState into a single,
 * sorted ProviderHealthData snapshot for UI consumption.
 *
 * This class is a data provider only — it contains no rendering logic.
 * Subscribe to change notifications and call getSnapshot() to render.
 */
export * from '../ui/provider-health/data-provider.js';
