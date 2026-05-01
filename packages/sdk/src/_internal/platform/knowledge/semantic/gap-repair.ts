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
  readonly minConfidence?: number;
  readonly maxIngest?: number;
}

interface GapRepairCandidate extends WebSearchResult {
  readonly confidence: number;
  readonly reasons: readonly string[];
}

interface GapRepairSourceAssessment {
  readonly url: string;
  readonly title?: string;
  readonly domain?: string;
  readonly rank?: number;
  readonly accepted: boolean;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly trustReason?: string;
  readonly rejectionReason?: string;
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
  const candidates = selectGapRepairCandidates(response.results, existing, options, query, request);
  if (candidates.length < Math.max(2, options.minDistinctDomains ?? 2)) {
    return {
      searched: true,
      query,
      ingestedSourceIds: [],
      skippedUrls: response.results.map((result) => result.url),
      sourceAssessments: buildSourceAssessments(response.results, candidates, existing, options, query, request),
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
            confidence: result.confidence,
            confidenceReasons: result.reasons,
            sourceRank: result.rank,
            sourceDomain: result.domain ?? safeDomain(result.url),
            trustReason: result.reasons.join(', '),
            agreementSourceCount: candidates.length,
            selectedUrl: result.url,
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
    sourceAssessments: buildSourceAssessments(response.results, candidates, existing, options, query, request),
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
  const identity = uniqueStrings([
    readString(metadata.manufacturer),
    readString(metadata.model),
  ]).join(' ');
  if (identity) return identity;
  return uniqueStrings([
    linked?.title,
    source?.title,
  ]).join(' ') || null;
}

function selectGapRepairCandidates(
  results: readonly WebSearchResult[],
  existingCanonicalUris: ReadonlySet<string>,
  options: WebGapRepairOptions,
  query: string,
  request: KnowledgeSemanticGapRepairRequest,
): GapRepairCandidate[] {
  const tokens = tokenizeSemanticQuery(query);
  const minimumConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const byDomain = new Map<string, GapRepairCandidate>();
  for (const result of results) {
    const canonical = canonicalizeUri(result.url);
    if (!canonical || existingCanonicalUris.has(canonical)) continue;
    const searchable = [result.title, result.snippet, result.url, result.domain].filter(Boolean).join(' ');
    if (tokens.length > 0 && scoreSemanticText(searchable, tokens) === 0) continue;
    const domain = result.domain ?? safeDomain(result.url);
    if (!domain || byDomain.has(domain)) continue;
    const assessment = assessGapRepairSource(result, query, request);
    if (assessment.confidence < minimumConfidence) continue;
    byDomain.set(domain, { ...result, confidence: assessment.confidence, reasons: assessment.reasons });
  }
  return [...byDomain.values()]
    .sort((left, right) => right.confidence - left.confidence || left.rank - right.rank)
    .slice(0, Math.max(2, Math.min(8, options.maxResults ?? 6)));
}

function assessGapRepairSource(
  result: WebSearchResult,
  query: string,
  request: KnowledgeSemanticGapRepairRequest,
): Omit<GapRepairSourceAssessment, 'accepted' | 'rejectionReason'> {
  const searchable = [result.title, result.snippet, result.url, result.domain].filter(Boolean).join(' ').toLowerCase();
  const reasons: string[] = [];
  let score = Math.max(0, 12 - result.rank);
  const identities = sourceIdentityHints(request);
  for (const model of identities.models) {
    if (hasIdentity(searchable, model)) {
      score += model.length >= 8 ? 42 : 28;
      reasons.push(`model:${model}`);
      break;
    }
  }
  for (const manufacturer of identities.manufacturers) {
    if (hasIdentity(searchable, manufacturer)) {
      score += 14;
      reasons.push(`manufacturer:${manufacturer}`);
      break;
    }
  }
  for (const subject of identities.subjects) {
    if (subject.length >= 4 && hasIdentity(searchable, subject)) {
      score += 30;
      reasons.push(`subject:${subject}`);
      break;
    }
  }
  const queryScore = scoreSemanticText(searchable, tokenizeSemanticQuery(query));
  if (queryScore > 0) {
    score += Math.min(18, queryScore);
    reasons.push('query-match');
  }
  const gapScore = scoreSemanticText(searchable, tokenizeSemanticQuery(request.gaps.map((gap) => `${gap.title} ${gap.summary ?? ''}`).join(' ')));
  if (gapScore > 0) {
    score += Math.min(14, gapScore);
    reasons.push('gap-match');
  }
  const domain = (result.domain ?? safeDomain(result.url) ?? '').toLowerCase();
  if (/\b(specifications?|features?|manual|support|product|documentation|datasheet)\b/.test(searchable)) {
    score += 10;
    reasons.push('source-purpose');
  }
  if (domain && identities.manufacturers.some((manufacturer) => manufacturer.length >= 2 && domain.includes(manufacturer.toLowerCase()))) {
    score += 10;
    reasons.push('manufacturer-domain');
  }
  return {
    url: result.url,
    ...(result.title ? { title: result.title } : {}),
    ...(domain ? { domain } : {}),
    rank: result.rank,
    confidence: Math.max(0, Math.min(100, score)),
    reasons,
    ...(reasons.length > 0 ? { trustReason: reasons.join(', ') } : {}),
  };
}

function buildSourceAssessments(
  results: readonly WebSearchResult[],
  candidates: readonly GapRepairCandidate[],
  existingCanonicalUris: ReadonlySet<string>,
  options: WebGapRepairOptions,
  query: string,
  request: KnowledgeSemanticGapRepairRequest,
): readonly GapRepairSourceAssessment[] {
  const accepted = new Set(candidates.map((candidate) => canonicalizeUri(candidate.url)));
  const acceptedDomains = new Set(candidates.map((candidate) => candidate.domain ?? safeDomain(candidate.url)).filter(Boolean));
  const minimumConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const tokens = tokenizeSemanticQuery(query);
  return results.map((result) => {
    const assessment = assessGapRepairSource(result, query, request);
    const canonical = canonicalizeUri(result.url);
    const domain = result.domain ?? safeDomain(result.url);
    const isAccepted = Boolean(canonical && accepted.has(canonical));
    let rejectionReason: string | undefined;
    if (!isAccepted) {
      if (canonical && existingCanonicalUris.has(canonical)) rejectionReason = 'already-indexed';
      else if (tokens.length > 0 && scoreSemanticText([result.title, result.snippet, result.url, domain].filter(Boolean).join(' '), tokens) === 0) rejectionReason = 'query-mismatch';
      else if (assessment.confidence < minimumConfidence) rejectionReason = 'below-confidence-threshold';
      else if (domain && acceptedDomains.has(domain)) rejectionReason = 'duplicate-domain';
      else rejectionReason = 'not-selected';
    }
    return {
      ...assessment,
      accepted: isAccepted,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  });
}

function sourceIdentityHints(request: KnowledgeSemanticGapRepairRequest): {
  readonly models: readonly string[];
  readonly manufacturers: readonly string[];
  readonly subjects: readonly string[];
} {
  const subjects = uniqueStrings([
    ...request.linkedObjects.flatMap((node) => [node.title, ...node.aliases]),
    ...request.sources.flatMap((source) => [source.title, source.summary]),
  ]).filter((subject) => !isGenericSubject(subject));
  const models = uniqueStrings(request.linkedObjects.flatMap((node) => [
    readString(node.metadata.model),
    readString(node.metadata.modelId),
    readString(node.metadata.model_id),
    ...modelLikeTokens(`${node.title} ${node.aliases.join(' ')}`),
  ]).concat(request.sources.flatMap((source) => modelLikeTokens(`${source.title ?? ''} ${source.sourceUri ?? ''} ${source.canonicalUri ?? ''}`))));
  const manufacturers = uniqueStrings(request.linkedObjects.flatMap((node) => [
    readString(node.metadata.manufacturer),
    readString(node.metadata.vendor),
  ]).concat(request.sources.flatMap((source) => manufacturerHints(`${source.title ?? ''} ${source.sourceUri ?? ''} ${source.canonicalUri ?? ''}`))));
  return { models, manufacturers, subjects };
}

function isGenericSubject(value: string): boolean {
  return /^(tv|television|device|manual|user guide|owner manual|home assistant|service|provider|integration)$/i.test(value.trim());
}

function modelLikeTokens(value: string): readonly string[] {
  return uniqueStrings(value.match(/\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/g) ?? []);
}

function manufacturerHints(value: string): readonly string[] {
  const hints = value.match(/\b(lg|samsung|sony|vizio|tcl|hisense|philips|panasonic|kasa|tp-link|ecobee|honeywell|ring|arlo|nest|eufy|aqara|sonoff|shelly|lutron|leviton|ikea|bosch|ge|whirlpool|frigidaire|apple|espressif|esp32|nabu casa|home assistant)\b/gi) ?? [];
  return uniqueStrings(hints.map((hint) => hint.toLowerCase()));
}

function hasIdentity(searchable: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replace(/[\s_-]+/g, '');
  const searchableCompact = searchable.replace(/[\s_-]+/g, '');
  if (compact.length >= 4 && searchableCompact.includes(compact)) return true;
  return searchable.includes(normalized);
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
