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
    knowledgeSpaceId: spaceId,
  });
}
