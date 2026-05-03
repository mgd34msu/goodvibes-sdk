import type { KnowledgeStore } from '../store.js';
import { renderHomeGraphMap } from './rendering.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { renderHomeGraphState } from './state.js';
import type { HomeGraphMapInput, HomeGraphMapResult } from './types.js';

export async function mapHomeGraph(input: HomeGraphMapInput & {
  readonly store: KnowledgeStore;
}): Promise<HomeGraphMapResult> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  return renderHomeGraphMap(renderHomeGraphState(input.store, spaceId, 'Home Graph Map'), {
    ...input,
    ha: {
      objectKinds: preferNonEmpty(input.ha?.objectKinds, input.objectKinds),
      entityIds: preferNonEmpty(input.ha?.entityIds, input.entityIds),
      deviceIds: preferNonEmpty(input.ha?.deviceIds, input.deviceIds),
      areaIds: preferNonEmpty(input.ha?.areaIds, input.areaIds),
      integrationIds: preferNonEmpty(input.ha?.integrationIds, input.integrationIds),
      integrationDomains: preferNonEmpty(input.ha?.integrationDomains, input.integrationDomains),
      domains: preferNonEmpty(input.ha?.domains, input.domains),
      deviceClasses: preferNonEmpty(input.ha?.deviceClasses, input.deviceClasses),
      labels: preferNonEmpty(input.ha?.labels, input.labels),
    },
    knowledgeSpaceId: spaceId,
  });
}

function preferNonEmpty<T>(primary: readonly T[] | undefined, fallback: readonly T[] | undefined): readonly T[] | undefined {
  return primary && primary.length > 0 ? primary : fallback;
}
