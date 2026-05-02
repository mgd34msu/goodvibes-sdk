import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { readRecord, readString } from './utils.js';

export interface AnswerSourceRankingEvidence {
  readonly score: number;
  readonly source?: KnowledgeSourceRecord;
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
    const sourceId = readString(fact.metadata.sourceId) ?? fact.sourceId;
    if (!sourceId) continue;
    factCountBySource.set(sourceId, (factCountBySource.get(sourceId) ?? 0) + 1);
    if (readString(fact.metadata.extractor) === 'repair-promotion') {
      promotedFactCountBySource.set(sourceId, (promotedFactCountBySource.get(sourceId) ?? 0) + 1);
    }
  }
  const sources = uniqueSources(evidence.flatMap((item) => item.source ? [item.source] : []));
  const realSources = sources.filter((source) => source.metadata.homeGraphGeneratedPage !== true);
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
    - (source.metadata.homeGraphGeneratedPage === true ? 90 : 0);
}

export function sourceAuthorityBoostForAnswer(source: KnowledgeSourceRecord): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const text = `${readString(discovery.trustReason) ?? ''} ${readString(discovery.sourceDomain) ?? ''} ${source.sourceUri ?? ''} ${source.canonicalUri ?? ''}`.toLowerCase();
  if (/\bofficial-vendor-domain\b/.test(text) || /(^|[/.])(?:lg|sony|samsung|apple)\.com\b/.test(text)) return 140;
  if (/\bmanufacturer-domain\b/.test(text)) return 80;
  return 0;
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
