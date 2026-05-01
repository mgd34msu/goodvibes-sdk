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

export function deleteKnowledgeSpaceRows(
  sqlite: SQLiteStore,
  stores: KnowledgeSpaceDeleteStores,
  spaceId: string,
): KnowledgeSpaceDeleteResult {
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

  deleteRows(sqlite, 'knowledge_usage_records', usageRecordIds, stores.usageRecords);
  deleteRows(sqlite, 'knowledge_consolidation_candidates', consolidationCandidateIds, stores.consolidationCandidates);
  deleteRows(sqlite, 'knowledge_consolidation_reports', consolidationReportIds, stores.consolidationReports);
  deleteRows(sqlite, 'knowledge_refinement_tasks', refinementTaskIds, stores.refinementTasks);
  deleteRows(sqlite, 'knowledge_job_runs', jobRunIds, stores.jobRuns);
  deleteRows(sqlite, 'knowledge_edges', edgeIds, stores.edges);
  deleteRows(sqlite, 'knowledge_issues', issueIds, stores.issues);
  deleteRows(sqlite, 'knowledge_extractions', extractionIds, stores.extractions);
  deleteRows(sqlite, 'knowledge_nodes', nodeIds, stores.nodes);
  deleteRows(sqlite, 'knowledge_sources', sourceIds, stores.sources);
  deleteRows(sqlite, 'knowledge_schedules', scheduleIds, stores.schedules);

  return {
    sources: sourceIds.size,
    nodes: nodeIds.size,
    edges: edgeIds.size,
    issues: issueIds.size,
    extractions: extractionIds.size,
    jobRuns: jobRunIds.size,
    refinementTasks: refinementTaskIds.size,
    usageRecords: usageRecordIds.size,
    consolidationCandidates: consolidationCandidateIds.size,
    consolidationReports: consolidationReportIds.size,
    schedules: scheduleIds.size,
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
