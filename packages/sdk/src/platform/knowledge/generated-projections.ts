import { createHash } from 'node:crypto';
import type { ArtifactDescriptor } from '../artifacts/types.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeReferenceKind,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.js';
import { logger } from '../utils/logger.js';

export interface GeneratedKnowledgeProjectionInput {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly sourceType?: KnowledgeSourceType | undefined;
  readonly canonicalUri: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly filename: string;
  readonly markdown: string;
  readonly projectionKind: string;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly sourceMetadata?: Record<string, unknown> | undefined;
  readonly artifactMetadata?: Record<string, unknown> | undefined;
  readonly edgeMetadata?: Record<string, unknown> | undefined;
  readonly target?: {
    readonly kind: KnowledgeReferenceKind;
    readonly id: string;
    readonly relation?: string | undefined;
  };
}

export interface GeneratedKnowledgeProjectionResult {
  readonly artifact: ArtifactDescriptor;
  readonly source: KnowledgeSourceRecord;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifactCreated: boolean;
}

export function generatedKnowledgeSourceId(kind: string, value: string): string {
  return `kg-gen-${stableHash(`${kind}:${value}`)}`;
}

export function generatedKnowledgeCanonicalUri(kind: string, value: string): string {
  return `knowledge://generated/${encodeURIComponent(kind)}/${stableHash(value, 20)}`;
}

export function isGeneratedKnowledgeSource(source: KnowledgeSourceRecord): boolean {
  return source.metadata.generatedKnowledgePage === true
    || source.metadata.generatedProjection === true
    || source.metadata.homeGraphGeneratedPage === true
    || source.metadata.homeGraphSourceKind === 'generated-page';
}

export async function materializeGeneratedKnowledgeProjection(
  input: GeneratedKnowledgeProjectionInput,
): Promise<GeneratedKnowledgeProjectionResult> {
  const existing = input.store.getSource(input.sourceId);
  const contentHash = stableHash(input.markdown, 40);
  const existingMetadata = readRecord(existing?.metadata);
  const existingGeneratedAt = typeof existingMetadata.generatedAt === 'number' ? existingMetadata.generatedAt : undefined;
  const contentUnchanged = existingMetadata.generatedContentHash === contentHash;
  const generatedAt = contentUnchanged && existingGeneratedAt !== undefined ? existingGeneratedAt : Date.now();
  const projectionMetadata = {
    ...(input.metadata ?? {}),
    generatedKnowledgePage: true,
    generatedProjection: true,
    projectionKind: input.projectionKind,
    generatedAt,
    generatedContentHash: contentHash,
    pageEditable: true,
  };
  const reusedArtifact = await findReusableGeneratedArtifact(input.artifactStore, existing, input.markdown);
  const artifact = reusedArtifact ?? await input.artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: input.filename,
    text: input.markdown,
    retentionMs: 0,
    metadata: {
      ...projectionMetadata,
      ...(input.artifactMetadata ?? {}),
      generatedAt,
      generatedContentHash: contentHash,
    },
  });
  const source = await input.store.upsertSource({
    id: input.sourceId,
    connectorId: input.connectorId,
    sourceType: input.sourceType ?? 'document',
    title: input.title,
    sourceUri: input.canonicalUri,
    canonicalUri: input.canonicalUri,
    ...(input.summary ? { summary: input.summary } : {}),
    tags: uniqueStrings(input.tags ?? []),
    status: 'indexed',
    artifactId: artifact.id,
    lastCrawledAt: contentUnchanged && typeof existing?.lastCrawledAt === 'number'
      ? existing.lastCrawledAt
      : generatedAt,
    metadata: {
      ...projectionMetadata,
      artifactId: artifact.id,
      filename: artifact.filename,
      ...(input.sourceMetadata ?? {}),
      generatedAt,
      generatedContentHash: contentHash,
    },
  });
  const linked = input.target
    ? await input.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: input.target.kind,
        toId: input.target.id,
        relation: input.target.relation ?? 'source_for',
        metadata: {
          generatedKnowledgePage: true,
          generatedProjection: true,
          projectionKind: input.projectionKind,
          ...(input.edgeMetadata ?? {}),
        },
      })
    : undefined;
  return {
    artifact,
    source,
    ...(linked ? { linked } : {}),
    artifactCreated: !reusedArtifact,
  };
}

async function findReusableGeneratedArtifact(
  artifactStore: ArtifactStore,
  source: KnowledgeSourceRecord | null,
  markdown: string,
): Promise<ArtifactDescriptor | undefined> {
  if (!source?.artifactId) return undefined;
  const artifact = artifactStore.get(source.artifactId);
  if (!artifact) return undefined;
  try {
    const { buffer } = await artifactStore.readContent(artifact.id);
    return buffer.toString('utf-8') === markdown ? artifact : undefined;
  } catch (error) {
    logger.debug('Generated knowledge projection artifact reuse failed', {
      sourceId: source.id,
      artifactId: artifact.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function stableHash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
