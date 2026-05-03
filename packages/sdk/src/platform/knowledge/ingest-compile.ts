import {
  emitKnowledgeCompileCompleted,
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
} from '../runtime/emitters/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { extractKnowledgeArtifact } from './extractors.js';
import { knowledgeExtractionNeedsRefresh } from './extraction-policy.js';
import {
  canonicalizeUri,
  extractTaggedValues,
  mergeTags,
  readMetadataStrings,
  slugify,
  topKeywords,
} from './shared.js';
import type { KnowledgeIngestContext } from './ingest-context.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.js';

const MAX_EXTRACTION_SECTION_NODES = 12;
const MAX_EXTRACTION_LINK_EDGES = 24;
const MAX_ENTITY_HINT_VALUES_PER_KIND = 8;

export async function finalizeKnowledgeIngestedSource(
  context: KnowledgeIngestContext,
  input: {
    readonly sourceId: string;
    readonly artifactId: string;
    readonly inputTitle?: string;
    readonly sourceType: KnowledgeSourceType;
    readonly connectorId: string;
    readonly tags: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly metadata: Record<string, unknown>;
  },
): Promise<{ source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord }> {
  const content = await context.artifactStore.readContent(input.artifactId);
  const record = content.record;
  const canonicalUri = canonicalizeUri(record.sourceUri ?? '');
  try {
    const extracted = await extractKnowledgeArtifact(record, content.buffer);
    const extraction = await context.store.upsertExtraction({
      sourceId: input.sourceId,
      artifactId: input.artifactId,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: extracted.metadata,
    });
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionCompleted(bus, ctx, {
      sourceId: input.sourceId,
      extractionId: extraction.id,
      format: extraction.format,
      estimatedTokens: extraction.estimatedTokens,
    }), input.sessionId);

    const source = await context.store.upsertSource({
      id: input.sourceId,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      title: input.inputTitle?.trim() || extraction.title || record.filename,
      sourceUri: record.sourceUri,
      canonicalUri: canonicalUri ?? undefined,
      summary: extraction.summary,
      description: extraction.excerpt,
      tags: input.tags,
      folderPath: input.folderPath,
      status: 'indexed',
      artifactId: input.artifactId,
      contentHash: record.sha256,
      lastCrawledAt: Date.now(),
      sessionId: input.sessionId,
      metadata: {
        ...input.metadata,
        contentType: record.mimeType,
        extractionId: extraction.id,
        extractionFormat: extraction.format,
        outboundLinks: extraction.links,
      },
    });

    await compileKnowledgeSource(context, source, extraction);
    void Promise.resolve(context.semanticEnrichSource?.(source.id, readKnowledgeSpaceId(source.metadata))).catch((error: unknown) => {
      logger.warn('Knowledge semantic enrichment after ingest failed', {
        sourceId: source.id,
        error: summarizeError(error),
      });
    });
    await context.syncReviewedMemory();
    return { source, artifactId: input.artifactId, extraction };
  } catch (error) {
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionFailed(bus, ctx, {
      sourceId: input.sourceId,
      error: summarizeError(error),
    }), input.sessionId);
    throw error;
  }
}

function readKnowledgeSpaceId(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.knowledgeSpaceId ?? metadata.spaceId ?? metadata.namespace;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function recompileKnowledgeSource(context: KnowledgeIngestContext, source: KnowledgeSourceRecord): Promise<void> {
  const extraction = source.id ? context.store.getExtractionBySourceId(source.id) : null;
  if (source.artifactId && knowledgeExtractionNeedsRefresh(extraction)) {
    const content = await context.artifactStore.readContent(source.artifactId);
    const extracted = await extractKnowledgeArtifact(content.record, content.buffer);
    await context.store.upsertExtraction({
      sourceId: source.id,
      artifactId: source.artifactId,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: extracted.metadata,
    });
  }
  await compileKnowledgeSource(context, context.store.getSource(source.id) ?? source, context.store.getExtractionBySourceId(source.id));
}

export async function compileKnowledgeSource(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const initialNodeCount = context.store.status().nodeCount;
  const initialEdgeCount = context.store.status().edgeCount;
  await context.store.batch(async () => {
    await compileKnowledgeSourceRecords(context, source, extraction);
  });

  const finalStatus = context.store.status();
  context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
    sourceId: source.id,
    nodeCount: Math.max(0, finalStatus.nodeCount - initialNodeCount),
    edgeCount: Math.max(0, finalStatus.edgeCount - initialEdgeCount),
  }), source.sessionId);
}

