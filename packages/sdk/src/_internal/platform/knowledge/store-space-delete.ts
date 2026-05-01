import { SQLiteStore } from '../state/sqlite-store.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from './spaces.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobRunRecord,
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeScheduleRecord,
  KnowledgeSourceRecord,
  KnowledgeUsageRecord,
} from './types.js';

export interface KnowledgeSpaceDeleteResult {
  readonly sources: number;
  readonly nodes: number;
  readonly edges: number;
  readonly issues: number;
  readonly extractions: number;
  readonly jobRuns: number;
  readonly refinementTasks: number;
  readonly usageRecords: number;
  readonly consolidationCandidates: number;
  readonly consolidationReports: number;
  readonly schedules: number;
}

export interface KnowledgeSpaceDeleteStores {
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly jobRuns: Map<string, KnowledgeJobRunRecord>;
  readonly refinementTasks: Map<string, KnowledgeRefinementTaskRecord>;
  readonly usageRecords: Map<string, KnowledgeUsageRecord>;
  readonly consolidationCandidates: Map<string, KnowledgeConsolidationCandidateRecord>;
  readonly consolidationReports: Map<string, KnowledgeConsolidationReportRecord>;
  readonly schedules: Map<string, KnowledgeScheduleRecord>;
}

interface KnowledgeSpaceDeleteIds {
  readonly sources: ReadonlySet<string>;
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  readonly issues: ReadonlySet<string>;
  readonly extractions: ReadonlySet<string>;
  readonly jobRuns: ReadonlySet<string>;
  readonly refinementTasks: ReadonlySet<string>;
  readonly usageRecords: ReadonlySet<string>;
  readonly consolidationCandidates: ReadonlySet<string>;
  readonly consolidationReports: ReadonlySet<string>;
  readonly schedules: ReadonlySet<string>;
}

export function planKnowledgeSpaceDeleteRows(
  stores: KnowledgeSpaceDeleteStores,
  spaceId: string,
): KnowledgeSpaceDeleteResult {
  return summarizeDeleteIds(collectKnowledgeSpaceDeleteIds(stores, spaceId));
}

export function deleteKnowledgeSpaceRows(
  sqlite: SQLiteStore,
  stores: KnowledgeSpaceDeleteStores,
  spaceId: string,
): KnowledgeSpaceDeleteResult {
  const ids = collectKnowledgeSpaceDeleteIds(stores, spaceId);

  deleteRows(sqlite, 'knowledge_usage_records', ids.usageRecords, stores.usageRecords);
  deleteRows(sqlite, 'knowledge_consolidation_candidates', ids.consolidationCandidates, stores.consolidationCandidates);
  deleteRows(sqlite, 'knowledge_consolidation_reports', ids.consolidationReports, stores.consolidationReports);
  deleteRows(sqlite, 'knowledge_refinement_tasks', ids.refinementTasks, stores.refinementTasks);
  deleteRows(sqlite, 'knowledge_job_runs', ids.jobRuns, stores.jobRuns);
  deleteRows(sqlite, 'knowledge_edges', ids.edges, stores.edges);
  deleteRows(sqlite, 'knowledge_issues', ids.issues, stores.issues);
  deleteRows(sqlite, 'knowledge_extractions', ids.extractions, stores.extractions);
  deleteRows(sqlite, 'knowledge_nodes', ids.nodes, stores.nodes);
  deleteRows(sqlite, 'knowledge_sources', ids.sources, stores.sources);
  deleteRows(sqlite, 'knowledge_schedules', ids.schedules, stores.schedules);

  return summarizeDeleteIds(ids);
}

