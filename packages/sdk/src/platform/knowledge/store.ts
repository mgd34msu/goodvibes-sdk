import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../state/sqlite-store.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationCandidateUpsertInput,
  KnowledgeConsolidationReportRecord,
  KnowledgeConsolidationReportUpsertInput,
  KnowledgeEdgeRecord,
  KnowledgeEdgeUpsertInput,
  KnowledgeExtractionRecord,
  KnowledgeExtractionUpsertInput,
  KnowledgeIssueRecord,
  KnowledgeIssueUpsertInput,
  KnowledgeItemView,
  KnowledgeJobRunRecord,
  KnowledgeJobRunUpsertInput,
  KnowledgeRefinementTaskFilter,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeScheduleRecord,
  KnowledgeScheduleUpsertInput,
  KnowledgeSourceRecord,
  KnowledgeSourceUpsertInput,
  KnowledgeStatus,
  KnowledgeUsageRecord,
  KnowledgeUsageUpsertInput,
} from './types.js';
import {
  createSchema, issueStatusForUpsert,
  nowMs,
  stableText,
  uniq,
} from './store-schema.js';
import { resolveKnowledgeDbPath, type KnowledgeStoreConfig } from './store-config.js';
import { upsertKnowledgeRefinementTask } from './store-refinement.js';
import {
  deleteKnowledgeSpaceRows,
  planKnowledgeSpaceDeleteRows,
  type KnowledgeSpaceDeleteResult,
} from './store-space-delete.js';
import {
  deleteKnowledgeSchedule,
  upsertKnowledgeSchedule,
} from './store-schedules.js';
import {
  edgesForKnowledgeStore,
  getKnowledgeConsolidationCandidate,
  getKnowledgeConsolidationCandidateBySubject,
  getKnowledgeConsolidationReport,
  getKnowledgeExtraction,
  getKnowledgeExtractionBySourceId,
  getKnowledgeIssue,
  getKnowledgeItem,
  getKnowledgeJobRun,
  getKnowledgeRefinementTask,
  getKnowledgeNode,
  getKnowledgeNodeByKindAndSlug,
  getKnowledgeSchedule,
  getKnowledgeSource,
  getKnowledgeSourceByCanonicalUri,
  getKnowledgeStoreStatus,
  getKnowledgeUsageRecord,
  listKnowledgeConsolidationCandidates,
  listKnowledgeConsolidationReports,
  listKnowledgeEdges,
  listKnowledgeExtractions,
  listKnowledgeExtractionsForSources,
  listKnowledgeExtractionsInSpace,
  listKnowledgeIssues,
  listKnowledgeIssuesInSpace,
  listKnowledgeJobRuns,
  listKnowledgeRefinementTasks,
  listKnowledgeNodes,
  listKnowledgeNodesInSpace,
  listKnowledgeSchedules,
  listKnowledgeSources,
  listKnowledgeSourcesInSpace,
  listKnowledgeUsageRecords,
  type KnowledgeStoreReadView,
} from './store-read.js';
import { loadKnowledgeStoreSnapshot } from './store-load.js';

export class KnowledgeStore {
  private readonly sqlite: SQLiteStore;
  private readonly dbPath: string;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly sources = new Map<string, KnowledgeSourceRecord>();
  private readonly nodes = new Map<string, KnowledgeNodeRecord>();
  private readonly edges = new Map<string, KnowledgeEdgeRecord>();
  private readonly issues = new Map<string, KnowledgeIssueRecord>();
  private readonly extractions = new Map<string, KnowledgeExtractionRecord>();
  private readonly jobRuns = new Map<string, KnowledgeJobRunRecord>();
  private readonly refinementTasks = new Map<string, KnowledgeRefinementTaskRecord>();
  private readonly usageRecords = new Map<string, KnowledgeUsageRecord>();
  private readonly consolidationCandidates = new Map<string, KnowledgeConsolidationCandidateRecord>();
  private readonly consolidationReports = new Map<string, KnowledgeConsolidationReportRecord>();
  private readonly schedules = new Map<string, KnowledgeScheduleRecord>();

