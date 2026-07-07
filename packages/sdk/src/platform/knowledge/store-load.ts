import type { SQLiteStore } from '../state/sqlite-store.js';
import {
  mapCandidateRow,
  mapEdgeRow,
  mapExtractionRow,
  mapIssueRow,
  mapJobRunRow,
  mapNodeRevisionRow,
  mapNodeRow,
  mapRefinementTaskRow,
  mapReportRow,
  mapScheduleRow,
  mapSemanticEnrichmentStateRow,
  mapSourceRow,
  mapUsageRow,
} from './store-schema.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobRunRecord,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeScheduleRecord,
  KnowledgeSemanticEnrichmentStateRecord,
  KnowledgeSourceRecord,
  KnowledgeUsageRecord,
} from './types.js';

export interface KnowledgeStoreSnapshot {
  readonly sources: KnowledgeSourceRecord[];
  readonly nodes: KnowledgeNodeRecord[];
  readonly edges: KnowledgeEdgeRecord[];
  readonly issues: KnowledgeIssueRecord[];
  readonly extractions: KnowledgeExtractionRecord[];
  readonly jobRuns: KnowledgeJobRunRecord[];
  readonly refinementTasks: KnowledgeRefinementTaskRecord[];
  readonly usageRecords: KnowledgeUsageRecord[];
  readonly consolidationCandidates: KnowledgeConsolidationCandidateRecord[];
  readonly consolidationReports: KnowledgeConsolidationReportRecord[];
  readonly schedules: KnowledgeScheduleRecord[];
  readonly nodeRevisions: KnowledgeNodeRevisionRecord[];
  readonly semanticEnrichmentStates: KnowledgeSemanticEnrichmentStateRecord[];
}

function loadRows<T>(sqlite: SQLiteStore, sql: string, mapRow: (columns: string[], values: unknown[]) => T): T[] {
  const rows = sqlite.exec(sql);
  if (!rows.length) return [];
  return (rows[0]?.values ?? []).map((row) => mapRow(rows[0]?.columns ?? [], row));
}

export function loadKnowledgeStoreSnapshot(sqlite: SQLiteStore): KnowledgeStoreSnapshot {
  return {
    sources: loadRows(sqlite, 'SELECT * FROM knowledge_sources', mapSourceRow),
    nodes: loadRows(sqlite, 'SELECT * FROM knowledge_nodes', mapNodeRow),
    edges: loadRows(sqlite, 'SELECT * FROM knowledge_edges', mapEdgeRow),
    issues: loadRows(sqlite, 'SELECT * FROM knowledge_issues', mapIssueRow),
    extractions: loadRows(sqlite, 'SELECT * FROM knowledge_extractions', mapExtractionRow),
    jobRuns: loadRows(sqlite, 'SELECT * FROM knowledge_job_runs', mapJobRunRow),
    refinementTasks: loadRows(sqlite, 'SELECT * FROM knowledge_refinement_tasks', mapRefinementTaskRow),
    usageRecords: loadRows(sqlite, 'SELECT * FROM knowledge_usage_records', mapUsageRow),
    consolidationCandidates: loadRows(sqlite, 'SELECT * FROM knowledge_consolidation_candidates', mapCandidateRow),
    consolidationReports: loadRows(sqlite, 'SELECT * FROM knowledge_consolidation_reports', mapReportRow),
    schedules: loadRows(sqlite, 'SELECT * FROM knowledge_schedules', mapScheduleRow),
    nodeRevisions: loadRows(sqlite, 'SELECT * FROM knowledge_node_revisions ORDER BY node_id, revision', mapNodeRevisionRow),
    semanticEnrichmentStates: loadRows(sqlite, 'SELECT * FROM knowledge_semantic_enrichment_state', mapSemanticEnrichmentStateRow),
  };
}
