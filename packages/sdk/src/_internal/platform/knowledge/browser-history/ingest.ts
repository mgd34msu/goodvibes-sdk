import { createHash } from 'node:crypto';
import {
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
} from '../../runtime/emitters/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { compileKnowledgeSource } from '../ingest-compile.js';
import type { KnowledgeIngestContext } from '../ingest-context.js';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeExtractionRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import { canonicalizeUri, estimateTokens, isHttpUri, mergeTags, slugify } from '../internal.js';
import { discoverBrowserKnowledgeProfiles } from './discover.js';
import { readBrowserKnowledgeProfile } from './readers.js';
import type {
  BrowserKnowledgeCollectResult,
  BrowserKnowledgeEntry,
  BrowserKnowledgeFilter,
  BrowserKnowledgeProfile,
  BrowserKnowledgeSourceKind,
} from './types.js';

export interface BrowserKnowledgeIngestOptions extends BrowserKnowledgeFilter {
  readonly sessionId?: string;
  readonly connectorId?: string;
}

interface BrowserKnowledgeAggregate {
  readonly canonicalUri: string;
  readonly entries: BrowserKnowledgeEntry[];
  readonly sourceKinds: readonly BrowserKnowledgeSourceKind[];
  readonly browsers: readonly string[];
  readonly profileKeys: readonly string[];
  readonly folders: readonly string[];
  readonly firstRecordedAt?: number;
  readonly lastRecordedAt?: number;
  readonly visitCount: number;
}

function timestampForEntry(entry: BrowserKnowledgeEntry): number | undefined {
  return entry.sourceKind === 'history' ? entry.visitedAtMs : entry.addedAtMs;
}

function hashAggregate(aggregate: BrowserKnowledgeAggregate): string {
  return createHash('sha256')
    .update(JSON.stringify(aggregate.entries.map((entry) => ({
      sourceKind: entry.sourceKind,
      url: entry.url,
      browser: entry.browser,
      profilePath: entry.profilePath,
      rawId: entry.rawId,
      recordedAt: timestampForEntry(entry),
    }))))
    .digest('hex');
}

function sourceTypeForAggregate(aggregate: BrowserKnowledgeAggregate): KnowledgeSourceType {
  return aggregate.sourceKinds.includes('bookmark') ? 'bookmark' : 'history';
}

function titleForAggregate(aggregate: BrowserKnowledgeAggregate): string {
  return aggregate.entries.find((entry) => entry.title)?.title
    ?? aggregate.entries[0]?.url
    ?? aggregate.canonicalUri;
}

function folderForAggregate(aggregate: BrowserKnowledgeAggregate): string {
  return aggregate.folders[0] ?? `/browser/${aggregate.browsers[0] ?? 'local'}`;
}

function tagsForAggregate(aggregate: BrowserKnowledgeAggregate): string[] {
  return mergeTags([
    'browser',
    ...aggregate.browsers,
    ...aggregate.sourceKinds.map((kind) => kind === 'history' ? 'browser-history' : 'browser-bookmark'),
  ]);
}

function metadataForAggregate(aggregate: BrowserKnowledgeAggregate): Record<string, unknown> {
  return {
    browserKnowledge: true,
    browserSourceKinds: [...aggregate.sourceKinds],
    browserKinds: [...aggregate.browsers],
    browserProfiles: [...aggregate.profileKeys],
    browserFolders: [...aggregate.folders],
    browserObservationCount: aggregate.entries.length,
    browserVisitCount: aggregate.visitCount,
    ...(typeof aggregate.firstRecordedAt === 'number' ? { browserFirstRecordedAt: aggregate.firstRecordedAt } : {}),
    ...(typeof aggregate.lastRecordedAt === 'number' ? { browserLastRecordedAt: aggregate.lastRecordedAt } : {}),
    browserObservations: aggregate.entries.slice(0, 32).map((entry) => ({
      sourceKind: entry.sourceKind,
      browser: entry.browser,
      browserFamily: entry.family,
      profileName: entry.profileName,
      profilePath: entry.profilePath,
      title: entry.title,
      rawId: entry.rawId,
      recordedAt: timestampForEntry(entry),
      ...(entry.sourceKind === 'history' ? {
        visitCount: entry.visitCount,
        transition: entry.transition,
      } : {
        folderPath: entry.folderPath,
      }),
    })),
  };
}

