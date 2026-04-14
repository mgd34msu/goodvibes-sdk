/**
 * Provider health UI data surface barrel.
 *
 * Re-exports all types and the ProviderHealthDataProvider class.
 * Also provides the createProviderHealthData() factory for one-shot snapshots.
 */
export type {
  ProviderStatus,
  CompositeHealthStatus,
  HealthTimelinePoint,
  HealthTimeline,
  ProviderHealthEntry,
  FallbackChainNode,
  FallbackChainData,
  ProviderHealthData,
} from './types.js';

export { ProviderHealthDataProvider } from './data-provider.js';
export { buildFallbackChainData } from './fallback-visualizer.js';

import type { ProviderHealthDomainState } from '../store/domains/provider-health.js';
import type { ModelDomainState } from '../store/domains/model.js';
import { ProviderHealthDataProvider } from './data-provider.js';
import type { ProviderHealthData } from './types.js';

/**
 * Produce a one-shot ProviderHealthData snapshot without creating a long-lived provider.
 *
 * Use this when you need a single render pass and do not require change subscriptions.
 * For reactive/subscription-based UIs, prefer ProviderHealthDataProvider.
 *
 * @param healthState - Current provider health domain state.
 * @param modelState - Current model domain state.
 * @returns Immutable ProviderHealthData snapshot.
 */
export function createProviderHealthData(
  healthState: ProviderHealthDomainState,
  modelState: ModelDomainState,
): ProviderHealthData {
  // Delegate to the data provider for consistent derivation logic,
  // then dispose immediately since no subscriptions are needed.
  const dp = new ProviderHealthDataProvider(healthState, modelState);
  const snapshot = dp.getSnapshot();
  dp.dispose();
  return snapshot;
}
