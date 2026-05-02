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
      objectKinds: input.ha?.objectKinds ?? input.objectKinds,
      entityIds: input.ha?.entityIds ?? input.entityIds,
      deviceIds: input.ha?.deviceIds ?? input.deviceIds,
      areaIds: input.ha?.areaIds ?? input.areaIds,
      integrationIds: input.ha?.integrationIds ?? input.integrationIds,
      integrationDomains: input.ha?.integrationDomains ?? input.integrationDomains,
      domains: input.ha?.domains ?? input.domains,
      deviceClasses: input.ha?.deviceClasses ?? input.deviceClasses,
      labels: input.ha?.labels ?? input.labels,
    },
    knowledgeSpaceId: spaceId,
  });
}