function describeAggregate(aggregate: BrowserKnowledgeAggregate): string {
  const parts = [
    aggregate.sourceKinds.includes('bookmark') && aggregate.sourceKinds.includes('history')
      ? 'Browser-local page observed in bookmarks and history.'
      : aggregate.sourceKinds.includes('bookmark')
        ? 'Browser-local page observed in bookmarks.'
        : 'Browser-local page observed in browsing history.',
    `Browsers: ${aggregate.browsers.join(', ')}.`,
    `Profiles: ${aggregate.profileKeys.join(', ')}.`,
    aggregate.visitCount > 0 ? `Visit count: ${aggregate.visitCount}.` : '',
    typeof aggregate.lastRecordedAt === 'number' ? `Last recorded: ${new Date(aggregate.lastRecordedAt).toISOString()}.` : '',
    aggregate.folders.length ? `Folders: ${aggregate.folders.slice(0, 4).join(', ')}.` : '',
    `URL: ${aggregate.canonicalUri}`,
  ].filter(Boolean);
  return parts.join(' ');
}

function extractionForAggregate(
  aggregate: BrowserKnowledgeAggregate,
  source: KnowledgeSourceRecord,
): Omit<KnowledgeExtractionRecord, 'id' | 'sourceId' | 'createdAt' | 'updatedAt'> {
  const summary = describeAggregate(aggregate);
  return {
    extractorId: 'browser-history',
    format: 'text',
    title: titleForAggregate(aggregate),
    summary,
    excerpt: summary,
    sections: mergeTags([
      ...aggregate.sourceKinds.map((kind) => `browser ${kind}`),
      ...aggregate.browsers,
      ...aggregate.folders,
    ]).slice(0, 24),
    links: [aggregate.canonicalUri],
    estimatedTokens: estimateTokens(summary, aggregate.canonicalUri, titleForAggregate(aggregate)),
    structure: {
      sourceKinds: [...aggregate.sourceKinds],
      browsers: [...aggregate.browsers],
      profiles: [...aggregate.profileKeys],
      canonicalUri: source.canonicalUri,
    },
    metadata: metadataForAggregate(aggregate),
  };
}

function aggregateBrowserEntries(entries: readonly BrowserKnowledgeEntry[]): BrowserKnowledgeAggregate[] {
  const buckets = new Map<string, BrowserKnowledgeEntry[]>();
  for (const entry of entries) {
    if (!isHttpUri(entry.url)) continue;
    const canonicalUri = canonicalizeUri(entry.url) ?? entry.url;
    const bucket = buckets.get(canonicalUri) ?? [];
    bucket.push(entry);
    buckets.set(canonicalUri, bucket);
  }

  return [...buckets.entries()].map(([canonicalUri, bucket]) => {
    const sorted = [...bucket].sort((a, b) => (timestampForEntry(b) ?? 0) - (timestampForEntry(a) ?? 0));
    const timestamps = sorted.map(timestampForEntry).filter((value): value is number => typeof value === 'number');
    const kinds = new Set(sorted.map((entry) => entry.sourceKind));
    const sourceKinds = (['history', 'bookmark'] as const).filter((kind) => kinds.has(kind));
    const browsers = mergeTags(sorted.map((entry) => entry.browser));
    const profileKeys = mergeTags(sorted.map((entry) => `${entry.browser}:${entry.profileName}`));
    const folders = mergeTags(sorted.flatMap((entry) => entry.sourceKind === 'bookmark' && entry.folderPath ? [entry.folderPath] : []));
    const visitCount = sorted.reduce((sum, entry) => (
      entry.sourceKind === 'history' ? sum + Math.max(1, entry.visitCount ?? 1) : sum
    ), 0);
    return {
      canonicalUri,
      entries: sorted,
      sourceKinds,
      browsers,
      profileKeys,
      folders,
      ...(timestamps.length ? { firstRecordedAt: Math.min(...timestamps), lastRecordedAt: Math.max(...timestamps) } : {}),
      visitCount,
    };
  }).sort((a, b) => (b.lastRecordedAt ?? 0) - (a.lastRecordedAt ?? 0));
}

