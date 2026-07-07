import type { SQLiteStore } from '../state/sqlite-store.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeSemanticEnrichmentStateRecord,
  KnowledgeSourceRecord,
  KnowledgeUsageRecord,
} from './types.js';

/**
 * The store internals needed to cascade a single-record hard delete. Both node and
 * source deletes cascade edges, issues, usage records, consolidation candidates and
 * refinement tasks (Defect 7 closed the refinement-task gap); node delete also
 * purges revision history and source delete purges derived extraction/enrichment
 * rows. Honest hard delete — no soft-hide. (Defect 6.)
 */
export interface KnowledgeRecordDeleteView {
  readonly sqlite: SQLiteStore;
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly usageRecords: Map<string, KnowledgeUsageRecord>;
  readonly consolidationCandidates: Map<string, KnowledgeConsolidationCandidateRecord>;
  readonly refinementTasks: Map<string, KnowledgeRefinementTaskRecord>;
  readonly nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
  readonly semanticEnrichmentStates: Map<string, KnowledgeSemanticEnrichmentStateRecord>;
}

export function deleteKnowledgeNodeRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.nodes.has(id)) return false;
  for (const [edgeId, edge] of [...view.edges.entries()]) {
    if ((edge.fromKind === 'node' && edge.fromId === id) || (edge.toKind === 'node' && edge.toId === id)) {
      view.sqlite.run('DELETE FROM knowledge_edges WHERE id = ?', [edgeId]);
      view.edges.delete(edgeId);
    }
  }
  for (const [issueId, issue] of [...view.issues.entries()]) {
    if (issue.nodeId === id) {
      view.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issueId]);
      view.issues.delete(issueId);
    }
  }
  for (const [usageId, usage] of [...view.usageRecords.entries()]) {
    if (usage.targetKind === 'node' && usage.targetId === id) {
      view.sqlite.run('DELETE FROM knowledge_usage_records WHERE id = ?', [usageId]);
      view.usageRecords.delete(usageId);
    }
  }
  for (const [candidateId, candidate] of [...view.consolidationCandidates.entries()]) {
    if (candidate.subjectKind === 'node' && candidate.subjectId === id) {
      view.sqlite.run('DELETE FROM knowledge_consolidation_candidates WHERE id = ?', [candidateId]);
      view.consolidationCandidates.delete(candidateId);
    }
  }
  for (const [taskId, task] of [...view.refinementTasks.entries()]) {
    if ((task.subjectKind === 'node' && task.subjectId === id) || task.gapId === id) {
      view.sqlite.run('DELETE FROM knowledge_refinement_tasks WHERE id = ?', [taskId]);
      view.refinementTasks.delete(taskId);
    }
  }
  view.sqlite.run('DELETE FROM knowledge_node_revisions WHERE node_id = ?', [id]);
  view.nodeRevisions.delete(id);
  view.sqlite.run('DELETE FROM knowledge_nodes WHERE id = ?', [id]);
  view.nodes.delete(id);
  return true;
}

export function deleteKnowledgeSourceRecord(view: KnowledgeRecordDeleteView, id: string): boolean {
  if (!view.sources.has(id)) return false;
  for (const [edgeId, edge] of [...view.edges.entries()]) {
    if ((edge.fromKind === 'source' && edge.fromId === id) || (edge.toKind === 'source' && edge.toId === id)) {
      view.sqlite.run('DELETE FROM knowledge_edges WHERE id = ?', [edgeId]);
      view.edges.delete(edgeId);
    }
  }
  for (const [extractionId, extraction] of [...view.extractions.entries()]) {
    if (extraction.sourceId === id) {
      view.sqlite.run('DELETE FROM knowledge_extractions WHERE id = ?', [extractionId]);
      view.extractions.delete(extractionId);
    }
  }
  for (const [issueId, issue] of [...view.issues.entries()]) {
    if (issue.sourceId === id) {
      view.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issueId]);
      view.issues.delete(issueId);
    }
  }
  for (const [usageId, usage] of [...view.usageRecords.entries()]) {
    if (usage.targetKind === 'source' && usage.targetId === id) {
      view.sqlite.run('DELETE FROM knowledge_usage_records WHERE id = ?', [usageId]);
      view.usageRecords.delete(usageId);
    }
  }
  for (const [candidateId, candidate] of [...view.consolidationCandidates.entries()]) {
    if (candidate.subjectKind === 'source' && candidate.subjectId === id) {
      view.sqlite.run('DELETE FROM knowledge_consolidation_candidates WHERE id = ?', [candidateId]);
      view.consolidationCandidates.delete(candidateId);
    }
  }
  for (const [taskId, task] of [...view.refinementTasks.entries()]) {
    if (task.subjectKind === 'source' && task.subjectId === id) {
      view.sqlite.run('DELETE FROM knowledge_refinement_tasks WHERE id = ?', [taskId]);
      view.refinementTasks.delete(taskId);
    }
  }
  view.sqlite.run('DELETE FROM knowledge_semantic_enrichment_state WHERE source_id = ?', [id]);
  view.semanticEnrichmentStates.delete(id);
  view.sqlite.run('DELETE FROM knowledge_sources WHERE id = ?', [id]);
  view.sources.delete(id);
  return true;
}
