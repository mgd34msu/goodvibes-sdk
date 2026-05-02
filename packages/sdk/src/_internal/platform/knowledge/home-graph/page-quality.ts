import type { KnowledgeSourceRecord } from '../types.js';
import { sourceAuthorityBoostForAnswer } from '../semantic/answer-source-ranking.js';
import { isGeneratedPageSource, mergeSourceStatus, readRecord } from './helpers.js';

export function isUsefulHomeGraphPageSource(source: KnowledgeSourceRecord): boolean {
  if (!isUsableHomeGraphPageSourceStatus(source)) return false;
  if (isGeneratedPageSource(source)) return false;
  return !isLowValueHomeGraphPageSource(source);
}

export function isUsefulHomeGraphPageSourceCandidate(
  source: KnowledgeSourceRecord,
  existing?: KnowledgeSourceRecord,
): boolean {
  const status = mergeSourceStatus(source.status, existing?.status);
  if (!isUsableHomeGraphPageSourceStatus(source, status)) return false;
  if (isGeneratedPageSource(source) || (existing && isGeneratedPageSource(existing))) return false;
  return !isLowValueHomeGraphPageSource(source, existing);
}

export function compareHomeGraphPageSources(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): number {
  return homeGraphPageSourceQuality(right) - homeGraphPageSourceQuality(left)
    || sourceLabel(left).localeCompare(sourceLabel(right))
    || left.id.localeCompare(right.id);
}

export function homeGraphPageSourceWeight(source: KnowledgeSourceRecord): number {
  return Math.min(0.98, Math.max(0.55, homeGraphPageSourceQuality(source) / 120));
}

function homeGraphPageSourceQuality(source: KnowledgeSourceRecord): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const rank = typeof discovery.sourceRank === 'number' ? Math.max(0, 12 - discovery.sourceRank) : 0;
  const uri = sourceUriText(source).toLowerCase();
  return sourceAuthorityBoostForAnswer(source)
    + rank * 5
    + 24
    + (source.sourceType === 'document' ? 10 : source.sourceType === 'url' ? 6 : 0)
    + (/\b(?:support|specifications?|manual|product)\b/.test(uri) ? 10 : 0)
    - (isLowValueHomeGraphPageSource(source) ? 120 : 0);
}

function isUsableHomeGraphPageSourceStatus(
  source: KnowledgeSourceRecord,
  status: KnowledgeSourceRecord['status'] = source.status,
): boolean {
  if (status === 'indexed') return true;
  if (status !== 'pending') return false;
  return sourceAuthorityBoostForAnswer(source) > 0 || looksLikeUsablePendingPageSource(source);
}

function isLowValueHomeGraphPageSource(source: KnowledgeSourceRecord, existing?: KnowledgeSourceRecord): boolean {
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
  if (/\b(?:speaker\s*compare|manuals?\.[a-z]{2,}|device\s*ratings?|top\s+\d+\s+devices?)\b/.test(text)) return true;
  if (/\b(ranking system|ranked by|latest price|prices? & features?|review score|compare prices)\b/.test(text)) return true;
  return false;
}

function looksLikeUsablePendingPageSource(source: KnowledgeSourceRecord): boolean {
  const text = [
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(support|specifications?|manual|product|datasheet|docs?)\b/.test(text)
    && !isLowValueHomeGraphPageSource(source);
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
