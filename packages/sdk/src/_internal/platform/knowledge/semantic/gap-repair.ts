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
import { withTimeout } from './timeouts.js';
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
  readonly maxSearches?: number;
  readonly maxSources?: number;
  readonly minDistinctDomains?: number;
  readonly minConfidence?: number;
  readonly maxIngest?: number;
  readonly searchTimeoutMs?: number;
  readonly ingestTimeoutMs?: number;
}

interface GapRepairSearchResult extends WebSearchResult {
  readonly searchQuery: string;
  readonly searchProviderId?: string;
}

interface GapRepairCandidate extends GapRepairSearchResult {
  readonly existingSourceId?: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

interface GapRepairSourceAssessment {
  readonly url: string;
  readonly title?: string;
  readonly domain?: string;
  readonly rank?: number;
  readonly query?: string;
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
  const queries = buildGapRepairQueries(request);
  if (queries.length === 0) {
    return {
      searched: false,
      ingestedSourceIds: [],
      skippedUrls: [],
      reason: 'No concrete subject was available for gap repair.',
    };
  }

  const existing = existingSources(request);
  const sourceLimit = Math.max(2, Math.min(5, request.maxSources ?? options.maxSources ?? options.maxIngest ?? 5));
  const searchLimit = Math.max(1, Math.min(5, options.maxSearches ?? queries.length));
  const existingCandidates = selectExistingRepairSources(request, options, sourceLimit);
  const searchResults = new Map<string, GapRepairSearchResult>();
  const providerIds = new Set<string>();
  let lastError: string | undefined;
  for (const query of queries.slice(0, searchLimit)) {
    if (request.signal?.aborted || deadlineExceeded(request.deadlineAt)) break;
    try {
      const timeoutMs = operationTimeout(request.deadlineAt, options.searchTimeoutMs ?? 8_000);
      if (timeoutMs <= 0) break;
      const response = await withTimeout(options.searchService.search({
        query,
        maxResults: Math.max(sourceLimit, Math.min(8, options.maxResults ?? sourceLimit)),
        verbosity: 'snippets',
        safeSearch: 'moderate',
        trustedHosts: trustedHostsForRepair(request),
        metadata: {
          purpose: 'knowledge-gap-repair',
          knowledgeSpaceId: request.spaceId,
        },
      }), Math.max(1_000, timeoutMs), 'Semantic gap repair search timed out.');
      if (response.providerId) providerIds.add(response.providerId);
      for (const result of response.results) {
        const canonical = canonicalizeUri(result.url);
        if (!canonical || searchResults.has(canonical)) continue;
        searchResults.set(canonical, { ...result, searchQuery: query, searchProviderId: response.providerId });
      }
      const partial = mergeRepairCandidates(existingCandidates, selectGapRepairCandidates([...searchResults.values()], existing, options, request, sourceLimit), sourceLimit);
      if (hasEnoughRepairEvidence(partial, options)) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (deadlineExceeded(request.deadlineAt)) break;
    }
  }

  const allResults = [...searchResults.values()];
  const candidates = mergeRepairCandidates(existingCandidates, selectGapRepairCandidates(allResults, existing, options, request, sourceLimit), sourceLimit);
  if (!hasEnoughRepairEvidence(candidates, options)) {
    return {
      searched: true,
      query: queries[0],
      evidenceSufficient: false,
      acceptedSourceIds: existingCandidates.map((candidate) => candidate.existingSourceId).filter((id): id is string => Boolean(id)),
      ingestedSourceIds: [],
      skippedUrls: allResults.map((result) => result.url),
      sourceAssessments: [
        ...existingCandidates.map((candidate) => candidateToAssessment(candidate, true)),
        ...buildSourceAssessments(allResults, candidates, existing, options, request),
      ],
      reason: lastError ?? 'Insufficient distinct source-backed evidence was found for gap repair.',
    };
  }

