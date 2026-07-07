import type { ArtifactStore } from '../../artifacts/index.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
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
  // Scope-checked deletion (HAZARD H1): the ArtifactStore is shared across the
  // wiki / home-graph / agent families. A blob that a *different* family owns —
  // identifiable by its own explicit knowledge-space stamp — must never be deleted
  // by a home-graph reset, even if a home-graph source references it, because that
  // would orphan the other family's reference. We err toward preserving: an
  // artifact is a delete candidate only when it is not explicitly owned by another
  // space.
  const ownedByOtherSpace = (artifactId: string): boolean => {
    const descriptor = artifactStore.get(artifactId);
    if (!descriptor) return false;
    const artifactSpace = getExplicitKnowledgeSpaceId({ metadata: descriptor.metadata });
    return artifactSpace !== undefined && artifactSpace !== normalized;
  };
  for (const source of store.listSources(100_000)) {
    if (getKnowledgeSpaceId(source) !== normalized) continue;
    const artifactId = typeof source.artifactId === 'string' ? source.artifactId.trim() : '';
    if (artifactId.length === 0) continue;
    if (ownedByOtherSpace(artifactId)) continue;
    ids.add(artifactId);
  }
  for (const artifact of artifactStore.list(100_000)) {
    if (getKnowledgeSpaceId({ metadata: artifact.metadata }) === normalized) ids.add(artifact.id);
  }
  return [...ids];
}