  constructor(config: KnowledgeStoreConfig) {
    this.dbPath = resolveKnowledgeDbPath(config);
    this.sqlite = new SQLiteStore(this.dbPath);
    void this.init().catch((error: unknown) => {
      logger.error('[knowledge-store] initialization failed', {
        path: this.dbPath,
        error: summarizeError(error),
      });
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  get storagePath(): string {
    return this.dbPath;
  }

  private asReadView(): KnowledgeStoreReadView {
    return this as unknown as KnowledgeStoreReadView;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  status(): KnowledgeStatus {
    return getKnowledgeStoreStatus(this.asReadView());
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> { await this.init(); return this.sqlite.batch(operation); }
  listSources(limit = 100): KnowledgeSourceRecord[] {
    return listKnowledgeSources(this.asReadView(), limit);
  }

  listSourcesInSpace(spaceId: string): KnowledgeSourceRecord[] {
    return listKnowledgeSourcesInSpace(this.asReadView(), spaceId);
  }

  listNodes(limit = 100): KnowledgeNodeRecord[] {
    return listKnowledgeNodes(this.asReadView(), limit);
  }

  listNodesInSpace(spaceId: string): KnowledgeNodeRecord[] {
    return listKnowledgeNodesInSpace(this.asReadView(), spaceId);
  }

  listEdges(): KnowledgeEdgeRecord[] {
    return listKnowledgeEdges(this.asReadView());
  }

  listIssues(limit = 100): KnowledgeIssueRecord[] {
    return listKnowledgeIssues(this.asReadView(), limit);
  }

  listIssuesInSpace(spaceId: string): KnowledgeIssueRecord[] {
    return listKnowledgeIssuesInSpace(this.asReadView(), spaceId);
  }

  listExtractions(limit = 100): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractions(this.asReadView(), limit);
  }

  listExtractionsInSpace(spaceId: string): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractionsInSpace(this.asReadView(), spaceId);
  }

  listExtractionsForSources(sourceIds: ReadonlySet<string>): KnowledgeExtractionRecord[] {
    return listKnowledgeExtractionsForSources(this.asReadView(), sourceIds);
  }

  listJobRuns(limit = 100, jobId?: string): KnowledgeJobRunRecord[] {
    return listKnowledgeJobRuns(this.asReadView(), limit, jobId);
  }

  listRefinementTasks(limit = 100, input: KnowledgeRefinementTaskFilter = {}): KnowledgeRefinementTaskRecord[] {
    return listKnowledgeRefinementTasks(this.asReadView(), limit, input);
  }

  listUsageRecords(limit = 100, input: {
    readonly targetKind?: KnowledgeUsageRecord['targetKind'];
    readonly targetId?: string;
    readonly usageKind?: KnowledgeUsageRecord['usageKind'];
  } = {}): KnowledgeUsageRecord[] {
    return listKnowledgeUsageRecords(this.asReadView(), limit, input);
  }

  listConsolidationCandidates(limit = 100, input: {
    readonly status?: KnowledgeConsolidationCandidateRecord['status'];
    readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'];
    readonly subjectId?: string;
  } = {}): KnowledgeConsolidationCandidateRecord[] {
    return listKnowledgeConsolidationCandidates(this.asReadView(), limit, input);
  }

  listConsolidationReports(limit = 100): KnowledgeConsolidationReportRecord[] {
    return listKnowledgeConsolidationReports(this.asReadView(), limit);
  }

  listSchedules(limit = 100): KnowledgeScheduleRecord[] {
    return listKnowledgeSchedules(this.asReadView(), limit);
  }

  getSource(id: string): KnowledgeSourceRecord | null {
    return getKnowledgeSource(this.asReadView(), id);
  }

  getNode(id: string): KnowledgeNodeRecord | null {
    return getKnowledgeNode(this.asReadView(), id);
  }

  getIssue(id: string): KnowledgeIssueRecord | null {
    return getKnowledgeIssue(this.asReadView(), id);
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return getKnowledgeExtraction(this.asReadView(), id);
  }

  getExtractionBySourceId(sourceId: string): KnowledgeExtractionRecord | null {
    return getKnowledgeExtractionBySourceId(this.asReadView(), sourceId);
  }

  getJobRun(id: string): KnowledgeJobRunRecord | null {
    return getKnowledgeJobRun(this.asReadView(), id);
  }

  getRefinementTask(id: string): KnowledgeRefinementTaskRecord | null {
    return getKnowledgeRefinementTask(this.asReadView(), id);
  }

  getUsageRecord(id: string): KnowledgeUsageRecord | null {
    return getKnowledgeUsageRecord(this.asReadView(), id);
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return getKnowledgeConsolidationCandidate(this.asReadView(), id);
  }

  getConsolidationCandidateBySubject(
    subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
    subjectId: string,
    candidateType: KnowledgeConsolidationCandidateRecord['candidateType'],
  ): KnowledgeConsolidationCandidateRecord | null {
    return getKnowledgeConsolidationCandidateBySubject(this.asReadView(), subjectKind, subjectId, candidateType);
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return getKnowledgeConsolidationReport(this.asReadView(), id);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return getKnowledgeSchedule(this.asReadView(), id);
  }

  getSourceByCanonicalUri(canonicalUri: string): KnowledgeSourceRecord | null {
    return getKnowledgeSourceByCanonicalUri(this.asReadView(), canonicalUri);
  }

  getNodeByKindAndSlug(kind: KnowledgeNodeRecord['kind'], slug: string): KnowledgeNodeRecord | null {
    return getKnowledgeNodeByKindAndSlug(this.asReadView(), kind, slug);
  }

  edgesFor(kind: KnowledgeEdgeRecord['fromKind'] | KnowledgeEdgeRecord['toKind'], id: string): KnowledgeEdgeRecord[] {
    return edgesForKnowledgeStore(this.asReadView(), kind, id);
  }

  getItem(id: string): KnowledgeItemView | null {
    return getKnowledgeItem(this.asReadView(), id);
  }

  async upsertSource(input: KnowledgeSourceUpsertInput): Promise<KnowledgeSourceRecord> {
    await this.init();
    const existing = input.id
      ? this.sources.get(input.id)
      : input.canonicalUri
        ? this.getSourceByCanonicalUri(input.canonicalUri)
        : null;
    const now = nowMs();
    function opt<K extends string, V>(key: K, newVal: V | null, existingVal?: V): { [P in K]?: V } {
      if (newVal !== null) return { [key]: newVal } as { [P in K]?: V };
      if (existingVal !== undefined) return { [key]: existingVal } as { [P in K]?: V };
      return {} as { [P in K]?: V };
    }
    const _title = stableText(input.title);
    const _sourceUri = stableText(input.sourceUri);
    const _canonicalUri = stableText(input.canonicalUri);
    const _summary = stableText(input.summary);
    const _description = stableText(input.description);
    const _folderPath = stableText(input.folderPath);
    const _artifactId = stableText(input.artifactId);
    const _contentHash = stableText(input.contentHash);
    const _crawlError = stableText(input.crawlError);
    const _sessionId = stableText(input.sessionId);
    const record: KnowledgeSourceRecord = {
      id: existing?.id ?? input.id ?? `source-${randomUUID().slice(0, 8)}`,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      ...opt('title', _title),
      ...opt('sourceUri', _sourceUri),
      ...opt('canonicalUri', _canonicalUri),
      ...opt('summary', _summary),
      ...opt('description', _description),
      tags: uniq(input.tags ?? existing?.tags),
      ...opt('folderPath', _folderPath, existing?.folderPath),
      status: input.status,
      ...opt('artifactId', _artifactId, existing?.artifactId),
      ...opt('contentHash', _contentHash, existing?.contentHash),
      ...(typeof input.lastCrawledAt === 'number' ? { lastCrawledAt: input.lastCrawledAt } : existing?.lastCrawledAt ? { lastCrawledAt: existing.lastCrawledAt } : {}),
      ...opt('crawlError', _crawlError, existing?.crawlError && input.status !== 'indexed' ? existing.crawlError : undefined),
      ...opt('sessionId', _sessionId, existing?.sessionId),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_sources (
        id, connector_id, source_type, title, source_uri, canonical_uri, summary, description,
        tags, folder_path, status, artifact_id, content_hash, last_crawled_at, crawl_error,
        session_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.connectorId,
      record.sourceType,
      record.title ?? null,
      record.sourceUri ?? null,
      record.canonicalUri ?? null,
      record.summary ?? null,
      record.description ?? null,
      JSON.stringify([...record.tags]),
      record.folderPath ?? null,
      record.status,
      record.artifactId ?? null,
      record.contentHash ?? null,
      record.lastCrawledAt ?? null,
      record.crawlError ?? null,
      record.sessionId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.sources.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertNode(input: KnowledgeNodeUpsertInput): Promise<KnowledgeNodeRecord> {
    await this.init();
    const existing = input.id
      ? this.nodes.get(input.id)
      : this.getNodeByKindAndSlug(input.kind, input.slug);
    const now = nowMs();
    const _summary = stableText(input.summary);
    const _sourceId = stableText(input.sourceId);
    const record: KnowledgeNodeRecord = {
      id: existing?.id ?? input.id ?? `node-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      slug: input.slug,
      title: input.title.trim(),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      aliases: uniq(input.aliases ?? existing?.aliases),
      status: input.status ?? existing?.status ?? 'active',
      confidence: Math.max(0, Math.min(100, input.confidence ?? existing?.confidence ?? 70)),
      ...(_sourceId !== null ? { sourceId: _sourceId } : existing?.sourceId ? { sourceId: existing.sourceId } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_nodes (
        id, kind, slug, title, summary, aliases, status, confidence, source_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.kind,
      record.slug,
      record.title,
      record.summary ?? null,
      JSON.stringify([...record.aliases]),
      record.status,
      record.confidence,
      record.sourceId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.nodes.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertEdge(input: KnowledgeEdgeUpsertInput): Promise<KnowledgeEdgeRecord> {
    await this.init();
    const existing = [...this.edges.values()].find((edge) => (
      edge.fromKind === input.fromKind
      && edge.fromId === input.fromId
      && edge.toKind === input.toKind
      && edge.toId === input.toId
      && edge.relation === input.relation
    ));
    const now = nowMs();
    const record: KnowledgeEdgeRecord = {
      id: existing?.id ?? `edge-${randomUUID().slice(0, 8)}`,
      fromKind: input.fromKind,
      fromId: input.fromId,
      toKind: input.toKind,
      toId: input.toId,
      relation: input.relation,
      weight: Number.isFinite(input.weight) ? Number(input.weight) : existing?.weight ?? 1,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_edges (
        id, from_kind, from_id, to_kind, to_id, relation, weight, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.fromKind,
      record.fromId,
      record.toKind,
      record.toId,
      record.relation,
      record.weight,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.edges.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async replaceIssues(inputs: readonly KnowledgeIssueUpsertInput[], namespace?: string): Promise<KnowledgeIssueRecord[]> {
    await this.init();
    const created: KnowledgeIssueRecord[] = [];
    const activeIds = new Set<string>();
    for (const input of inputs) {
      const record = await this.upsertIssue(input);
      activeIds.add(record.id);
      created.push(record);
    }
    if (namespace) {
      for (const issue of [...this.issues.values()]) {
        if (issue.metadata.namespace !== namespace) continue;
        if (activeIds.has(issue.id) || issue.status === 'resolved') continue;
        this.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issue.id]);
        this.issues.delete(issue.id);
      }
    }
    await this.sqlite.save();
    return created;
  }

  async upsertIssue(input: KnowledgeIssueUpsertInput): Promise<KnowledgeIssueRecord> {
    await this.init();
    const existing = input.id ? this.issues.get(input.id) : null;
    const now = nowMs();
    const _sourceId = stableText(input.sourceId);
    const _nodeId = stableText(input.nodeId);
    const record: KnowledgeIssueRecord = {
      id: existing?.id ?? input.id ?? `issue-${randomUUID().slice(0, 8)}`,
      severity: input.severity,
      code: input.code,
      message: input.message.trim(),
      status: input.status ?? issueStatusForUpsert(existing, input),
      ...(_sourceId !== null ? { sourceId: _sourceId } : {}),
      ...(_nodeId !== null ? { nodeId: _nodeId } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_issues (
        id, severity, code, message, status, source_id, node_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.severity,
      record.code,
      record.message,
      record.status,
      record.sourceId ?? null,
      record.nodeId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.issues.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertExtraction(input: KnowledgeExtractionUpsertInput): Promise<KnowledgeExtractionRecord> {
    await this.init();
    const existing = input.id
      ? this.extractions.get(input.id)
      : this.getExtractionBySourceId(input.sourceId);
    const now = nowMs();
    const _artifactId = stableText(input.artifactId);
    const _title = stableText(input.title);
    const _summary = stableText(input.summary);
    const _excerpt = stableText(input.excerpt);
    const record: KnowledgeExtractionRecord = {
      id: existing?.id ?? input.id ?? `extract-${randomUUID().slice(0, 8)}`,
      sourceId: input.sourceId,
      ...(_artifactId !== null ? { artifactId: _artifactId } : existing?.artifactId ? { artifactId: existing.artifactId } : {}),
      extractorId: input.extractorId,
      format: input.format,
      ...(_title !== null ? { title: _title } : existing?.title ? { title: existing.title } : {}),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      ...(_excerpt !== null ? { excerpt: _excerpt } : existing?.excerpt ? { excerpt: existing.excerpt } : {}),
      sections: uniq(input.sections ?? existing?.sections),
      links: uniq(input.links ?? existing?.links),
      estimatedTokens: Math.max(0, Number(input.estimatedTokens ?? existing?.estimatedTokens ?? 0)),
      structure: {
        ...(existing?.structure ?? {}),
        ...(input.structure ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_extractions (
        id, source_id, artifact_id, extractor_id, format, title, summary, excerpt,
        sections, links, estimated_tokens, structure, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.sourceId,
      record.artifactId ?? null,
      record.extractorId,
      record.format,
      record.title ?? null,
      record.summary ?? null,
      record.excerpt ?? null,
      JSON.stringify([...record.sections]),
      JSON.stringify([...record.links]),
      record.estimatedTokens,
      JSON.stringify(record.structure),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.extractions.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertJobRun(input: KnowledgeJobRunUpsertInput): Promise<KnowledgeJobRunRecord> {
    await this.init();
    const existing = input.id ? this.jobRuns.get(input.id) : null;
    const now = nowMs();
    const _error = stableText(input.error);
    const record: KnowledgeJobRunRecord = {
      id: existing?.id ?? input.id ?? `kjr-${randomUUID().slice(0, 8)}`,
      jobId: input.jobId,
      status: input.status,
      mode: input.mode,
      requestedAt: input.requestedAt ?? existing?.requestedAt ?? now,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(typeof input.completedAt === 'number' ? { completedAt: input.completedAt } : existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(_error !== null ? { error: _error } : existing?.error ? { error: existing.error } : {}),
      result: {
        ...(existing?.result ?? {}),
        ...(input.result ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_job_runs (
        id, job_id, status, mode, requested_at, started_at, completed_at, error, result, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.jobId,
      record.status,
      record.mode,
      record.requestedAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.error ?? null,
      JSON.stringify(record.result),
      JSON.stringify(record.metadata),
      existing ? now : now,
      now,
    ]);
    this.jobRuns.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertRefinementTask(input: KnowledgeRefinementTaskUpsertInput): Promise<KnowledgeRefinementTaskRecord> {
    await this.init();
    return upsertKnowledgeRefinementTask(this.sqlite, this.refinementTasks, input, () => `kref-${randomUUID().slice(0, 8)}`);
  }

  async upsertUsageRecord(input: KnowledgeUsageUpsertInput): Promise<KnowledgeUsageRecord> {
    await this.init();
    const _task = stableText(input.task);
    const _sessionId = stableText(input.sessionId);
    const record: KnowledgeUsageRecord = {
      id: input.id ?? `kuse-${randomUUID().slice(0, 8)}`,
      targetKind: input.targetKind,
      targetId: input.targetId,
      usageKind: input.usageKind,
      ...(_task !== null ? { task: _task } : {}),
      ...(_sessionId !== null ? { sessionId: _sessionId } : {}),
      ...(typeof input.score === 'number' && Number.isFinite(input.score) ? { score: Number(input.score) } : {}),
      metadata: { ...(input.metadata ?? {}) },
      createdAt: nowMs(),
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_usage_records (
        id, target_kind, target_id, usage_kind, task, session_id, score, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.targetKind,
      record.targetId,
      record.usageKind,
      record.task ?? null,
      record.sessionId ?? null,
      record.score ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
    ]);
    this.usageRecords.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertConsolidationCandidate(
    input: KnowledgeConsolidationCandidateUpsertInput,
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    await this.init();
    const existing = input.id
      ? this.consolidationCandidates.get(input.id)
      : this.getConsolidationCandidateBySubject(input.subjectKind, input.subjectId, input.candidateType);
    const now = nowMs();
    const _summary = stableText(input.summary);
    const _suggestedMemoryClass = stableText(input.suggestedMemoryClass);
    const _suggestedScope = stableText(input.suggestedScope);
    const _decidedBy = stableText(input.decidedBy);
    const record: KnowledgeConsolidationCandidateRecord = {
      id: existing?.id ?? input.id ?? `kcand-${randomUUID().slice(0, 8)}`,
      candidateType: input.candidateType,
      status: input.status ?? existing?.status ?? 'open',
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      title: input.title.trim(),
      ...(_summary !== null ? { summary: _summary } : existing?.summary ? { summary: existing.summary } : {}),
      score: Number(input.score),
      evidence: uniq(input.evidence ?? existing?.evidence),
      ...(_suggestedMemoryClass !== null ? { suggestedMemoryClass: _suggestedMemoryClass } : existing?.suggestedMemoryClass ? { suggestedMemoryClass: existing.suggestedMemoryClass } : {}),
      ...(_suggestedScope !== null ? { suggestedScope: _suggestedScope } : existing?.suggestedScope ? { suggestedScope: existing.suggestedScope } : {}),
      ...(typeof input.decidedAt === 'number' ? { decidedAt: input.decidedAt } : existing?.decidedAt ? { decidedAt: existing.decidedAt } : {}),
      ...(_decidedBy !== null ? { decidedBy: _decidedBy } : existing?.decidedBy ? { decidedBy: existing.decidedBy } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_candidates (
        id, candidate_type, status, subject_kind, subject_id, title, summary, score,
        evidence, suggested_memory_class, suggested_scope, decided_at, decided_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.candidateType,
      record.status,
      record.subjectKind,
      record.subjectId,
      record.title,
      record.summary ?? null,
      record.score,
      JSON.stringify([...record.evidence]),
      record.suggestedMemoryClass ?? null,
      record.suggestedScope ?? null,
      record.decidedAt ?? null,
      record.decidedBy ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationCandidates.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertConsolidationReport(
    input: KnowledgeConsolidationReportUpsertInput,
  ): Promise<KnowledgeConsolidationReportRecord> {
    await this.init();
    const existing = input.id ? this.consolidationReports.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeConsolidationReportRecord = {
      id: existing?.id ?? input.id ?? `krep-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      title: input.title.trim(),
      summary: input.summary.trim(),
      highlights: uniq(input.highlights ?? existing?.highlights),
      metrics: {
        ...(existing?.metrics ?? {}),
        ...(input.metrics ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_reports (
        id, kind, title, summary, highlights, metrics, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.kind,
      record.title,
      record.summary,
      JSON.stringify([...record.highlights]),
      JSON.stringify(record.metrics),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationReports.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertSchedule(input: KnowledgeScheduleUpsertInput): Promise<KnowledgeScheduleRecord> {
    await this.init();
    return upsertKnowledgeSchedule(this.sqlite, this.schedules, input, () => `ksched-${randomUUID().slice(0, 8)}`);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    await this.init();
    return deleteKnowledgeSchedule(this.sqlite, this.schedules, id);
  }

  async planKnowledgeSpaceDelete(spaceId: string): Promise<KnowledgeSpaceDeleteResult> {
    await this.init();
    return planKnowledgeSpaceDeleteRows(this.knowledgeSpaceRowStores(), spaceId);
  }

  async deleteKnowledgeSpace(spaceId: string, input: { readonly dryRun?: boolean } = {}): Promise<KnowledgeSpaceDeleteResult> {
    await this.init();
    if (input.dryRun) return this.planKnowledgeSpaceDelete(spaceId);
    const deleted = deleteKnowledgeSpaceRows(this.sqlite, this.knowledgeSpaceRowStores(), spaceId);
    await this.sqlite.save();
    return deleted;
  }

  private knowledgeSpaceRowStores(): Parameters<typeof planKnowledgeSpaceDeleteRows>[0] {
    return {
      sources: this.sources,
      nodes: this.nodes,
      edges: this.edges,
      issues: this.issues,
      extractions: this.extractions,
      jobRuns: this.jobRuns,
      refinementTasks: this.refinementTasks,
      usageRecords: this.usageRecords,
      consolidationCandidates: this.consolidationCandidates,
      consolidationReports: this.consolidationReports,
      schedules: this.schedules,
    };
  }

  private async initialize(): Promise<void> {
    await this.sqlite.init(createSchema);
    const snapshot = loadKnowledgeStoreSnapshot(this.sqlite);
    this.sources.clear();
    for (const record of snapshot.sources) this.sources.set(record.id, record);
    this.nodes.clear();
    for (const record of snapshot.nodes) this.nodes.set(record.id, record);
    this.edges.clear();
    for (const record of snapshot.edges) this.edges.set(record.id, record);
    this.issues.clear();
    for (const record of snapshot.issues) this.issues.set(record.id, record);
    this.extractions.clear();
    for (const record of snapshot.extractions) this.extractions.set(record.id, record);
    this.jobRuns.clear();
    for (const record of snapshot.jobRuns) this.jobRuns.set(record.id, record);
    this.refinementTasks.clear();
    for (const record of snapshot.refinementTasks) this.refinementTasks.set(record.id, record);
    this.usageRecords.clear();
    for (const record of snapshot.usageRecords) this.usageRecords.set(record.id, record);
    this.consolidationCandidates.clear();
    for (const record of snapshot.consolidationCandidates) this.consolidationCandidates.set(record.id, record);
    this.consolidationReports.clear();
    for (const record of snapshot.consolidationReports) this.consolidationReports.set(record.id, record);
    this.schedules.clear();
    for (const record of snapshot.schedules) this.schedules.set(record.id, record);
    this.ready = true;
  }
}