  const ingestedSourceIds: string[] = [];
  const skippedUrls: string[] = [];
  const existingSourceIds = candidates.map((candidate) => candidate.existingSourceId).filter((id): id is string => Boolean(id));
  const newCandidates = candidates.filter((candidate) => !candidate.existingSourceId);
  for (const result of newCandidates.slice(0, Math.max(0, Math.min(sourceLimit - existingSourceIds.length, options.maxIngest ?? sourceLimit)))) {
    if (request.signal?.aborted || deadlineExceeded(request.deadlineAt)) break;
    try {
      const timeoutMs = operationTimeout(request.deadlineAt, options.ingestTimeoutMs ?? 10_000);
      if (timeoutMs <= 0) break;
      const ingested = await withTimeout(options.ingestService.ingestUrl({
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        sourceType: 'url',
        connectorId: 'semantic-gap-repair',
        tags: ['semantic-gap-repair', 'gap-repair', ...gapRepairTags(request)],
        metadata: {
          knowledgeSpaceId: request.spaceId,
          sourceDiscovery: {
            purpose: 'semantic-gap-repair',
            query: result.searchQuery,
            searchQueries: queries.slice(0, searchLimit),
            providerId: result.searchProviderId ?? [...providerIds][0],
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
            checkedSourceLimit: sourceLimit,
            selectedUrl: result.url,
            searchedAt: Date.now(),
          },
        },
      }), Math.max(1_000, timeoutMs), 'Semantic gap repair source ingest timed out.');
      if (ingested.source.status === 'indexed' || ingested.source.status === 'pending') {
        ingestedSourceIds.push(ingested.source.id);
      }
    } catch {
      skippedUrls.push(result.url);
    }
    await yieldToEventLoop();
  }

  return {
    searched: true,
    query: queries[0],
    evidenceSufficient: true,
    acceptedSourceIds: uniqueStrings([...existingSourceIds, ...ingestedSourceIds]),
    ingestedSourceIds,
    skippedUrls,
    sourceAssessments: [
      ...existingCandidates.map((candidate) => candidateToAssessment(candidate, candidates.some((entry) => entry.url === candidate.url))),
      ...buildSourceAssessments(allResults, candidates, existing, options, request),
    ],
    ...(existingSourceIds.length + ingestedSourceIds.length < 1 ? { reason: 'Gap repair searched but did not accept usable sources.' } : {}),
  };
}

function buildGapRepairQueries(request: KnowledgeSemanticGapRepairRequest): readonly string[] {
  const subject = bestSubject(request);
  if (!subject) return [];
  const gapTerms = clampSearchTerms(uniqueStrings(request.gaps.flatMap((gap) => [
    gap.title,
    gap.summary,
    readString(gap.metadata.reason),
  ])).join(' '));
  const profileTerms = inferGapProfileTerms(request);
  return uniqueStrings([
    [subject, gapTerms, 'official specifications'].filter(Boolean).join(' '),
    [subject, profileTerms, 'product specifications'].filter(Boolean).join(' '),
    [subject, profileTerms, 'features ports connectivity audio display'].filter(Boolean).join(' '),
    [subject, 'manufacturer product page specifications'].join(' '),
    [subject, 'datasheet manual specifications'].join(' '),
  ].map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean));
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

function inferGapProfileTerms(request: KnowledgeSemanticGapRepairRequest): string {
  const text = request.gaps.map((gap) => `${gap.title} ${gap.summary ?? ''}`).join(' ').toLowerCase();
  const terms: string[] = [];
  if (/\b(port|ports|hdmi|usb|optical|rf|antenna|ethernet|rs-?232|composite|component|input|output|i\/o)\b/.test(text)) {
    terms.push('ports inputs outputs connectivity');
  }
  if (/\b(bluetooth|wifi|wi-fi|wireless|network)\b/.test(text)) terms.push('wireless bluetooth wi-fi network');
  if (/\b(refresh|hz|hdr|dolby|vision|gaming|vrr|allm|freesync)\b/.test(text)) terms.push('refresh rate hdr gaming vrr allm');
  if (/\b(audio|speaker|sound|earc|arc)\b/.test(text)) terms.push('audio speakers earc arc');
  if (/\b(display|screen|resolution|panel|lcd|oled|qled|nanocell)\b/.test(text)) terms.push('display resolution panel');
  return uniqueStrings([
    ...terms,
    ...tokenizeSemanticQuery(text)
      .filter((token) => token.length >= 3)
      .filter((token) => !['what', 'does', 'have', 'which', 'with', 'from', 'that', 'this', 'current', 'source', 'text'].includes(token))
      .slice(0, 12),
  ]).join(' ');
}

function clampSearchTerms(value: string): string {
  return tokenizeSemanticQuery(value).slice(0, 24).join(' ');
}

function existingSources(request: KnowledgeSemanticGapRepairRequest): ReadonlySet<string> {
  return new Set(request.sources.flatMap((source) => [
    canonicalizeUri(source.canonicalUri ?? ''),
    canonicalizeUri(source.sourceUri ?? ''),
  ].filter((value): value is string => Boolean(value))));
}

function selectGapRepairCandidates(
  results: readonly GapRepairSearchResult[],
  existingCanonicalUris: ReadonlySet<string>,
  options: WebGapRepairOptions,
  request: KnowledgeSemanticGapRepairRequest,
  sourceLimit: number,
): GapRepairCandidate[] {
  const tokens = tokenizeSemanticQuery([bestSubject(request), inferGapProfileTerms(request)].filter(Boolean).join(' '));
  const minimumConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const byDomain = new Map<string, GapRepairCandidate>();
  for (const result of results) {
    const canonical = canonicalizeUri(result.url);
    if (!canonical || existingCanonicalUris.has(canonical)) continue;
    const searchable = [result.title, result.snippet, result.url, result.domain].filter(Boolean).join(' ');
    if (tokens.length > 0 && scoreSemanticText(searchable, tokens) === 0) continue;
    const domain = result.domain ?? safeDomain(result.url);
    if (!domain || byDomain.has(domain)) continue;
    const assessment = assessGapRepairSource(result, result.searchQuery, request);
    if (assessment.confidence < minimumConfidence) continue;
    byDomain.set(domain, { ...result, confidence: assessment.confidence, reasons: assessment.reasons });
  }
  return [...byDomain.values()]
    .sort(compareRepairCandidates)
    .slice(0, sourceLimit);
}

function selectExistingRepairSources(
  request: KnowledgeSemanticGapRepairRequest,
  options: WebGapRepairOptions,
  sourceLimit: number,
): GapRepairCandidate[] {
  const minimumConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const byDomain = new Map<string, GapRepairCandidate>();
  for (const source of request.sources) {
    if (source.status !== 'indexed' || isGeneratedOrSyntheticSource(source)) continue;
    const url = source.sourceUri ?? source.canonicalUri;
    if (!url) continue;
    const domain = safeDomain(url);
    if (!domain || byDomain.has(domain)) continue;
    const snippet = [source.summary, source.description, source.tags.join(' ')].filter(Boolean).join(' ');
    const result: GapRepairSearchResult = {
      rank: 0,
      url,
      domain,
      displayUrl: url,
      type: 'organic',
      providerId: 'indexed',
      metadata: source.metadata,
      searchQuery: request.query,
      searchProviderId: 'indexed',
      ...(source.title ? { title: source.title } : {}),
      ...(snippet ? { snippet } : {}),
    };
    const assessment = assessGapRepairSource(result, request.query, request);
    if (assessment.confidence < minimumConfidence && !isOfficialOrVendorSource(assessment.reasons)) continue;
    byDomain.set(domain, {
      ...result,
      existingSourceId: source.id,
      confidence: Math.max(assessment.confidence, isOfficialOrVendorSource(assessment.reasons) ? 82 : assessment.confidence),
      reasons: uniqueStrings([...assessment.reasons, 'already-indexed']),
    });
  }
  return [...byDomain.values()].sort(compareRepairCandidates).slice(0, sourceLimit);
}

function assessGapRepairSource(
  result: GapRepairSearchResult,
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
    score += 28;
    reasons.push('manufacturer-domain');
  }
  if (domain && isOfficialVendorDomain(domain, identities.manufacturers)) {
    score += 28;
    reasons.push('official-vendor-domain');
  }
  return {
    url: result.url,
    ...(result.title ? { title: result.title } : {}),
    ...(domain ? { domain } : {}),
    rank: result.rank,
    query: result.searchQuery,
    confidence: Math.max(0, Math.min(100, score)),
    reasons,
    ...(reasons.length > 0 ? { trustReason: reasons.join(', ') } : {}),
  };
}

