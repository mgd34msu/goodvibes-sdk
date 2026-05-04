import { randomUUID } from 'node:crypto';
import {
  type AutomationScheduleDefinition,
} from '../automation/schedules.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { ArtifactStore } from '../artifacts/index.js';
import type { MemoryRegistry } from '../state/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { createDefaultKnowledgeConnectorRegistry, KnowledgeConnectorRegistry } from './connectors.js';
import { renderKnowledgeMap, type KnowledgeMapRenderOptions } from './map.js';
import { KnowledgeProjectionService } from './projections.js';
import { KnowledgeSemanticService } from './semantic/index.js';
import { KnowledgeStore } from './store.js';
import { ingestBrowserKnowledge } from './browser-history/index.js';
import type { BrowserKnowledgeIngestOptions, BrowserKnowledgeProfile } from './browser-history/index.js';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeConnectorDoctorReport,
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobMode,
  KnowledgeJobRecord,
  KnowledgeJobRunRecord,
  KnowledgeMaterializedProjection,
  KnowledgeItemView,
  KnowledgeMapResult,
  KnowledgeNodeRecord,
  KnowledgePacket,
  KnowledgePacketDetail,
  KnowledgeProjectionBundle,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeUsageRecord,
} from './types.js';
import {
  buildKnowledgePacket,
  buildKnowledgePacketSync,
  buildKnowledgePromptPacket,
  buildKnowledgePromptPacketSync,
  searchKnowledge,
} from './packet.js';
import {
  ingestKnowledgeArtifact,
  ingestKnowledgeBookmarkSeeds,
  ingestKnowledgeConnectorInput,
  ingestKnowledgeUrl,
  ingestKnowledgeWithConnector,
  importKnowledgeBookmarksFromFile,
  importKnowledgeUrlsFromFile,
  refreshKnowledgeSources,
  pickKnowledgeRefreshCandidates,
  recompileKnowledgeSource,
} from './ingest.js';
import {
  decideKnowledgeConsolidationCandidate,
  runKnowledgeConsolidation,
} from './consolidation.js';
import {
  reviewKnowledgeIssue,
  type KnowledgeIssueReviewInput,
  type KnowledgeIssueReviewResult,
} from './review.js';
import { KnowledgeScheduleService } from './scheduling.js';
import { runKnowledgeServiceJobByKind } from './service-jobs.js';
import { lintKnowledgeStore } from './lint.js';
import { syncKnowledgeMemoryNodes } from './memory-sync.js';
import {
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
  emitKnowledgePacketBuilt,
  emitKnowledgeProjectionMaterialized,
  emitKnowledgeProjectionRendered,
} from '../runtime/emitters/index.js';
import { extractKnowledgeArtifact } from './extractors.js';
import {
  DEFAULT_PACKET_BUDGET,
  DEFAULT_PACKET_LIMIT,
  tokenize,
} from './shared.js';

export interface KnowledgeServiceConfig {
  readonly configManager?: {
    getControlPlaneConfigDir?: (() => string) | undefined | undefined;
  };
  readonly memoryRegistry: Pick<MemoryRegistry, 'add' | 'getAll' | 'getStore'>;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly semanticService?: KnowledgeSemanticService | undefined;
}

export interface KnowledgeServiceStatus extends KnowledgeStatus {
  readonly note: string;
}

