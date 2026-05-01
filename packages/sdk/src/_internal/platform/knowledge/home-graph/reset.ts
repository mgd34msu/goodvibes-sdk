import type { KnowledgeStore } from '../store.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import type { HomeGraphResetInput, HomeGraphResetResult } from './types.js';

export async function resetHomeGraphSpace(
  store: KnowledgeStore,
  input: HomeGraphResetInput,
): Promise<HomeGraphResetResult> {
  await store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(store, input);
  const dryRun = input.dryRun === true;
  const deleted = await store.deleteKnowledgeSpace(spaceId, { dryRun });
  return { ok: true, spaceId, installationId, dryRun, deleted, artifactsDeleted: false };
}