function mergeRepairCandidates(
  existingCandidates: readonly GapRepairCandidate[],
  searchCandidates: readonly GapRepairCandidate[],
  sourceLimit: number,
): GapRepairCandidate[] {
  const byCanonical = new Map<string, GapRepairCandidate>();
  for (const candidate of [...existingCandidates, ...searchCandidates]) {
    const key = canonicalizeUri(candidate.url) ?? candidate.url;
    const current = byCanonical.get(key);
    if (!current || compareRepairCandidates(candidate, current) < 0) byCanonical.set(key, candidate);
  }
  return [...byCanonical.values()].sort(compareRepairCandidates).slice(0, sourceLimit);
}

function hasEnoughRepairEvidence(candidates: readonly GapRepairCandidate[], options: WebGapRepairOptions): boolean {
  if (candidates.some((candidate) => candidate.reasons.includes('official-vendor-domain'))) return true;
  const required = Math.max(2, options.minDistinctDomains ?? 2);
  return new Set(candidates.map((candidate) => candidate.domain ?? safeDomain(candidate.url)).filter(Boolean)).size >= required;
}

function compareRepairCandidates(left: GapRepairCandidate, right: GapRepairCandidate): number {
  return sourceAuthorityScore(right) - sourceAuthorityScore(left)
    || right.confidence - left.confidence
    || left.rank - right.rank;
}

