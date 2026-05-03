import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import { extractKnowledgeArtifact } from '../extractors.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from '../types.js';
import { autoLinkHomeGraphSources, type HomeGraphAutoLinkResult } from './auto-link.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { readHomeGraphState } from './state.js';

export async function extractHomeGraphArtifact(
  context: {
    readonly store: KnowledgeStore;
    readonly artifactStore: ArtifactStore;
    readonly reportBackgroundError: (event: string, error: unknown, metadata: Record<string, unknown>) => void;
  },
  source: KnowledgeSourceRecord,
  artifact: ArtifactDescriptor,
  spaceId: string,
  installationId: string,
): Promise<KnowledgeExtractionRecord | undefined> {
  try {
    const record = context.artifactStore.getRecord(artifact.id);
    if (!record) return undefined;
    const { buffer } = await context.artifactStore.readContent(artifact.id);
    const extracted = await extractKnowledgeArtifact(record, buffer);
    const existing = context.store.getExtractionBySourceId(source.id);
    return context.store.upsertExtraction({
      id: existing?.id ?? `hg-extract-${source.id.replace(/^hg-src-/, '')}`,
      sourceId: source.id,
      artifactId: artifact.id,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: buildHomeGraphMetadata(spaceId, installationId, extracted.metadata),
    });
  } catch (error) {
    context.reportBackgroundError('homegraph-extract-artifact', error, {
      spaceId,
      sourceId: source.id,
      artifactId: artifact.id,
    });
    return undefined;
  }
}

export function autoLinkExistingHomeGraphSources(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  sourceIds?: readonly string[],
): Promise<readonly HomeGraphAutoLinkResult[]> {
  const state = readHomeGraphState(store, spaceId);
  const extractionBySourceId = new Map(state.extractions.map((extraction) => [extraction.sourceId, extraction]));
  const wanted = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
  const sources = wanted ? state.sources.filter((source) => wanted.has(source.id)) : state.sources;
  return autoLinkHomeGraphSources({
    store,
    spaceId,
    installationId,
    sources,
    extractionBySourceId,
    state,
  });
}
