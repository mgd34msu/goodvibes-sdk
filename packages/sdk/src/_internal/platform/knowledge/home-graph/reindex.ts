import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from '../types.js';
import { homeGraphExtractionNeedsRepair } from './search.js';
import type { HomeGraphReindexResult } from './types.js';

export async function reindexHomeGraphSources(input: {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
  readonly artifactStore: ArtifactStore;
  readonly extract: (source: KnowledgeSourceRecord, artifact: ArtifactDescriptor) => Promise<KnowledgeExtractionRecord | undefined>;
}): Promise<HomeGraphReindexResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const failures: Array<{ readonly sourceId: string; readonly error: string }> = [];
  let scanned = 0;
  let reparsed = 0;
  let skipped = 0;
  let failed = 0;
  for (const source of input.sources) {
    const artifactId = typeof source.artifactId === 'string' ? source.artifactId : undefined;
    if (!artifactId) continue;
    scanned += 1;
    const current = input.extractionBySourceId.get(source.id);
    if (!homeGraphExtractionNeedsRepair(current)) {
      skipped += 1;
      continue;
    }
    const artifact = input.artifactStore.get(artifactId);
    if (!artifact) {
      failed += 1;
      failures.push({ sourceId: source.id, error: `Unknown artifact: ${artifactId}` });
      continue;
    }
    const extraction = await input.extract(source, artifact);
    if (!extraction) {
      failed += 1;
      failures.push({ sourceId: source.id, error: 'Artifact extraction failed.' });
      continue;
    }
    reparsed += 1;
    sources.push(source);
  }
  return { ok: true, spaceId: input.spaceId, scanned, reparsed, skipped, failed, sources, failures };
}
