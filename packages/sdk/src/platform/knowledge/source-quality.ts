import type { KnowledgeSourceRecord } from './types.js';

export interface KnowledgePageSourceQualityPolicy {
  readonly isGeneratedSource?: ((source: KnowledgeSourceRecord) => boolean) | undefined;
  readonly authorityBoost?: ((source: KnowledgeSourceRecord) => number) | undefined;
  readonly isLowValueSource?: ((source: KnowledgeSourceRecord, existing?: KnowledgeSourceRecord) => boolean) | undefined;
  readonly usablePendingPattern?: RegExp | undefined;
  readonly qualityKeywordPattern?: RegExp | undefined;
}

const DEFAULT_USABLE_PENDING_PATTERN = /\b(support|specifications?|manual|product|datasheet|docs?)\b/;
const DEFAULT_QUALITY_KEYWORD_PATTERN = /\b(?:support|specifications?|manual|product)\b/;
const MAX_PAGE_SOURCE_WEIGHT = 0.98;
const MIN_USABLE_PAGE_SOURCE_WEIGHT = 0.05;
const SOURCE_QUALITY_WEIGHT_DIVISOR = 120;

export function isUsefulKnowledgePageSource(
  source: KnowledgeSourceRecord,
  policy: KnowledgePageSourceQualityPolicy = {},
): boolean {
  if (!isUsableKnowledgePageSourceStatus(source, source.status, policy)) return false;
  if (policy.isGeneratedSource?.(source)) return false;
  return !isLowValueKnowledgePageSource(source, undefined, policy);
}

export function isUsefulKnowledgePageSourceCandidate(
  source: KnowledgeSourceRecord,
  existing: KnowledgeSourceRecord | undefined,
  status: KnowledgeSourceRecord['status'],
  policy: KnowledgePageSourceQualityPolicy = {},
): boolean {
  if (!isUsableKnowledgePageSourceStatus(source, status, policy)) return false;
  if (policy.isGeneratedSource?.(source) || (existing && policy.isGeneratedSource?.(existing))) return false;
  return !isLowValueKnowledgePageSource(source, existing, policy);
}

export function compareKnowledgePageSources(
  left: KnowledgeSourceRecord,
  right: KnowledgeSourceRecord,
  policy: KnowledgePageSourceQualityPolicy = {},
): number {
  return knowledgePageSourceQuality(right, policy) - knowledgePageSourceQuality(left, policy)
    || sourceLabel(left).localeCompare(sourceLabel(right))
    || left.id.localeCompare(right.id);
}

export function knowledgePageSourceWeight(
  source: KnowledgeSourceRecord,
  policy: KnowledgePageSourceQualityPolicy = {},
): number {
  const quality = knowledgePageSourceQuality(source, policy);
  if (quality <= 0) return 0;
  return Math.min(
    MAX_PAGE_SOURCE_WEIGHT,
    Math.max(MIN_USABLE_PAGE_SOURCE_WEIGHT, quality / SOURCE_QUALITY_WEIGHT_DIVISOR),
  );
}

function knowledgePageSourceQuality(
  source: KnowledgeSourceRecord,
  policy: KnowledgePageSourceQualityPolicy,
): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const rank = typeof discovery.sourceRank === 'number' ? Math.max(0, 12 - discovery.sourceRank) : 0;
  const uri = sourceUriText(source).toLowerCase();
  const authorityBoost = policy.authorityBoost?.(source) ?? 0;
  return authorityBoost
    + rank * 5
    + 24
    + (source.sourceType === 'document' ? 10 : source.sourceType === 'url' ? 6 : 0)
    + ((policy.qualityKeywordPattern ?? DEFAULT_QUALITY_KEYWORD_PATTERN).test(uri) ? 10 : 0)
    - (isLowValueKnowledgePageSource(source, undefined, policy) ? 120 : 0);
}

function isUsableKnowledgePageSourceStatus(
  source: KnowledgeSourceRecord,
  status: KnowledgeSourceRecord['status'],
  policy: KnowledgePageSourceQualityPolicy,
): boolean {
  if (status === 'indexed') return true;
  if (status !== 'pending') return false;
  const authorityBoost = policy.authorityBoost?.(source) ?? 0;
  return authorityBoost > 0 || looksLikeUsablePendingPageSource(source, policy);
}

function isLowValueKnowledgePageSource(
  source: KnowledgeSourceRecord,
  existing: KnowledgeSourceRecord | undefined,
  policy: KnowledgePageSourceQualityPolicy,
): boolean {
  if (policy.isLowValueSource?.(source, existing)) return true;
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const existingDiscovery = readRecord(existing?.metadata.sourceDiscovery);
  const text = [
    source.title,
    existing?.title,
    source.summary,
    existing?.summary,
    source.description,
    existing?.description,
    source.url,
    existing?.url,
    source.sourceUri,
    existing?.sourceUri,
    source.canonicalUri,
    existing?.canonicalUri,
    typeof discovery.trustReason === 'string' ? discovery.trustReason : undefined,
    typeof existingDiscovery.trustReason === 'string' ? existingDiscovery.trustReason : undefined,
    typeof discovery.sourceDomain === 'string' ? discovery.sourceDomain : undefined,
    typeof existingDiscovery.sourceDomain === 'string' ? existingDiscovery.sourceDomain : undefined,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(?:shopping|shop now|affiliate|associate program|buy now|add to cart|price comparison|marketplace|retailer|store listing|seller listing|sponsored listing)\b/.test(text)) return true;
  if (/(^|\.)amazon\.[a-z.]+\b|(^|\.)ebay\.[a-z.]+\b|(^|\.)walmart\.[a-z.]+\b|(^|\.)bestbuy\.[a-z.]+\b|(^|\.)target\.[a-z.]+\b/.test(text)) return true;
  if (/\b(ranking system|ranked by|latest price|prices? & features?|review score|compare prices)\b/.test(text)) return true;
  return false;
}

function looksLikeUsablePendingPageSource(
  source: KnowledgeSourceRecord,
  policy: KnowledgePageSourceQualityPolicy,
): boolean {
  const text = [
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ').toLowerCase();
  return (policy.usablePendingPattern ?? DEFAULT_USABLE_PENDING_PATTERN).test(text)
    && !isLowValueKnowledgePageSource(source, undefined, policy);
}

function sourceUriText(source: KnowledgeSourceRecord): string {
  return [
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ');
}

function sourceLabel(source: KnowledgeSourceRecord): string {
  return source.title ?? source.url ?? source.sourceUri ?? source.canonicalUri ?? source.id;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
