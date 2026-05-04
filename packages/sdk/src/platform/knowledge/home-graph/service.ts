import { ConfigurationError, GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  homeGraphSourceId,
  namespacedCanonicalUri,
  readRecord,
  resolveHomeGraphSpace,
  uniqueStrings,
} from './helpers.js';
import { refreshHomeGraphQualityIssues } from './quality.js';
import { reviewHomeGraphFact, type HomeGraphReviewResult } from './review.js';
import {
  inferHomeGraphSourceType,
  readHomeGraphState,
  safeHomeGraphFilename,
} from './state.js';
import { answerHomeGraphQuery } from './ask.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import {
  autoLinkHomeGraphSource,
} from './auto-link.js';
import {
  generateHomeGraphPacket,
  generateHomeGraphRoomPage,
  refreshHomeGraphDevicePassport,
} from './generated-pages.js';
import { refreshDevicePagesForHomeGraphAsk } from './ask-page-refresh.js';
import { coalescedHomeGraphReindexResult, runHomeGraphReindex } from './reindex.js';
import { listHomeGraphPages } from './pages.js';
import { browseHomeGraph, listHomeGraphSources } from './inventory.js';
import { mapHomeGraph } from './map-view.js';
import { getHomeGraphStatus } from './status.js';
import { resetHomeGraphSpace } from './reset.js';
import { linkHomeGraphKnowledge, unlinkHomeGraphKnowledge } from './link.js';
import { exportHomeGraphSpace, importHomeGraphSpace } from './import-export.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from './extension.js';
import {
  cancelHomeGraphRefinementTask,
  getHomeGraphRefinementTask,
  listHomeGraphRefinementTasks,
  runHomeGraphRefinement,
} from './refinement.js';
import { isUnusableHomeGraphExtractionText } from './extraction-quality.js';
import {
  readHomeGraphSearchState,
  scoreHomeGraphResults,
  selectHomeGraphExtractionRepairCandidates,
} from './search.js';
import {
  enrichAndImproveHomeGraphSource,
  enrichHomeGraphSpaceSources,
  HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS,
  runHomeGraphSyncSelfImprovementPump,
} from './sync-self-improvement.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { runHomeGraphSnapshotSync } from './sync.js';
import { autoLinkExistingHomeGraphSources, extractHomeGraphArtifact } from './extraction.js';
import type {
  HomeGraphAskInput, HomeGraphAskResult, HomeGraphDevicePassportResult, HomeGraphExport,
  HomeGraphIngestArtifactInput, HomeGraphIngestNoteInput, HomeGraphIngestResult, HomeGraphIngestUrlInput,
  HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult,
  HomeGraphMapInput, HomeGraphMapResult, HomeGraphProjectionInput, HomeGraphProjectionResult,
  HomeGraphPageListResult, HomeGraphReindexInput, HomeGraphReindexResult, HomeGraphResetInput, HomeGraphResetResult, HomeGraphReviewInput, HomeGraphSpaceInput,
  HomeGraphSnapshotInput, HomeGraphStatus, HomeGraphSyncResult,
} from './types.js';

