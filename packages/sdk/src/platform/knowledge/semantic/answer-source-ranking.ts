import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { readRecord, readString, readStringArray, uniqueStrings } from './utils.js';

export interface AnswerSourceRankingEvidence {
  readonly score: number;
  readonly source?: KnowledgeSourceRecord | undefined;
}

export function rankAnswerSources(
  evidence: readonly AnswerSourceRankingEvidence[],
  facts: readonly KnowledgeNodeRecord[],
): KnowledgeSourceRecord[] {
  const evidenceScoreBySource = new Map<string, number>();
  for (const item of evidence) {
    if (!item.source) continue;
    evidenceScoreBySource.set(item.source.id, Math.max(evidenceScoreBySource.get(item.source.id) ?? 0, item.score));
  }
  const factCountBySource = new Map<string, number>();
  const promotedFactCountBySource = new Map<string, number>();
  for (const fact of facts) {
    const sourceIds = uniqueStrings([
      ...readStringArray(fact.metadata.sourceIds),
      readString(fact.metadata.sourceId),
      fact.sourceId,
    ]);
    if (sourceIds.length === 0) continue;
    if (readString(fact.metadata.extractor) === 'repair-promotion') {
      for (const sourceId of sourceIds) {
        promotedFactCountBySource.set(sourceId, (promotedFactCountBySource.get(sourceId) ?? 0) + 1);
      }
    }
    for (const sourceId of sourceIds) {
      factCountBySource.set(sourceId, (factCountBySource.get(sourceId) ?? 0) + 1);
    }
  }
  const sources = uniqueSources(evidence.flatMap((item) => item.source ? [item.source] : []));
  const realSources = sources.filter((source) => !isGeneratedKnowledgeSource(source));
  return (realSources.length > 0 ? realSources : sources)
    .sort((left, right) => (
      sourceAnswerQuality(right, evidenceScoreBySource, factCountBySource, promotedFactCountBySource)
      - sourceAnswerQuality(left, evidenceScoreBySource, factCountBySource, promotedFactCountBySource)
      || left.id.localeCompare(right.id)
    ));
}

function sourceAnswerQuality(
  source: KnowledgeSourceRecord,
  evidenceScoreBySource: ReadonlyMap<string, number>,
  factCountBySource: ReadonlyMap<string, number>,
  promotedFactCountBySource: ReadonlyMap<string, number>,
): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const rank = typeof discovery.sourceRank === 'number' ? Math.max(0, 12 - discovery.sourceRank) : 0;
  return Math.round((evidenceScoreBySource.get(source.id) ?? 0) / 4)
    + sourceAuthorityBoostForAnswer(source)
    + Math.min(80, (factCountBySource.get(source.id) ?? 0) * 10)
    + Math.min(90, (promotedFactCountBySource.get(source.id) ?? 0) * 18)
    + rank * 4
    + (source.status === 'indexed' ? 12 : source.status === 'pending' ? 2 : 0)
    - (isGeneratedKnowledgeSource(source) ? 90 : 0);
}

export function sourceAuthorityBoostForAnswer(source: KnowledgeSourceRecord): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const text = [
    readString(discovery.trustReason),
    readString(discovery.sourceDomain),
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bofficial-vendor-domain\b/.test(text)) return 140;
  if (/\bofficial\b/.test(text) && /\b(support|specifications?|manual|product|docs?|datasheet)\b/.test(text) && !isCommercialLowValueSourceText(text)) return 120;
  if (/\bmanufacturer-domain\b/.test(text)) return 80;
  return 0;
}

function isCommercialLowValueSourceText(text: string): boolean {
  return /\b(shopping|shop now|affiliate|associate program|buy now|add to cart|price comparison|marketplace|retailer|store listing|seller listing|sponsored listing|latest price|compare prices)\b/.test(text)
    || /(^|\.)amazon\.[a-z.]+\b|(^|\.)ebay\.[a-z.]+\b|(^|\.)walmart\.[a-z.]+\b|(^|\.)bestbuy\.[a-z.]+\b|(^|\.)target\.[a-z.]+\b/.test(text);
}

function uniqueSources(values: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeSourceRecord[] = [];
  for (const source of values) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    result.push(source);
  }
  return result;
}