async function upsertAggregate(
  context: KnowledgeIngestContext,
  aggregate: BrowserKnowledgeAggregate,
  options: Pick<BrowserKnowledgeIngestOptions, 'connectorId' | 'sessionId'> = {},
): Promise<KnowledgeSourceRecord> {
  const existing = context.store.getSourceByCanonicalUri(aggregate.canonicalUri);
  const sourceType = existing?.sourceType ?? sourceTypeForAggregate(aggregate);
  const connectorId = existing?.connectorId ?? options.connectorId ?? 'browser-local';
  const summary = describeAggregate(aggregate);
  const source = await context.store.upsertSource({
    ...(existing ? { id: existing.id } : {}),
    connectorId,
    sourceType,
    title: existing?.title ?? titleForAggregate(aggregate),
    sourceUri: existing?.sourceUri ?? aggregate.canonicalUri,
    canonicalUri: aggregate.canonicalUri,
    summary: existing?.summary ?? summary,
    description: existing?.description ?? summary,
    tags: mergeTags(existing?.tags, tagsForAggregate(aggregate)),
    folderPath: existing?.folderPath ?? folderForAggregate(aggregate),
    status: 'indexed',
    artifactId: existing?.artifactId,
    contentHash: existing?.contentHash ?? hashAggregate(aggregate),
    lastCrawledAt: existing?.lastCrawledAt ?? Date.now(),
    sessionId: options.sessionId ?? existing?.sessionId,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...metadataForAggregate(aggregate),
    },
  });

  const existingExtraction = context.store.getExtractionBySourceId(source.id);
  const extraction = existingExtraction ?? await context.store.upsertExtraction({
    sourceId: source.id,
    ...extractionForAggregate(aggregate, source),
  });

  for (const entry of aggregate.entries) {
    const browserNode = await context.store.upsertNode({
      kind: 'source_group',
      slug: slugify(`browser-${entry.browser}-${entry.profileName}`),
      title: `${entry.browser} ${entry.profileName}`,
      summary: `Local ${entry.browser} browser profile imported from ${entry.profilePath}.`,
      aliases: [entry.browser, entry.profileName],
      status: 'active',
      confidence: 85,
      metadata: {
        browser: entry.browser,
        browserFamily: entry.family,
        browserProfilePath: entry.profilePath,
      },
    });
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: browserNode.id,
      relation: entry.sourceKind === 'history' ? 'visited_in_browser_profile' : 'bookmarked_in_browser_profile',
      weight: timestampForEntry(entry) ? 1.2 : 1,
      metadata: {
        sourceKind: entry.sourceKind,
        recordedAt: timestampForEntry(entry),
        browser: entry.browser,
        profileName: entry.profileName,
        ...(entry.sourceKind === 'bookmark' && entry.folderPath ? { folderPath: entry.folderPath } : {}),
      },
    });
  }

  await compileKnowledgeSource(context, source, extraction);
  return source;
}

export async function collectBrowserKnowledge(
  filter: BrowserKnowledgeFilter = {},
): Promise<BrowserKnowledgeCollectResult> {
  const profiles = await discoverBrowserKnowledgeProfiles(filter);
  const entries: BrowserKnowledgeEntry[] = [];
  const errors: string[] = [];
  const perProfileLimit = Math.max(1, Math.ceil((filter.limit ?? 1000) / Math.max(1, profiles.length)));
  const sourceKinds = filter.sourceKinds ?? ['history', 'bookmark'] satisfies readonly BrowserKnowledgeSourceKind[];

  for (const profile of profiles) {
    try {
      const found = await readBrowserKnowledgeProfile(profile, {
        limit: perProfileLimit,
        sinceMs: filter.sinceMs,
        sourceKinds,
      });
      entries.push(...found);
    } catch (error) {
      errors.push(`${profile.browser}/${profile.profileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  entries.sort((a, b) => (timestampForEntry(b) ?? 0) - (timestampForEntry(a) ?? 0));
  return {
    profiles,
    entries: entries.slice(0, filter.limit ?? entries.length),
    errors,
  };
}

export async function ingestBrowserKnowledge(
  context: KnowledgeIngestContext,
  options: BrowserKnowledgeIngestOptions = {},
): Promise<KnowledgeBatchIngestResult & { readonly profiles: readonly BrowserKnowledgeProfile[] }> {
  await context.store.init();
  const collected = await collectBrowserKnowledge(options);
  const aggregates = aggregateBrowserEntries(collected.entries);
  const sources: KnowledgeSourceRecord[] = [];
  const errors = [...collected.errors];
  let imported = 0;
  let failed = 0;

  for (const aggregate of aggregates) {
    try {
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
        sourceId: aggregate.canonicalUri,
        connectorId: options.connectorId ?? 'browser-local',
        sourceType: sourceTypeForAggregate(aggregate),
        uri: aggregate.canonicalUri,
      }), options.sessionId);
      const source = await upsertAggregate(context, aggregate, options);
      sources.push(source);
      imported += 1;
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
        sourceId: source.id,
        status: source.status,
        title: source.title,
      }), source.sessionId);
    } catch (error) {
      failed += 1;
      errors.push(`${aggregate.canonicalUri}: ${summarizeError(error)}`);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
        sourceId: aggregate.canonicalUri,
        error: summarizeError(error),
      }), options.sessionId);
    }
  }

  await context.syncReviewedMemory();
  await context.lint();

  return {
    imported,
    failed,
    sources,
    errors,
    profiles: collected.profiles,
  };
}