async function compileKnowledgeSourceRecords(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  if (source.artifactId) {
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'artifact',
      toId: source.artifactId,
      relation: 'snapshotted_as',
    });
  }

  const domain = source.canonicalUri ?? source.sourceUri;
  if (domain) {
    try {
      const hostname = new URL(domain).hostname.toLowerCase();
      const domainNode = await context.store.upsertNode({
        kind: 'domain',
        slug: slugify(hostname),
        title: hostname,
        summary: `Knowledge sources cataloged under ${hostname}.`,
        aliases: [hostname],
        metadata: { hostname },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: domainNode.id,
        relation: 'belongs_to_domain',
      });
    } catch (error) {
      logger.debug('Knowledge ingest: source URL could not be canonicalized for domain node', {
        sourceId: source.id,
        uri: domain,
        error: summarizeError(error),
      });
      // invalid URLs are linted separately
    }
  }

  if (source.folderPath) {
    const segments = source.folderPath.split('/').map((entry) => entry.trim()).filter(Boolean);
    let previousNode: KnowledgeNodeRecord | null = null;
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const folderNode = await context.store.upsertNode({
        kind: 'bookmark_folder',
        slug: slugify(accumulated),
        title: segment,
        summary: `Bookmark folder ${accumulated}.`,
        aliases: [accumulated],
        metadata: { folderPath: accumulated },
      });
      if (previousNode) {
        await context.store.upsertEdge({
          fromKind: 'node',
          fromId: previousNode.id,
          toKind: 'node',
          toId: folderNode.id,
          relation: 'contains_folder',
        });
      }
      previousNode = folderNode;
    }
    if (previousNode) {
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: previousNode.id,
        relation: 'cataloged_in_folder',
      });
    }
  }

  for (const tag of source.tags) {
    const topicNode = await context.store.upsertNode({
      kind: 'topic',
      slug: slugify(tag),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: { tag },
    });
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'tagged_with',
    });
  }

  await compileKnowledgeStructuredEntityHints(context, source, extraction);

  if (extraction) {
    const tagSlugs = new Set(source.tags.map((tag) => slugify(tag)));
    const sectionTitles: string[] = [];
    const seenSectionSlugs = new Set<string>();
    for (const section of extraction.sections.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
      const sectionSlug = slugify(section);
      if (!sectionSlug || seenSectionSlugs.has(sectionSlug)) continue;
      seenSectionSlugs.add(sectionSlug);
      sectionTitles.push(section);
      if (sectionTitles.length >= MAX_EXTRACTION_SECTION_NODES) break;
    }
    for (const section of sectionTitles) {
      if (tagSlugs.has(slugify(section))) continue;
      const topicNode = await context.store.upsertNode({
        kind: 'topic',
        slug: slugify(section),
        title: section,
        summary: `Compiled section or concept from source ${source.id}.`,
        aliases: [section],
        metadata: {
          sourceId: source.id,
          extractionId: extraction.id,
        },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'mentions_section',
      });
    }
    const outboundUris = [...new Set(extraction.links
      .map((link) => canonicalizeUri(link))
      .filter((link): link is string => link !== null))]
      .slice(0, MAX_EXTRACTION_LINK_EDGES);
    for (const canonicalOutbound of outboundUris) {
      const linked = context.store.getSourceByCanonicalUri(canonicalOutbound);
      if (!linked) continue;
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'source',
        toId: linked.id,
        relation: 'links_to_source',
      });
    }
  }

  if (source.sessionId) {
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'session',
      toId: source.sessionId,
      relation: 'ingested_during',
    });
  }
}

export async function compileKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const metadata = source.metadata ?? {};
  const topicKeywords = topKeywords([
    source.title ?? '',
    source.summary ?? '',
    extraction?.summary ?? '',
    extraction?.sections.join(' ') ?? '',
  ].join(' '), 4);
  const entitySpecs: Array<{
    kind: KnowledgeNodeRecord['kind'];
    values: readonly string[];
    relation: string;
    summaryPrefix: string;
  }> = [
    {
      kind: 'project',
      values: mergeTags(
        extractTaggedValues(source.tags, ['project', 'proj']),
        readMetadataStrings(metadata, ['project', 'projects']),
      ),
      relation: 'belongs_to_project',
      summaryPrefix: 'Project',
    },
    {
      kind: 'capability',
      values: mergeTags(
        extractTaggedValues(source.tags, ['capability', 'feature']),
        readMetadataStrings(metadata, ['capability', 'capabilities', 'feature', 'features']),
      ),
      relation: 'documents_capability',
      summaryPrefix: 'Capability',
    },
    {
      kind: 'repo',
      values: mergeTags(
        extractTaggedValues(source.tags, ['repo', 'repository']),
        readMetadataStrings(metadata, ['repo', 'repository', 'repositories']),
        source.sourceType === 'repo' ? [source.title ?? source.sourceUri ?? source.id] : [],
      ),
      relation: 'references_repo',
      summaryPrefix: 'Repository',
    },
    {
      kind: 'provider',
      values: mergeTags(
        extractTaggedValues(source.tags, ['provider']),
        readMetadataStrings(metadata, ['provider', 'providers']),
      ),
      relation: 'references_provider',
      summaryPrefix: 'Provider',
    },
    {
      kind: 'service',
      values: mergeTags(
        extractTaggedValues(source.tags, ['service']),
        readMetadataStrings(metadata, ['service', 'services']),
      ),
      relation: 'references_service',
      summaryPrefix: 'Service',
    },
    {
      kind: 'environment',
      values: mergeTags(
        extractTaggedValues(source.tags, ['env', 'environment']),
        readMetadataStrings(metadata, ['env', 'environment', 'environments']),
      ),
      relation: 'references_environment',
      summaryPrefix: 'Environment',
    },
    {
      kind: 'user',
      values: mergeTags(
        extractTaggedValues(source.tags, ['user', 'owner']),
        readMetadataStrings(metadata, ['user', 'users', 'owner', 'owners']),
      ),
      relation: 'references_user',
      summaryPrefix: 'User',
    },
  ];

  for (const spec of entitySpecs) {
    for (const value of spec.values.slice(0, MAX_ENTITY_HINT_VALUES_PER_KIND)) {
      const title = value.trim();
      if (!title) continue;
      const node = await context.store.upsertNode({
        kind: spec.kind,
        slug: slugify(title),
        title,
        summary: `${spec.summaryPrefix} entity compiled from structured knowledge sources.`,
        aliases: topicKeywords,
        metadata: {
          compiledFrom: source.id,
          tags: [...source.tags],
        },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: node.id,
        relation: spec.relation,
      });
    }
  }
}