export class KnowledgeService {
  private readonly projectionService: KnowledgeProjectionService;
  private readonly scheduleService: KnowledgeScheduleService;
  private readonly semanticService: KnowledgeSemanticService;
  private runtimeBus: RuntimeEventBus | null;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly connectorRegistry = createDefaultKnowledgeConnectorRegistry(),
    private readonly options: KnowledgeServiceConfig,
  ) {
    this.runtimeBus = options.runtimeBus ?? null;
    void this.store.init().catch((error: unknown) => {
      logger.error('[knowledge] store initialization failed', { error: summarizeError(error) });
    });
    this.projectionService = new KnowledgeProjectionService(this.store, this.artifactStore, {
      connectors: () => this.listConnectors(),
    });
    this.semanticService = options.semanticService ?? new KnowledgeSemanticService(this.store);
    this.scheduleService = new KnowledgeScheduleService({
      store: this.store,
      emitIfReady: this.emitIfReady.bind(this),
      runJobByKind: this.runJobByKind.bind(this),
    });
  }

  private getIngestContext() {
    return {
      store: this.store,
      artifactStore: this.artifactStore,
      connectorRegistry: this.connectorRegistry,
      emitIfReady: this.emitIfReady.bind(this),
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
      semanticEnrichSource: async (sourceId: string, knowledgeSpaceId?: string) => {
        await this.semanticService.enrichSource(sourceId, { knowledgeSpaceId });
        await this.semanticService.selfImprove({
          knowledgeSpaceId,
          sourceIds: [sourceId],
          reason: 'ingest',
          limit: 8,
        });
      },
      lint: this.lint.bind(this),
      listConnectors: () => this.listConnectors(),
    };
  }

  private getPacketContext() {
    return {
      store: this.store,
      deferUsage: this.deferUsage.bind(this),
      emitIfReady: this.emitIfReady.bind(this),
    };
  }

  private getConsolidationContext() {
    return {
      store: this.store,
      memoryRegistry: this.options.memoryRegistry,
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
    };
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    if (runtimeBus) this.runtimeBus = runtimeBus;
  }

  async getStatus(): Promise<KnowledgeServiceStatus> {
    await this.store.init();
    return {
      ...this.store.status(),
      note: 'Structured knowledge uses SQL-backed sources, nodes, edges, issues, extractions, and job runs. Markdown is an optional projection, not the source of truth.',
    };
  }

  listUsageRecords(
    limit = 100,
    input: {
      readonly targetKind?: KnowledgeUsageRecord['targetKind'] | undefined;
      readonly targetId?: string | undefined;
      readonly usageKind?: KnowledgeUsageRecord['usageKind'] | undefined;
    } = {},
  ): readonly KnowledgeUsageRecord[] {
    return this.store.listUsageRecords(limit, input);
  }

  listConsolidationCandidates(
    limit = 100,
    input: {
      readonly status?: KnowledgeConsolidationCandidateRecord['status'] | undefined;
      readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'] | undefined;
      readonly subjectId?: string | undefined;
    } = {},
  ): readonly KnowledgeConsolidationCandidateRecord[] {
    return this.store.listConsolidationCandidates(limit, input);
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return this.store.getConsolidationCandidate(id);
  }

  listConsolidationReports(limit = 100): readonly KnowledgeConsolidationReportRecord[] {
    return this.store.listConsolidationReports(limit);
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return this.store.getConsolidationReport(id);
  }

  listSchedules(limit = 100): readonly KnowledgeScheduleRecord[] {
    return this.store.listSchedules(limit);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return this.store.getSchedule(id);
  }

  listSources(limit = 100): KnowledgeSourceRecord[] {
    return this.store.listSources(limit);
  }

  querySources(input: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
    readonly status?: string | undefined;
    readonly connectorId?: string | undefined;
    readonly sourceType?: string | undefined;
    readonly tag?: string | undefined;
    readonly query?: string | undefined;
  } = {}): { total: number; items: KnowledgeSourceRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => {
      if (input.status && source.status !== input.status) return false;
      if (input.connectorId && source.connectorId !== input.connectorId) return false;
      if (input.sourceType && source.sourceType !== input.sourceType) return false;
      if (input.tag && !source.tags.includes(input.tag)) return false;
      if (queryTokens.length === 0) return true;
      const extraction = this.store.getExtractionBySourceId(source.id);
      const haystack = [
        source.title ?? '',
        source.summary ?? '',
        source.description ?? '',
        source.sourceUri ?? '',
        source.canonicalUri ?? '',
        source.folderPath ?? '',
        source.tags.join(' '),
        extraction?.summary ?? '',
        extraction?.excerpt ?? '',
        extraction?.sections.join(' ') ?? '',
      ].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  listNodes(limit = 100): KnowledgeNodeRecord[] {
    return this.store.listNodes(limit);
  }

  queryNodes(input: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
    readonly kind?: string | undefined;
    readonly status?: string | undefined;
    readonly query?: string | undefined;
  } = {}): { total: number; items: KnowledgeNodeRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listNodes(Number.MAX_SAFE_INTEGER).filter((node) => {
      if (input.kind && node.kind !== input.kind) return false;
      if (input.status && node.status !== input.status) return false;
      if (queryTokens.length === 0) return true;
      const haystack = [
        node.title,
        node.summary ?? '',
        node.aliases.join(' '),
        JSON.stringify(node.metadata),
      ].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  listIssues(limit = 100): KnowledgeIssueRecord[] {
    return this.store.listIssues(limit);
  }

  queryIssues(input: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
    readonly severity?: string | undefined;
    readonly status?: string | undefined;
    readonly code?: string | undefined;
    readonly query?: string | undefined;
  } = {}): { total: number; items: KnowledgeIssueRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listIssues(Number.MAX_SAFE_INTEGER).filter((issue) => {
      if (input.severity && issue.severity !== input.severity) return false;
      if (input.status && issue.status !== input.status) return false;
      if (input.code && issue.code !== input.code) return false;
      if (queryTokens.length === 0) return true;
      const haystack = [issue.message, issue.code, JSON.stringify(issue.metadata)].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  async reviewIssue(input: KnowledgeIssueReviewInput): Promise<KnowledgeIssueReviewResult> {
    return reviewKnowledgeIssue(this.store, input);
  }

  listExtractions(limit = 100, sourceId?: string): KnowledgeExtractionRecord[] {
    const records = this.store.listExtractions(sourceId ? 10_000 : limit);
    return sourceId ? records.filter((entry) => entry.sourceId === sourceId).slice(0, Math.max(1, limit)) : records;
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return this.store.getExtraction(id);
  }

  getSourceExtraction(sourceId: string): KnowledgeExtractionRecord | null {
    return this.store.getExtractionBySourceId(sourceId);
  }

  listConnectors(): readonly KnowledgeConnector[] {
    return this.connectorRegistry.list();
  }

  getConnector(id: string): KnowledgeConnector | null {
    return this.connectorRegistry.get(id) ?? null;
  }

  async doctorConnector(id: string): Promise<KnowledgeConnectorDoctorReport | null> {
    return this.connectorRegistry.doctor(id);
  }

  registerConnector(connector: KnowledgeConnector, options: { replace?: boolean } = {}): void {
    this.connectorRegistry.register(connector, options);
  }

  getItem(id: string): KnowledgeItemView | null {
    const item = this.store.getItem(id);
    if (item?.source) this.deferUsage({ targetKind: 'source', targetId: item.source.id, usageKind: 'item-open' });
    if (item?.node) this.deferUsage({ targetKind: 'node', targetId: item.node.id, usageKind: 'item-open' });
    if (item?.issue) this.deferUsage({ targetKind: 'issue', targetId: item.issue.id, usageKind: 'item-open' });
    return item;
  }

  getItems(ids: readonly string[]): KnowledgeItemView[] {
    return ids.map((id) => this.getItem(id)).filter((item): item is KnowledgeItemView => Boolean(item));
  }

  async recordUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<KnowledgeUsageRecord> {
    await this.store.init();
    return this.store.upsertUsageRecord(input);
  }

  getNeighbors(
    kind: 'source' | 'node',
    id: string,
    input: { readonly relation?: string | undefined; readonly limit?: number | undefined } = {},
  ): {
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly nodes: readonly KnowledgeNodeRecord[];
  } {
    const limit = Math.max(1, input.limit ?? 20);
    const edges = this.store.edgesFor(kind, id)
      .filter((edge) => !input.relation || edge.relation === input.relation)
      .slice(0, limit);
    this.deferUsage({
      targetKind: kind,
      targetId: id,
      usageKind: 'neighbor-open',
      metadata: input.relation ? { relation: input.relation } : {},
    });
    const sources: KnowledgeSourceRecord[] = [];
    const nodes: KnowledgeNodeRecord[] = [];
    for (const edge of edges) {
      const otherKind = edge.fromKind === kind && edge.fromId === id ? edge.toKind : edge.fromKind;
      const otherId = edge.fromKind === kind && edge.fromId === id ? edge.toId : edge.fromId;
      if (otherKind === 'source') {
        const source = this.store.getSource(otherId);
        if (source) sources.push(source);
      } else if (otherKind === 'node') {
        const node = this.store.getNode(otherId);
        if (node) nodes.push(node);
      }
    }
    return { edges, sources, nodes };
  }

  async ingestUrl(input: {
    readonly url: string;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    return ingestKnowledgeUrl(this.getIngestContext(), input);
  }

  async ingestArtifact(input: {
    readonly artifactId?: string | undefined;
    readonly path?: string | undefined;
    readonly uri?: string | undefined;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    return ingestKnowledgeArtifact(this.getIngestContext(), input);
  }

  async importBookmarksFromFile(input: {
    readonly path: string;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeBookmarksFromFile(this.getIngestContext(), input);
  }

  async importUrlsFromFile(input: {
    readonly path: string;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeUrlsFromFile(this.getIngestContext(), input);
  }

  async ingestBookmarkSeeds(
    seeds: readonly KnowledgeBookmarkSeed[],
    sessionId?: string,
    sourceType: KnowledgeSourceType = 'bookmark',
    connectorId = 'bookmark',
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeBookmarkSeeds(this.getIngestContext(), seeds, sessionId, sourceType, connectorId, allowPrivateHosts);
  }

  async ingestWithConnector(
    connectorId: string,
    input: unknown,
    sessionId?: string,
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeWithConnector(this.getIngestContext(), connectorId, input, sessionId, allowPrivateHosts);
  }

  async ingestConnectorInput(input: {
    readonly connectorId: string;
    readonly input?: unknown | undefined;
    readonly content?: string | undefined;
    readonly path?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
  }): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeConnectorInput(this.getIngestContext(), input);
  }

  async syncBrowserHistory(
    input: BrowserKnowledgeIngestOptions = {},
  ): Promise<KnowledgeBatchIngestResult & { readonly profiles: readonly BrowserKnowledgeProfile[] }> {
    return ingestBrowserKnowledge(this.getIngestContext(), input);
  }

  async listProjectionTargets(limit = 25): Promise<KnowledgeProjectionTarget[]> {
    return this.projectionService.listTargets(limit);
  }

  async renderProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<KnowledgeProjectionBundle> {
    const bundle = await this.projectionService.render(input);
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionRendered(bus, ctx, {
      targetId: bundle.target.targetId,
      pageCount: bundle.pageCount,
    }));
    return bundle;
  }

  async materializeProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string | undefined;
    readonly limit?: number | undefined;
    readonly filename?: string | undefined;
  }): Promise<KnowledgeMaterializedProjection> {
    const materialized = await this.projectionService.materialize(input);
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionMaterialized(bus, ctx, {
      targetId: materialized.bundle.target.targetId,
      artifactId: materialized.artifact.id,
      pageCount: materialized.bundle.pageCount,
    }));
    return materialized;
  }

  async map(input: KnowledgeMapRenderOptions = {}): Promise<KnowledgeMapResult> {
    await this.store.init();
    return renderKnowledgeMap({
      title: 'Knowledge Map',
      sources: this.store.listSources(Number.MAX_SAFE_INTEGER),
      nodes: this.store.listNodes(Number.MAX_SAFE_INTEGER),
      edges: this.store.listEdges(),
      issues: this.store.listIssues(Number.MAX_SAFE_INTEGER),
    }, input);
  }

  async reindex(): Promise<{ status: KnowledgeStatus; issues: readonly KnowledgeIssueRecord[] }> {
    await this.store.init();
    for (const source of this.store.listSources(Number.MAX_SAFE_INTEGER)) {
      await recompileKnowledgeSource(this.getIngestContext(), source);
    }
    await this.semanticService.reindex({ force: false });
    await this.syncReviewedMemory();
    const issues = await lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
    return { status: this.store.status(), issues };
  }

  search(query: string, limit = 10): KnowledgeSearchResult[] {
    return searchKnowledge(this.getPacketContext(), query, limit);
  }

  async ask(input: {
    readonly query: string;
    readonly limit?: number | undefined;
    readonly mode?: 'concise' | 'standard' | 'detailed' | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    readonly includeSources?: boolean | undefined;
    readonly includeConfidence?: boolean | undefined;
    readonly includeLinkedObjects?: boolean | undefined;
  }) {
    return this.semanticService.answer(input);
  }

  async buildPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): Promise<KnowledgePacket> {
    return buildKnowledgePacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  buildPacketSync(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): KnowledgePacket | null {
    return buildKnowledgePacketSync(this.getPacketContext(), task, writeScope, limit, options);
  }

  buildPromptPacketSync(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): string | null {
    return buildKnowledgePromptPacketSync(this.getPacketContext(), task, writeScope, limit, options);
  }

  async buildPromptPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): Promise<string | null> {
    return buildKnowledgePromptPacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  listJobs(): readonly KnowledgeJobRecord[] {
    return this.scheduleService.listJobs();
  }

  getJob(id: string): KnowledgeJobRecord | null {
    return this.scheduleService.getJob(id);
  }

  async saveSchedule(input: {
    readonly id?: string | undefined;
    readonly jobId: string;
    readonly label?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly schedule: AutomationScheduleDefinition;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<KnowledgeScheduleRecord> {
    return this.scheduleService.saveSchedule(input);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.scheduleService.deleteSchedule(id);
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    return this.scheduleService.setScheduleEnabled(id, enabled);
  }

  async decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: {
      readonly decidedBy?: string | undefined;
      readonly memoryClass?: string | undefined;
      readonly scope?: string | undefined;
      readonly detail?: string | undefined;
    } = {},
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    return decideKnowledgeConsolidationCandidate(this.getConsolidationContext(), id, decision, input);
  }

  listJobRuns(limit = 100, jobId?: string): readonly KnowledgeJobRunRecord[] {
    return this.scheduleService.listJobRuns(limit, jobId);
  }

  listRefinementTasks(limit = 100, input: {
    readonly spaceId?: string | undefined;
    readonly state?: KnowledgeRefinementTaskState | string | undefined;
    readonly subjectKind?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly gapId?: string | undefined;
  } = {}): readonly KnowledgeRefinementTaskRecord[] {
    return this.store.listRefinementTasks(limit, input);
  }

  getRefinementTask(id: string): KnowledgeRefinementTaskRecord | null {
    return this.store.getRefinementTask(id);
  }

  async cancelRefinementTask(id: string): Promise<KnowledgeRefinementTaskRecord | null> {
    const task = this.store.getRefinementTask(id);
    if (!task) return null;
    return this.store.upsertRefinementTask({
      id: task.id,
      spaceId: task.spaceId,
      subjectKind: task.subjectKind,
      subjectId: task.subjectId,
      subjectTitle: task.subjectTitle,
      subjectType: task.subjectType,
      gapId: task.gapId,
      issueId: task.issueId,
      state: 'cancelled',
      priority: task.priority,
      trigger: task.trigger,
      budget: task.budget,
      attemptCount: task.attemptCount,
      appendTrace: [{
        at: Date.now(),
        state: 'cancelled',
        message: 'Refinement task was cancelled by request.',
      }],
      metadata: task.metadata,
    });
  }

  async runRefinement(input: {
    readonly knowledgeSpaceId?: string | undefined;
    readonly gapIds?: readonly string[] | undefined;
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
  } = {}) {
    return this.semanticService.selfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      gapIds: input.gapIds,
      sourceIds: input.sourceIds,
      limit: input.limit,
      maxRunMs: input.maxRunMs,
      force: input.force,
      reason: 'manual',
    });
  }

  async runJob(
    id: string,
    input: {
      readonly mode?: KnowledgeJobMode | undefined;
      readonly sourceIds?: readonly string[] | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<KnowledgeJobRunRecord> {
    return this.scheduleService.runJob(id, input);
  }

  private async runJobByKind(
    kind: KnowledgeJobRecord['kind'],
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
  ): Promise<Record<string, unknown>> {
    return runKnowledgeServiceJobByKind(kind, input, {
      lint: () => lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) }),
      reindex: () => this.reindex(),
      refreshSources: async (refreshKind, sourceIds, limit) =>
        refreshKnowledgeSources(
          this.getIngestContext(),
          pickKnowledgeRefreshCandidates({ store: this.store }, refreshKind, sourceIds, limit),
        ),
      syncBrowserHistory: (options) => this.syncBrowserHistory(options),
      materializeProjection: (options) => this.materializeProjection(options),
      semanticService: this.semanticService,
      runConsolidation: (jobKind, options) =>
        runKnowledgeConsolidation(this.getConsolidationContext(), jobKind, options),
    });
  }

  private deferUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly score?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): void {
    queueMicrotask(() => {
      void this.recordUsage(input).catch((error: unknown) => {
        logger.warn('Knowledge usage recording failed', {
          targetKind: input.targetKind,
          targetId: input.targetId,
          usageKind: input.usageKind,
          error: summarizeError(error),
        });
      });
    });
  }

  private async syncReviewedMemory(): Promise<void> {
    await syncKnowledgeMemoryNodes(this.store, this.options.memoryRegistry);
  }

  private dispose(): void {
    this.scheduleService.dispose();
  }

  async lint(): Promise<readonly KnowledgeIssueRecord[]> {
    return lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
  }

  private emitIfReady(
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ): void {
    if (!this.runtimeBus) return;
    fn(this.runtimeBus, {
      traceId: randomUUID(),
      sessionId: sessionId ?? 'knowledge-runtime',
      source: 'knowledge.service',
    });
  }
}

export function buildCuratedKnowledgePromptSync(
  service: Pick<KnowledgeService, 'buildPromptPacketSync'>,
  task: string,
  writeScope: readonly string[] = [],
): string | null {
  return service.buildPromptPacketSync(task, writeScope);
}