function collectKnowledgeSpaceDeleteIds(
  stores: KnowledgeSpaceDeleteStores,
  spaceId: string,
): KnowledgeSpaceDeleteIds {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const sourceIds = matchingIds(stores.sources, (record) => getKnowledgeSpaceId(record) === normalized);
  const nodeIds = matchingIds(stores.nodes, (record) => getKnowledgeSpaceId(record) === normalized);
  const issueIds = matchingIds(stores.issues, (record) => (
    getKnowledgeSpaceId(record) === normalized
    || (record.sourceId !== undefined && sourceIds.has(record.sourceId))
    || (record.nodeId !== undefined && nodeIds.has(record.nodeId))
  ));
  const extractionIds = matchingIds(stores.extractions, (record) => (
    getKnowledgeSpaceId(record) === normalized || sourceIds.has(record.sourceId)
  ));
  const edgeIds = matchingIds(stores.edges, (record) => (
    getKnowledgeSpaceId(record) === normalized
    || (record.fromKind === 'source' && sourceIds.has(record.fromId))
    || (record.toKind === 'source' && sourceIds.has(record.toId))
    || (record.fromKind === 'node' && nodeIds.has(record.fromId))
    || (record.toKind === 'node' && nodeIds.has(record.toId))
  ));
  const refinementTaskIds = matchingIds(
    stores.refinementTasks,
    (record) => normalizeKnowledgeSpaceId(record.spaceId) === normalized,
  );
  const jobRunIds = matchingIds(stores.jobRuns, (record) => getKnowledgeSpaceId(record) === normalized);
  const usageRecordIds = matchingIds(stores.usageRecords, (record) => (
    getKnowledgeSpaceId(record) === normalized
    || (record.targetKind === 'source' && sourceIds.has(record.targetId))
    || (record.targetKind === 'node' && nodeIds.has(record.targetId))
    || (record.targetKind === 'issue' && issueIds.has(record.targetId))
  ));
  const consolidationCandidateIds = matchingIds(stores.consolidationCandidates, (record) => (
    getKnowledgeSpaceId(record) === normalized
    || (record.subjectKind === 'source' && sourceIds.has(record.subjectId))
    || (record.subjectKind === 'node' && nodeIds.has(record.subjectId))
    || (record.subjectKind === 'issue' && issueIds.has(record.subjectId))
  ));
  const consolidationReportIds = matchingIds(stores.consolidationReports, (record) => getKnowledgeSpaceId(record) === normalized);
  const scheduleIds = matchingIds(stores.schedules, (record) => getKnowledgeSpaceId(record) === normalized);

  return {
    sources: sourceIds,
    nodes: nodeIds,
    edges: edgeIds,
    issues: issueIds,
    extractions: extractionIds,
    jobRuns: jobRunIds,
    refinementTasks: refinementTaskIds,
    usageRecords: usageRecordIds,
    consolidationCandidates: consolidationCandidateIds,
    consolidationReports: consolidationReportIds,
    schedules: scheduleIds,
  };
}

function summarizeDeleteIds(ids: KnowledgeSpaceDeleteIds): KnowledgeSpaceDeleteResult {
  return {
    sources: ids.sources.size,
    nodes: ids.nodes.size,
    edges: ids.edges.size,
    issues: ids.issues.size,
    extractions: ids.extractions.size,
    jobRuns: ids.jobRuns.size,
    refinementTasks: ids.refinementTasks.size,
    usageRecords: ids.usageRecords.size,
    consolidationCandidates: ids.consolidationCandidates.size,
    consolidationReports: ids.consolidationReports.size,
    schedules: ids.schedules.size,
  };
}

function matchingIds<T>(
  records: ReadonlyMap<string, T>,
  predicate: (record: T) => boolean,
): Set<string> {
  const ids = new Set<string>();
  for (const [id, record] of records) {
    if (predicate(record)) ids.add(id);
  }
  return ids;
}

function deleteRows<T>(
  sqlite: SQLiteStore,
  table: string,
  ids: ReadonlySet<string>,
  records: Map<string, T>,
): void {
  for (const id of ids) {
    sqlite.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    records.delete(id);
  }
}