export class HomeGraphService {
  private activeReindex: Promise<HomeGraphReindexResult> | null = null;
  private pendingSyncSelfImprove = new Set<string>();
  private syncSelfImproveControllers = new Map<string, AbortController>();
  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly options: { readonly semanticService?: KnowledgeSemanticService } = {},
  ) {
    this.options.semanticService?.addObjectProfiles(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles);
  }

  dispose(): void {
    this.cancelSyncSelfImprovement();
  }

  async status(input: { readonly installationId?: string; readonly knowledgeSpaceId?: string } = {}): Promise<HomeGraphStatus> {
    return getHomeGraphStatus(this.store, input);
  }

  async syncSnapshot(input: HomeGraphSnapshotInput): Promise<HomeGraphSyncResult> {
    await this.store.init();
    const result = await runHomeGraphSnapshotSync({
      store: this.store,
      artifactStore: this.artifactStore,
      snapshot: input,
    });
    this.scheduleSyncSelfImprovement(result.spaceId, result.installationId);
    return result;
  }

  async ingestUrl(input: HomeGraphIngestUrlInput): Promise<HomeGraphIngestResult> {
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    const artifact = await this.artifactStore.create({
      uri: input.url,
      allowPrivateHosts: input.allowPrivateHosts,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeGraphSourceKind: 'url',
        requestedAt: Date.now(),
      }),
    });
    return this.ingestCreatedArtifact({
      spaceId,
      installationId,
      artifact,
      title: input.title,
      sourceUri: input.url,
      sourceType: inferHomeGraphSourceType(input.tags, 'url'),
      tags: ['homeassistant', 'home-graph', ...(input.tags ?? [])],
      target: input.target,
      metadata: {
        ...(input.metadata ?? {}),
        homeGraphSourceKind: 'url',
      },
    });
  }

  async ingestNote(input: HomeGraphIngestNoteInput): Promise<HomeGraphIngestResult> {
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    const title = input.title ?? `Home Assistant note ${new Date().toISOString()}`;
    const artifact = await this.artifactStore.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: `${safeHomeGraphFilename(title)}.md`,
      text: input.body,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeGraphSourceKind: 'note',
        category: input.category ?? 'note',
      }),
    });
    return this.ingestCreatedArtifact({
      spaceId,
      installationId,
      artifact,
      title,
      sourceType: 'document',
      tags: uniqueStrings(['homeassistant', 'home-graph', 'note', input.category, ...(input.tags ?? [])]),
      target: input.target,
      metadata: {
        ...(input.metadata ?? {}),
        homeGraphSourceKind: 'note',
        category: input.category ?? 'note',
      },
    });
  }

  async ingestArtifact(input: HomeGraphIngestArtifactInput): Promise<HomeGraphIngestResult> {
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    const artifact = input.artifactId
      ? this.artifactStore.get(input.artifactId)
      : await this.artifactStore.create({
          path: input.path,
          uri: input.uri,
          allowPrivateHosts: input.allowPrivateHosts,
          metadata: buildHomeGraphMetadata(spaceId, installationId, {
            homeGraphSourceKind: 'artifact',
            requestedAt: Date.now(),
          }),
        });
    if (!artifact) {
      throw new GoodVibesSdkError('Unknown Home Graph artifact.', {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return this.ingestCreatedArtifact({
      spaceId,
      installationId,
      artifact,
      title: input.title,
      sourceUri: input.uri ?? input.path ?? artifact.sourceUri,
      sourceType: inferHomeGraphSourceType(input.tags, 'document'),
      tags: ['homeassistant', 'home-graph', 'artifact', ...(input.tags ?? [])],
      target: input.target,
      metadata: {
        ...(input.metadata ?? {}),
        homeGraphSourceKind: 'artifact',
      },
    });
  }

  async linkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphLinkResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return linkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
  }

  async unlinkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphLinkResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return unlinkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
  }

  async ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    const initialState = readHomeGraphSearchState(this.store, spaceId);
    const repairedExtractions = await this.repairStaleExtractionsForAsk(spaceId, installationId, input.query, initialState);
    const state = repairedExtractions > 0 ? readHomeGraphSearchState(this.store, spaceId) : initialState;
    const results = scoreHomeGraphResults(
      input.query,
      state.sources,
      state.nodes,
      state.edges,
      (sourceId) => state.extractionBySourceId.get(sourceId),
      input.limit ?? 8,
    );
    const answer = await answerHomeGraphQuery({ store: this.store, semanticService: this.options.semanticService, spaceId, query: input, state, results });
    const pageRefresh = await refreshDevicePagesForHomeGraphAsk({
      store: this.store,
      artifactStore: this.artifactStore,
      spaceId,
      installationId,
      answer,
    });
    return withHomeGraphAskPageRefresh(answer, pageRefresh);
  }

  async reindex(input: HomeGraphReindexInput = {}): Promise<HomeGraphReindexResult> {
    await this.store.init();
    if (this.activeReindex) return coalescedHomeGraphReindexResult(this.store, input);
    const run = runHomeGraphReindex({
      store: this.store,
      artifactStore: this.artifactStore,
      semanticService: this.options.semanticService,
      extract: (source, artifact, spaceId, installationId) => this.extractArtifact(source, artifact, spaceId, installationId),
      autoLinkExistingSources: (spaceId, installationId, sourceIds) => this.autoLinkExistingSources(spaceId, installationId, sourceIds),
      refreshQualityIssues: (spaceId, installationId) => this.refreshQualityIssues(spaceId, installationId),
    }, input);
    this.activeReindex = run;
    try {
      return await run;
    } finally {
      if (this.activeReindex === run) this.activeReindex = null;
    }
  }

  private async repairStaleExtractionsForAsk(
    spaceId: string,
    installationId: string,
    query: string,
    state: ReturnType<typeof readHomeGraphSearchState>,
  ): Promise<number> {
    const candidates = selectHomeGraphExtractionRepairCandidates(
      query,
      state.sources,
      state.nodes,
      state.edges,
      (sourceId) => state.extractionBySourceId.get(sourceId),
      2,
    );
    let repaired = 0;
    for (const [index, source] of candidates.entries()) {
      await yieldEvery(index, 2);
      const artifactId = typeof source.artifactId === 'string' ? source.artifactId : undefined;
      if (!artifactId) continue;
      const artifact = this.artifactStore.get(artifactId);
      if (!artifact) continue;
      const extraction = await this.extractArtifact(source, artifact, spaceId, installationId);
      if (extraction) {
        await autoLinkHomeGraphSource({
          store: this.store,
          spaceId,
          installationId,
          source,
          extraction,
          state: readHomeGraphState(this.store, spaceId),
        });
      }
      if (extraction && extractionHasSearchableText(extraction)) repaired += 1;
      await yieldToEventLoop();
    }
    return repaired;
  }

  async refreshDevicePassport(input: HomeGraphProjectionInput): Promise<HomeGraphDevicePassportResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    await this.enrichSpaceSources(spaceId);
    return refreshHomeGraphDevicePassport({
      store: this.store,
      artifactStore: this.artifactStore,
      spaceId,
      installationId,
      input,
    });
  }

  async generateRoomPage(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    await this.enrichSpaceSources(spaceId);
    return generateHomeGraphRoomPage({
      store: this.store,
      artifactStore: this.artifactStore,
      spaceId,
      installationId,
      input,
    });
  }

  async generatePacket(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    await this.enrichSpaceSources(spaceId);
    return generateHomeGraphPacket({
      store: this.store,
      artifactStore: this.artifactStore,
      spaceId,
      installationId,
      input,
    });
  }

  async listIssues(input: HomeGraphSpaceInput & {
    readonly status?: string | undefined;
    readonly severity?: string | undefined;
    readonly code?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly ok: true; readonly spaceId: string; readonly issues: readonly KnowledgeIssueRecord[] }> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const limit = Math.max(1, input.limit ?? 100);
    const issues = readHomeGraphState(this.store, spaceId).issues
      .filter((issue) => !input.status || issue.status === input.status)
      .filter((issue) => !input.severity || issue.severity === input.severity)
      .filter((issue) => !input.code || issue.code === input.code)
      .slice(0, limit);
    return { ok: true, spaceId, issues };
  }

  async reviewFact(input: HomeGraphReviewInput): Promise<HomeGraphReviewResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return reviewHomeGraphFact(this.store, spaceId, installationId, input);
  }

  async listSources(input: HomeGraphSpaceInput & { readonly limit?: number } = {}): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly sources: readonly KnowledgeSourceRecord[];
  }> {
    return listHomeGraphSources({ ...input, store: this.store });
  }

  async listPages(input: HomeGraphSpaceInput & { readonly limit?: number; readonly includeMarkdown?: boolean } = {}): Promise<HomeGraphPageListResult> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphState(this.store, spaceId);
    return listHomeGraphPages({
      artifactStore: this.artifactStore,
      spaceId,
      sources: state.sources,
      nodes: state.nodes,
      edges: state.edges,
      limit: Math.max(1, input.limit ?? 100),
      includeMarkdown: input.includeMarkdown !== false,
    });
  }

  async listRefinementTasks(input: HomeGraphSpaceInput & {
    readonly limit?: number | undefined;
    readonly state?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly gapId?: string | undefined;
  } = {}) {
    return listHomeGraphRefinementTasks({ ...input, store: this.store });
  }

  async getRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return getHomeGraphRefinementTask({ ...input, store: this.store });
  }

  async runRefinement(input: HomeGraphSpaceInput & {
    readonly gapIds?: readonly string[] | undefined;
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
  } = {}) {
    return runHomeGraphRefinement({ ...input, store: this.store, semanticService: this.options.semanticService });
  }

  async cancelRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return cancelHomeGraphRefinementTask({ ...input, store: this.store });
  }

  async browse(input: HomeGraphSpaceInput & { readonly limit?: number } = {}): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly nodes: readonly KnowledgeNodeRecord[];
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly issues: readonly KnowledgeIssueRecord[];
  }> {
    return browseHomeGraph({ ...input, store: this.store });
  }

  async map(input: HomeGraphMapInput = {}): Promise<HomeGraphMapResult> {
    return mapHomeGraph({ ...input, store: this.store });
  }

  async exportSpace(input: HomeGraphSpaceInput = {}): Promise<HomeGraphExport> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    return exportHomeGraphSpace(this.store, { spaceId, installationId });
  }

  async importSpace(input: HomeGraphSpaceInput & { readonly data: HomeGraphExport }): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
  }> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return importHomeGraphSpace(this.store, { spaceId, installationId, data: input.data });
  }

  async resetSpace(input: HomeGraphResetInput): Promise<HomeGraphResetResult> {
    return resetHomeGraphSpace(this.store, this.artifactStore, input);
  }

  private async ingestCreatedArtifact(input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly artifact: ArtifactDescriptor;
    readonly title?: string | undefined;
    readonly sourceUri?: string | undefined;
    readonly sourceType: KnowledgeSourceType;
    readonly tags: readonly string[];
    readonly target?: HomeGraphKnowledgeTarget | undefined;
    readonly metadata: Record<string, unknown>;
  }): Promise<HomeGraphIngestResult> {
    const sourceId = homeGraphSourceId(input.spaceId, input.metadata.homeGraphSourceKind as string, input.sourceUri ?? input.artifact.id);
    const source = await this.store.upsertSource({
      id: sourceId,
      connectorId: HOME_GRAPH_CONNECTOR_ID,
      sourceType: input.sourceType,
      title: input.title ?? input.artifact.filename,
      sourceUri: input.sourceUri ?? input.artifact.sourceUri,
      canonicalUri: namespacedCanonicalUri(input.spaceId, 'source', input.sourceUri ?? input.artifact.id),
      tags: uniqueStrings(input.tags),
      status: 'indexed',
      artifactId: input.artifact.id,
      lastCrawledAt: Date.now(),
      metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
        ...input.metadata,
        artifactMimeType: input.artifact.mimeType,
      }),
    });
    const extraction = await this.extractArtifact(source, input.artifact, input.spaceId, input.installationId);
    const linked = input.target
      ? (await this.linkKnowledge({ knowledgeSpaceId: input.spaceId, sourceId: source.id, target: input.target })).edge
      : (await autoLinkHomeGraphSource({
          store: this.store,
          spaceId: input.spaceId,
          installationId: input.installationId,
          source,
          ...(extraction ? { extraction } : {}),
          state: readHomeGraphState(this.store, input.spaceId),
        }))?.edge;
    scheduleBackground(() => {
      void this.enrichAndImproveSource(source.id, input.spaceId).catch((error: unknown) => {
        this.reportBackgroundError('homegraph-ingest-enrich', error, {
          spaceId: input.spaceId,
          sourceId: source.id,
        });
      });
    });
    return {
      ok: true,
      spaceId: input.spaceId,
      source,
      artifactId: input.artifact.id,
      extraction,
      ...(linked ? { linked } : {}),
    };
  }

  private async extractArtifact(
    source: KnowledgeSourceRecord,
    artifact: ArtifactDescriptor,
    spaceId: string,
    installationId: string,
  ): Promise<KnowledgeExtractionRecord | undefined> {
    return extractHomeGraphArtifact({
      store: this.store,
      artifactStore: this.artifactStore,
      reportBackgroundError: this.reportBackgroundError.bind(this),
    }, source, artifact, spaceId, installationId);
  }

  private async autoLinkExistingSources(
    spaceId: string,
    installationId: string,
    sourceIds?: readonly string[],
  ) {
    return autoLinkExistingHomeGraphSources(this.store, spaceId, installationId, sourceIds);
  }

  private async refreshQualityIssues(spaceId: string, installationId: string): Promise<readonly KnowledgeIssueRecord[]> {
    return refreshHomeGraphQualityIssues(this.store, spaceId, installationId);
  }

  /**
   * Start the post-sync self-improvement pump for a Home Graph space.
   * The pump is intentionally delayed so the foreground sync response can
   * return before source search, semantic repair, and page refresh work begins.
   */
  private scheduleSyncSelfImprovement(spaceId: string, installationId: string): void {
    if (!this.options.semanticService || this.pendingSyncSelfImprove.has(spaceId)) return;
    this.pendingSyncSelfImprove.add(spaceId);
    const controller = new AbortController();
    this.syncSelfImproveControllers.set(spaceId, controller);
    scheduleBackground(() => {
      void this.runSyncSelfImprovementPump(spaceId, installationId, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.reportBackgroundError('homegraph-sync-self-improvement', error, { spaceId, installationId });
      }).finally(() => {
        this.pendingSyncSelfImprove.delete(spaceId);
        this.syncSelfImproveControllers.delete(spaceId);
      });
    // Tie the delayed task to the controller so a space reset can cancel work
    // before it starts or cooperatively stop it while it is running.
    }, HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS, controller.signal);
  }

  /** Cancel pending or active post-sync improvement work for one space or all spaces. */
  private cancelSyncSelfImprovement(spaceId?: string): void {
    const entries = spaceId
      ? [...this.syncSelfImproveControllers.entries()].filter(([key]) => key === spaceId)
      : [...this.syncSelfImproveControllers.entries()];
    for (const [key, controller] of entries) {
      controller.abort();
      this.syncSelfImproveControllers.delete(key);
      this.pendingSyncSelfImprove.delete(key);
    }
  }

  /**
   * Relentlessly repairs gaps discovered during sync until the run budget,
   * task budget, or cooperative abort signal says to stop.
   */
  private async runSyncSelfImprovementPump(spaceId: string, installationId: string, signal: AbortSignal): Promise<void> {
    const runtime = this.requireSelfImprovementRuntime();
    await runHomeGraphSyncSelfImprovementPump(runtime, spaceId, installationId, signal);
  }

  private async enrichSpaceSources(spaceId: string): Promise<void> {
    if (!this.options.semanticService) return;
    await enrichHomeGraphSpaceSources(this.requireSelfImprovementRuntime(), spaceId);
  }

  private async enrichAndImproveSource(sourceId: string, spaceId: string): Promise<void> {
    if (!this.options.semanticService) return;
    await enrichAndImproveHomeGraphSource(this.requireSelfImprovementRuntime(), sourceId, spaceId);
  }

  private requireSelfImprovementRuntime() {
    const semanticService = this.options.semanticService;
    if (!semanticService) {
      throw new ConfigurationError('Home Graph semantic self-improvement is not configured.', {
        source: 'config',
        hint: 'Configure KnowledgeSemanticService before running Home Graph semantic enrichment.',
      });
    }
    return {
      store: this.store,
      artifactStore: this.artifactStore,
      semanticService,
      reportBackgroundError: this.reportBackgroundError.bind(this),
    };
  }

  private reportBackgroundError(event: string, error: unknown, metadata: Record<string, unknown>): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Home Graph background work failed', {
      event,
      error: message,
      ...metadata,
    });
  }

}

