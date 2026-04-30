import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { isGeneratedPageSource } from './helpers.js';
import type { HomeGraphPageListResult } from './types.js';

export async function listHomeGraphPages(input: {
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
}): Promise<HomeGraphPageListResult> {
  const pages: HomeGraphPageListResult['pages'][number][] = [];
  const sources = input.sources
    .filter(isGeneratedPageSource)
    .sort(compareGeneratedPages)
    .slice(0, input.limit);
  for (const source of sources) {
    const artifact = typeof source.artifactId === 'string' ? input.artifactStore.get(source.artifactId) : undefined;
    const markdown = input.includeMarkdown && artifact
      ? await readMarkdown(input.artifactStore, artifact.id)
      : undefined;
    pages.push({
      source,
      ...(artifact ? {
        artifact: {
          id: artifact.id,
          mimeType: artifact.mimeType,
          filename: artifact.filename,
          createdAt: artifact.createdAt,
          metadata: artifact.metadata,
        },
      } : {}),
      ...(markdown ? { markdown } : {}),
    });
  }
  return { ok: true, spaceId: input.spaceId, pages };
}

function compareGeneratedPages(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): number {
  const leftKind = typeof left.metadata.projectionKind === 'string' ? left.metadata.projectionKind : '';
  const rightKind = typeof right.metadata.projectionKind === 'string' ? right.metadata.projectionKind : '';
  return leftKind.localeCompare(rightKind)
    || (left.title ?? left.id).localeCompare(right.title ?? right.id)
    || left.id.localeCompare(right.id);
}

async function readMarkdown(artifactStore: ArtifactStore, artifactId: string): Promise<string | undefined> {
  try {
    const { buffer } = await artifactStore.readContent(artifactId);
    return buffer.toString('utf-8');
  } catch {
    return undefined;
  }
}