function sourceAuthorityScore(candidate: GapRepairCandidate): number {
  if (candidate.reasons.includes('official-vendor-domain')) return 3;
  if (candidate.reasons.includes('manufacturer-domain')) return 2;
  if (candidate.existingSourceId) return 1;
  return 0;
}

function buildSourceAssessments(
  results: readonly GapRepairSearchResult[],
  candidates: readonly GapRepairCandidate[],
  existingCanonicalUris: ReadonlySet<string>,
  options: WebGapRepairOptions,
  request: KnowledgeSemanticGapRepairRequest,
): readonly GapRepairSourceAssessment[] {
  const accepted = new Set(candidates.map((candidate) => canonicalizeUri(candidate.url)));
  const acceptedDomains = new Set(candidates.map((candidate) => candidate.domain ?? safeDomain(candidate.url)).filter(Boolean));
  const minimumConfidence = Math.max(1, Math.min(100, options.minConfidence ?? 70));
  const tokens = tokenizeSemanticQuery([bestSubject(request), inferGapProfileTerms(request)].filter(Boolean).join(' '));
  return results.map((result) => {
    const assessment = assessGapRepairSource(result, result.searchQuery, request);
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

function candidateToAssessment(candidate: GapRepairCandidate, accepted: boolean): GapRepairSourceAssessment {
  return {
    url: candidate.url,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.domain ? { domain: candidate.domain } : {}),
    rank: candidate.rank,
    query: candidate.searchQuery,
    accepted,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    trustReason: candidate.reasons.join(', '),
    ...(accepted ? {} : { rejectionReason: 'not-selected' }),
  };
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
  ]).concat(request.sources.flatMap((source) => manufacturerHints(`${source.title ?? ''} ${source.sourceUri ?? ''} ${source.canonicalUri ?? ''}`)))
    .map((manufacturer) => manufacturer?.trim().toLowerCase())
    .filter((manufacturer): manufacturer is string => Boolean(manufacturer)));
  return { models, manufacturers, subjects };
}

function trustedHostsForRepair(request: KnowledgeSemanticGapRepairRequest): readonly string[] {
  const manufacturers = sourceIdentityHints(request).manufacturers;
  const hosts: string[] = [];
  if (manufacturers.includes('lg')) hosts.push('lg.com', 'www.lg.com');
  if (manufacturers.includes('sony')) hosts.push('sony.com', 'www.sony.com');
  if (manufacturers.includes('samsung')) hosts.push('samsung.com', 'www.samsung.com');
  if (manufacturers.includes('apple')) hosts.push('apple.com', 'support.apple.com');
  if (manufacturers.includes('espressif') || manufacturers.includes('esp32')) hosts.push('espressif.com', 'docs.espressif.com');
  return uniqueStrings(hosts);
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

function isGeneratedOrSyntheticSource(source: KnowledgeSemanticGapRepairRequest['sources'][number]): boolean {
  return source.tags.includes('generated-page')
    || source.metadata.projectionKind === 'device-passport'
    || source.metadata.projectionKind === 'room-page';
}

function isOfficialVendorDomain(domain: string, manufacturers: readonly string[]): boolean {
  const lower = domain.toLowerCase();
  if (manufacturers.some((manufacturer) => manufacturer === 'lg' && /(^|\.)lg\.com$/.test(lower))) return true;
  if (manufacturers.some((manufacturer) => manufacturer === 'sony' && /(^|\.)sony\.(com|net)$/.test(lower))) return true;
  if (manufacturers.some((manufacturer) => manufacturer === 'samsung' && /(^|\.)samsung\.com$/.test(lower))) return true;
  if (manufacturers.some((manufacturer) => manufacturer === 'apple' && /(^|\.)apple\.com$/.test(lower))) return true;
  return manufacturers.some((manufacturer) => manufacturer.length >= 4 && lower.includes(manufacturer.toLowerCase()) && /\b(support|docs?|developer|product)\b/.test(lower));
}

function isOfficialOrVendorSource(reasons: readonly string[]): boolean {
  return reasons.includes('official-vendor-domain') || reasons.includes('manufacturer-domain');
}

function deadlineExceeded(deadlineAt: number | undefined): boolean {
  return typeof deadlineAt === 'number' && Date.now() >= deadlineAt;
}

function operationTimeout(deadlineAt: number | undefined, fallbackMs: number): number {
  if (typeof deadlineAt !== 'number') return fallbackMs;
  return Math.min(fallbackMs, Math.max(0, deadlineAt - Date.now()));
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

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function gapRepairTags(request: KnowledgeSemanticGapRepairRequest): readonly string[] {
  return uniqueStrings([
    ...request.linkedObjects.flatMap((node) => [node.kind, node.title]),
    ...request.sources.flatMap((source) => source.tags),
  ]).slice(0, 12);
}
