import type { ArtifactStore } from '../../artifacts/index.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import type { HomeGraphResetInput, HomeGraphResetResult } from './types.js';

export async function resetHomeGraphSpace(
  store: KnowledgeStore,
  artifactStore: ArtifactStore,
  input: HomeGraphResetInput,
): Promise<HomeGraphResetResult> {
  await store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(store, input);
  const dryRun = input.dryRun === true;
  const preserveArtifacts = input.preserveArtifacts === true;
  const artifactIds = collectKnowledgeSpaceArtifactIds(store, artifactStore, spaceId);
  const deleted = await store.deleteKnowledgeSpace(spaceId, { dryRun });
  const deletedArtifacts = dryRun || preserveArtifacts ? 0 : artifactStore.deleteMany(artifactIds);
  const preservedArtifacts = dryRun || preserveArtifacts
    ? artifactIds.length
    : Math.max(0, artifactIds.length - deletedArtifacts);
  return {
    ok: true,
    spaceId,
    installationId,
    dryRun,
    deleted,
    artifactDeleteCandidates: artifactIds.length,
    deletedArtifacts,
    preservedArtifacts,
    artifactsDeleted: deletedArtifacts > 0,
  };
}

function collectKnowledgeSpaceArtifactIds(store: KnowledgeStore, artifactStore: ArtifactStore, spaceId: string): string[] {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const ids = new Set<string>();
  for (const source of store.listSources(100_000)) {
    if (getKnowledgeSpaceId(source) !== normalized) continue;
    if (typeof source.artifactId === 'string' && source.artifactId.trim().length > 0) {
      ids.add(source.artifactId.trim());
    }
  }
  for (const artifact of artifactStore.list(100_000)) {
    if (getKnowledgeSpaceId({ metadata: artifact.metadata }) === normalized) ids.add(artifact.id);
  }
  return [...ids];
}