function withHomeGraphAskPageRefresh(
  answer: HomeGraphAskResult,
  pageRefresh: { readonly requested: boolean; readonly refreshed: number },
): HomeGraphAskResult {
  if (!answer.answer.refinement && !pageRefresh.requested) return answer;
  const refinement = answer.answer.refinement;
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinement: {
        status: refinement?.status ?? 'not_needed',
        ...(refinement?.repairStatus ? { repairStatus: refinement.repairStatus } : {}),
        ...(refinement?.reason ? { reason: refinement.reason } : {}),
        refinementTaskIds: refinement?.refinementTaskIds ?? answer.answer.refinementTaskIds ?? [],
        acceptedSourceIds: refinement?.acceptedSourceIds ?? [],
        promotedFactCount: refinement?.promotedFactCount ?? (answer.answer.facts?.length ?? 0),
        ...(refinement?.nextRepairAttemptAt ? { nextRepairAttemptAt: refinement.nextRepairAttemptAt } : {}),
        ...(typeof refinement?.waitedMs === 'number' ? { waitedMs: refinement.waitedMs } : {}),
        ...(refinement?.answerCacheInvalidated ? { answerCacheInvalidated: true } : {}),
        pageRefreshRequested: pageRefresh.requested,
        pageRefreshed: pageRefresh.refreshed > 0,
      },
    },
  };
}

function extractionHasSearchableText(extraction: KnowledgeExtractionRecord): boolean {
  const structure = readRecord(extraction.structure);
  return typeof structure.searchText === 'string' && !isUnusableHomeGraphExtractionText(structure.searchText);
}
