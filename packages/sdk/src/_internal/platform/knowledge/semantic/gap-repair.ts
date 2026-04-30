import type {
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from '../../web-search/types.js';
import { canonicalizeUri } from '../internal.js';
import type { KnowledgeSourceType } from '../types.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticGapRepairRequest,
  KnowledgeSemanticGapRepairResult,
} from './types.js';
import { readString, scoreSemanticText, tokenizeSemanticQuery, uniqueStrings } from './utils.js';

interface GapRepairSearch {
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

interface GapRepairIngest {
  ingestUrl(input: {
    readonly url: string;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly sourceType?: KnowledgeSourceType;
    readonly connectorId?: string;
    readonly allowPrivateHosts?: boolean;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly source: { readonly id: string; readonly status: string } }>;
}

export interface WebGapRepairOptions {
  readonly searchService: GapRepairSearch;
  readonly ingestService: GapRepairIngest;
  readonly maxResults?: number;
  readonly minDistinctDomains?: number;
  readonly maxIngest?: number;
}

export function createWebKnowledgeGapRepairer(options: WebGapRepairOptions): KnowledgeSemanticGapRepairer {
  return async (request) => repairKnowledgeGapsWithWeb(request, options);
}

async function repairKnowledgeGapsWithWeb(
  request: KnowledgeSemanticGapRepairRequest,
  options: WebGapRepairOptions,
): Promise<KnowledgeSemanticGapRepairResult> {
  const query = buildGapRepairQuery(request);
  if (!query) {
    return {
      searched: false,
      ingestedSourceIds: [],
      skippedUrls: [],
      reason: 'No concrete subject was available for gap repair.',
    };
  }

  let response: WebSearchResponse;
  try {
    response = await options.searchService.search({
      query,
      maxResults: Math.max(2, Math.min(12, options.maxResults ?? 6)),
      verbosity: 'snippets',
      safeSearch: 'moderate',
      metadata: {
        purpose: 'knowledge-gap-repair',
        knowledgeSpaceId: request.spaceId,
      },
    });
  } catch (error) {
    return {
      searched: true,
      query,
      ingestedSourceIds: [],
      skippedUrls: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const existing = new Set(request.sources.flatMap((source) => [
    canonicalizeUri(source.canonicalUri ?? ''),
    canonicalizeUri(source.sourceUri ?? ''),
  ].filter((value): value is string => Boolean(value))));
  const candidates = selectGapRepairCandidates(response.results, existing, options, query);
  if (candidates.length < Math.max(2, options.minDistinctDomains ?? 2)) {
    return {
      searched: true,
      query,
      ingestedSourceIds: [],
      skippedUrls: response.results.map((result) => result.url),
      reason: 'Fewer than two distinct external sources were found for source-backed gap repair.',
    };
  }

  const ingestedSourceIds: string[] = [];
  const skippedUrls: string[] = [];
  for (const result of candidates.slice(0, Math.max(2, Math.min(4, options.maxIngest ?? 3)))) {
    try {
      const ingested = await options.ingestService.ingestUrl({
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        sourceType: 'url',
        connectorId: 'semantic-gap-repair',
        tags: ['semantic-gap-repair', 'gap-repair', ...gapRepairTags(request)],
        metadata: {
          knowledgeSpaceId: request.spaceId,
          sourceDiscovery: {
            purpose: 'semantic-gap-repair',
            query,
            providerId: response.providerId,
            gapIds: request.gaps.map((gap) => gap.id),
            gapQuestions: request.gaps.map((gap) => gap.title),
            originalSourceIds: request.sources.map((source) => source.id),
            linkedObjectIds: request.linkedObjects.map((node) => node.id),
            searchedAt: Date.now(),
          },
        },
      });
      if (ingested.source.status === 'indexed' || ingested.source.status === 'pending') {
        ingestedSourceIds.push(ingested.source.id);
      }
    } catch {
      skippedUrls.push(result.url);
    }
  }

  return {
    searched: true,
    query,
    ingestedSourceIds,
    skippedUrls,
    ...(ingestedSourceIds.length < 2 ? { reason: 'Gap repair searched but fewer than two sources were ingested.' } : {}),
  };
}

function buildGapRepairQuery(request: KnowledgeSemanticGapRepairRequest): string | null {
  const subject = bestSubject(request);
  if (!subject) return null;
  const gapTerms = uniqueStrings(request.gaps.flatMap((gap) => [
    gap.title,
    gap.summary,
    readString(gap.metadata.reason),
  ])).join(' ');
  return uniqueStrings([
    subject,
    gapTerms,
    'official specifications features',
  ]).join(' ');
}

function bestSubject(request: KnowledgeSemanticGapRepairRequest): string | null {
  const linked = request.linkedObjects[0];
  const source = request.sources[0];
  const metadata = linked?.metadata ?? {};
  return uniqueStrings([
    readString(metadata.manufacturer),
    readString(metadata.model),
    linked?.title,
    source?.title,
  ]).join(' ') || null;
}

function selectGapRepairCandidates(
  results: readonly WebSearchResult[],
  existingCanonicalUris: ReadonlySet<string>,
  options: WebGapRepairOptions,
  query: string,
): WebSearchResult[] {
  const tokens = tokenizeSemanticQuery(query);
  const byDomain = new Map<string, WebSearchResult>();
  for (const result of results) {
    const canonical = canonicalizeUri(result.url);
    if (!canonical || existingCanonicalUris.has(canonical)) continue;
    const searchable = [result.title, result.snippet, result.url, result.domain].filter(Boolean).join(' ');
    if (tokens.length > 0 && scoreSemanticText(searchable, tokens) === 0) continue;
    const domain = result.domain ?? safeDomain(result.url);
    if (!domain || byDomain.has(domain)) continue;
    byDomain.set(domain, result);
  }
  return [...byDomain.values()].slice(0, Math.max(2, Math.min(8, options.maxResults ?? 6)));
}

function safeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function gapRepairTags(request: KnowledgeSemanticGapRepairRequest): readonly string[] {
  return uniqueStrings([
    ...request.linkedObjects.flatMap((node) => [node.kind, node.title]),
    ...request.sources.flatMap((source) => source.tags),
  ]).slice(0, 12);
}
