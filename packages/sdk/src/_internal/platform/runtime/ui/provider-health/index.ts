/**
 * Provider health runtime read model surface.
 *
 * This path is the source-owned public runtime UI surface. Older internal
 * paths re-export from here for compatibility.
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

import type { ProviderHealthDomainState } from '../../store/domains/provider-health.js';
import type { ModelDomainState } from '../../store/domains/model.js';
import { ProviderHealthDataProvider } from './data-provider.js';
import type { ProviderHealthData } from './types.js';

export function createProviderHealthData(
  healthState: ProviderHealthDomainState,
  modelState: ModelDomainState,
): ProviderHealthData {
  const provider = new ProviderHealthDataProvider(healthState, modelState);
  const snapshot = provider.getSnapshot();
  provider.dispose();
  return snapshot;
}
