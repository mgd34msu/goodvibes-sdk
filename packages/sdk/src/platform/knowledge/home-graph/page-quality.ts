import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { sourceAuthorityBoostForAnswer } from '../semantic/answer-source-ranking.js';
import { isUsefulKnowledgePageFact } from '../semantic/fact-quality.js';
import {
  compareKnowledgePageSources,
  isUsefulKnowledgePageSource,
  isUsefulKnowledgePageSourceCandidate,
  knowledgePageSourceWeight,
  type KnowledgePageSourceQualityPolicy,
} from '../source-quality.js';
import { isGeneratedPageSource, mergeSourceStatus, readRecord } from './helpers.js';

const HOME_GRAPH_PAGE_SOURCE_POLICY: KnowledgePageSourceQualityPolicy = {
  isGeneratedSource: isGeneratedPageSource,
  authorityBoost: sourceAuthorityBoostForAnswer,
  isLowValueSource: isLowValueHomeGraphPageSource,
};

export function isUsefulHomeGraphPageFact(fact: KnowledgeNodeRecord): boolean {
  return isUsefulKnowledgePageFact(fact, { rejectRemoteAccessoryDetails: true });
}

export function isUsefulHomeGraphPageSource(source: KnowledgeSourceRecord): boolean {
  return isUsefulKnowledgePageSource(source, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function isUsefulHomeGraphPageSourceCandidate(
  source: KnowledgeSourceRecord,
  existing?: KnowledgeSourceRecord,
): boolean {
  const status = mergeSourceStatus(source.status, existing?.status);
  return isUsefulKnowledgePageSourceCandidate(source, existing, status, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function compareHomeGraphPageSources(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): number {
  return compareKnowledgePageSources(left, right, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function homeGraphPageSourceWeight(source: KnowledgeSourceRecord): number {
  return knowledgePageSourceWeight(source, HOME_GRAPH_PAGE_SOURCE_POLICY);
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
  return false;
}
