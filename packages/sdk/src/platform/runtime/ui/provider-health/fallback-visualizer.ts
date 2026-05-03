import type { ModelDomainState } from '../../store/domains/model.js';
import type { ProviderHealthDomainState } from '../../store/domains/provider-health.js';
import type { FallbackChainData, FallbackChainNode } from './types.js';

export function buildFallbackChainData(
  modelState: ModelDomainState,
  healthState: ProviderHealthDomainState,
): FallbackChainData {
  const nodes: FallbackChainNode[] = [];

  const primaryRecord = healthState.providers.get(modelState.activeProviderId);
  nodes.push({
    providerId: modelState.activeProviderId,
    modelId: modelState.activeModelId,
    displayName: modelState.displayName,
    position: 0,
    isCurrent: modelState.activeFallbackIndex === -1,
    providerStatus: primaryRecord?.status ?? 'unknown',
  });

  for (let index = 0; index < modelState.fallbackChain.length; index++) {
    const entry = modelState.fallbackChain[index];
    const record = healthState.providers.get(entry.providerId);
    nodes.push({
      providerId: entry.providerId,
      modelId: entry.modelId,
      displayName: entry.displayName,
      position: index + 1,
      isCurrent: modelState.activeFallbackIndex === index,
      providerStatus: record?.status ?? 'unknown',
      reason: entry.reason,
    });
  }

  const hasUnhealthyNode = nodes.some((node) =>
    node.providerStatus === 'degraded'
    || node.providerStatus === 'rate_limited'
    || node.providerStatus === 'unavailable'
    || node.providerStatus === 'auth_error',
  );

  return {
    nodes,
    activeIndex: modelState.activeFallbackIndex,
    falloverCount: modelState.falloverCount,
    hasUnhealthyNode,
  };
}
