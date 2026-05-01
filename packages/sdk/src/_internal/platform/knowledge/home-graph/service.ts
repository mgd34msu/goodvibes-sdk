import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import { extractKnowledgeArtifact } from '../extractors.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  belongsToSpace,
  buildHomeGraphMetadata,
  buildHomeGraphNodeInput,
  edgeIsActive,
  homeGraphNodeId,
  homeGraphSourceId,
  namespacedCanonicalUri,
  nodeKindForHomeGraphObject,
  normalizeHomeGraphObjectInput,
  readRecord,
  resolveHomeGraphSpace,
  targetToReference,
  uniqueStrings,
} from './helpers.js';
import { upsertIntegrationDocumentationCandidates } from './documentation.js';
import { refreshHomeGraphQualityIssues } from './quality.js';
import { reviewHomeGraphFact, type HomeGraphReviewResult } from './review.js';
import {
  inferHomeGraphSourceType,
  readHomeGraphState,
  renderHomeGraphState,
  safeHomeGraphFilename,
} from './state.js';
import { answerHomeGraphQuery } from './ask.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { renderHomeGraphMap } from './rendering.js';
import {
  autoLinkHomeGraphSource,
  autoLinkHomeGraphSources,
  type HomeGraphAutoLinkResult,
} from './auto-link.js';
import {
  generateAutomaticHomeGraphPages,
  generateHomeGraphPacket,
  generateHomeGraphRoomPage,
  refreshAutomaticHomeGraphPages,
  refreshHomeGraphDevicePassport,
} from './generated-pages.js';
import { reindexHomeGraphSources } from './reindex.js';
import { listHomeGraphPages } from './pages.js';
import { isUnusableHomeGraphExtractionText } from './extraction-quality.js';
import {
  readHomeGraphSearchState,
  scoreHomeGraphResults,
  selectHomeGraphExtractionRepairCandidates,
} from './search.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import type {
  HomeGraphAskInput, HomeGraphAskResult, HomeGraphDevicePassportResult, HomeGraphExport,
  HomeGraphIngestArtifactInput, HomeGraphIngestNoteInput, HomeGraphIngestResult, HomeGraphIngestUrlInput,
  HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult, HomeGraphObjectInput,
  HomeGraphMapInput, HomeGraphMapResult, HomeGraphProjectionInput, HomeGraphProjectionResult,
  HomeGraphPageListResult, HomeGraphReindexResult, HomeGraphReviewInput, HomeGraphSpaceInput,
  HomeGraphSnapshotInput, HomeGraphStatus, HomeGraphSyncResult,
} from './types.js';
import { HOME_GRAPH_CAPABILITIES } from './types.js';

export class HomeGraphService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly options: { readonly semanticService?: KnowledgeSemanticService } = {},
  ) {}

  async status(input: { readonly installationId?: string; readonly knowledgeSpaceId?: string } = {}): Promise<HomeGraphStatus> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphState(this.store, spaceId);
    const snapshotSources = state.sources
      .filter((source) => source.metadata.homeGraphSourceKind === 'snapshot')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      ok: true,
      spaceId,
      installationId,
      sourceCount: state.sources.length,
      nodeCount: state.nodes.length,
      edgeCount: state.edges.length,
      issueCount: state.issues.length,
      extractionCount: state.extractions.length,
      ...(snapshotSources[0]?.updatedAt ? { lastSnapshotAt: snapshotSources[0].updatedAt } : {}),
      capabilities: HOME_GRAPH_CAPABILITIES,
    };
  }

  async syncSnapshot(input: HomeGraphSnapshotInput): Promise<HomeGraphSyncResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    const capturedAt = input.capturedAt ?? Date.now();
    const source = await this.store.upsertSource({
      id: homeGraphSourceId(spaceId, 'snapshot', String(capturedAt)),
      connectorId: HOME_GRAPH_CONNECTOR_ID,
      sourceType: 'dataset',
      title: input.title ?? 'Home Assistant snapshot',
      canonicalUri: namespacedCanonicalUri(spaceId, 'snapshot', String(capturedAt)),
      summary: 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.',
      tags: ['homeassistant', 'home-graph', 'snapshot'],
      status: 'indexed',
      lastCrawledAt: capturedAt,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        ...(input.metadata ?? {}),
        homeGraphSourceKind: 'snapshot',
        capturedAt,
      }),
    });
    const home = await this.upsertHomeNode(spaceId, installationId, input);
    const beforeNodeIds = new Set(readHomeGraphState(this.store, spaceId).nodes.map((node) => node.id));
    const beforeEdgeIds = new Set(readHomeGraphState(this.store, spaceId).edges.map((edge) => edge.id));
    const groups = await this.upsertSnapshotObjects(spaceId, installationId, input, home.id, source.id);
    await this.autoLinkExistingSources(spaceId, installationId);
    const issues = await this.refreshQualityIssues(spaceId, installationId);
    void this.options.semanticService?.selfImprove({
      knowledgeSpaceId: spaceId,
      reason: 'homegraph-sync',
      limit: 16,
    }).catch(() => {});
    const generated = await generateAutomaticHomeGraphPages({
      store: this.store,
      artifactStore: this.artifactStore,
      spaceId,
      installationId,
      input,
    });
    const after = readHomeGraphState(this.store, spaceId);
    return {
      ok: true,
      spaceId,
      installationId,
      source,
      home,
      created: {
        nodes: after.nodes.filter((node) => !beforeNodeIds.has(node.id)).length,
        edges: after.edges.filter((edge) => !beforeEdgeIds.has(edge.id)).length,
        issues: issues.length,
      },
      generated,
      counts: groups,
    };
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
    if (!artifact) throw new Error('Unknown Home Graph artifact.');
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
    const from = this.resolveLinkSource(spaceId, input);
    const target = await this.ensureTarget(spaceId, installationId, input.target);
    const relation = input.relation ?? input.target.relation ?? 'source_for';
    const edge = await this.store.upsertEdge({
      fromKind: from.kind,
      fromId: from.id,
      toKind: target.kind,
      toId: target.id,
      relation,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        ...(input.metadata ?? {}),
        linkStatus: typeof input.metadata?.linkStatus === 'string' ? input.metadata.linkStatus : 'active',
      }),
    });
    return { ok: true, spaceId, edge, target: target.record };
  }

  async unlinkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphLinkResult> {
    const linked = await this.linkKnowledge({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        linkStatus: 'unlinked',
        unlinkedAt: Date.now(),
      },
    });
    return { ...linked, edge: linked.edge };
  }

  async ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    let state = readHomeGraphSearchState(this.store, spaceId);
    if (await this.repairWeakExtractionsForAsk(spaceId, installationId, input.query, state) > 0) {
      state = readHomeGraphSearchState(this.store, spaceId);
    }
    const results = scoreHomeGraphResults(
      input.query,
      state.sources,
      state.nodes,
      state.edges,
      (sourceId) => state.extractionBySourceId.get(sourceId),
      input.limit ?? 8,
    );
    return answerHomeGraphQuery({ store: this.store, semanticService: this.options.semanticService, spaceId, query: input, state, results });
  }

  async reindex(input: HomeGraphSpaceInput = {}): Promise<HomeGraphReindexResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphSearchState(this.store, spaceId);
    const reindex = await reindexHomeGraphSources({
      spaceId,
      sources: state.sources,
      extractionBySourceId: state.extractionBySourceId,
      artifactStore: this.artifactStore,
      extract: (source, artifact) => this.extractArtifact(source, artifact, spaceId, installationId),
    });
    const linked = await this.autoLinkExistingSources(spaceId, installationId);
    const semantic = await this.options.semanticService?.reindex({
      knowledgeSpaceId: spaceId,
      sourceIds: state.sources.map((source) => source.id),
      force: false,
    });
    const qualityIssues = await this.refreshQualityIssues(spaceId, installationId);
    const generated = await refreshAutomaticHomeGraphPages({ store: this.store, artifactStore: this.artifactStore, spaceId, installationId });
    return {
      ...reindex,
      ...(linked.length > 0 ? { linked } : {}),
      ...(semantic ? { semantic } : {}),
      qualityIssues,
      generated,
    };
  }

  private async repairWeakExtractionsForAsk(
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
      8,
    );
    let repaired = 0;
    for (const source of candidates) {
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
    readonly status?: string;
    readonly severity?: string;
    readonly code?: string;
    readonly limit?: number;
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
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    return { ok: true, spaceId, sources: readHomeGraphState(this.store, spaceId).sources.slice(0, Math.max(1, input.limit ?? 100)) };
  }

  async listPages(input: HomeGraphSpaceInput & { readonly limit?: number; readonly includeMarkdown?: boolean } = {}): Promise<HomeGraphPageListResult> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphState(this.store, spaceId);
    return listHomeGraphPages({
      artifactStore: this.artifactStore,
      spaceId,
      sources: state.sources,
      limit: Math.max(1, input.limit ?? 100),
      includeMarkdown: input.includeMarkdown !== false,
    });
  }

  async browse(input: HomeGraphSpaceInput & { readonly limit?: number } = {}): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly nodes: readonly KnowledgeNodeRecord[];
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly issues: readonly KnowledgeIssueRecord[];
  }> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const limit = Math.max(1, input.limit ?? 250);
    const state = readHomeGraphState(this.store, spaceId);
    return {
      ok: true,
      spaceId,
      nodes: state.nodes.slice(0, limit),
      edges: state.edges.slice(0, limit),
      sources: state.sources.slice(0, limit),
      issues: state.issues.slice(0, limit),
    };
  }

  async map(input: HomeGraphMapInput = {}): Promise<HomeGraphMapResult> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    return renderHomeGraphMap(renderHomeGraphState(this.store, spaceId, 'Home Graph Map'), {
      ...input,
      knowledgeSpaceId: spaceId,
    });
  }

  async exportSpace(input: HomeGraphSpaceInput = {}): Promise<HomeGraphExport> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphState(this.store, spaceId);
    return {
      version: 1,
      exportedAt: Date.now(),
      spaceId,
      installationId,
      sources: state.sources,
      nodes: state.nodes,
      edges: state.edges,
      issues: state.issues,
      extractions: state.extractions,
    };
  }

  async importSpace(input: HomeGraphSpaceInput & { readonly data: HomeGraphExport }): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
  }> {
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    const data = input.data;
    let sources = 0;
    let nodes = 0;
    let edges = 0;
    let issues = 0;
    let extractions = 0;
    for (const source of data.sources ?? []) {
      await this.store.upsertSource({ ...source, metadata: buildHomeGraphMetadata(spaceId, installationId, source.metadata) });
      sources += 1;
    }
    for (const node of data.nodes ?? []) {
      await this.store.upsertNode({ ...node, metadata: buildHomeGraphMetadata(spaceId, installationId, node.metadata) });
      nodes += 1;
    }
    for (const edge of data.edges ?? []) {
      await this.store.upsertEdge({ ...edge, metadata: buildHomeGraphMetadata(spaceId, installationId, edge.metadata) });
      edges += 1;
    }
    for (const issue of data.issues ?? []) {
      await this.store.upsertIssue({ ...issue, metadata: buildHomeGraphMetadata(spaceId, installationId, issue.metadata) });
      issues += 1;
    }
    for (const extraction of data.extractions ?? []) {
      await this.store.upsertExtraction({ ...extraction, metadata: buildHomeGraphMetadata(spaceId, installationId, extraction.metadata) });
      extractions += 1;
    }
    return { ok: true, spaceId, imported: { sources, nodes, edges, issues, extractions } };
  }

  private async ingestCreatedArtifact(input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly artifact: ArtifactDescriptor;
    readonly title?: string;
    readonly sourceUri?: string;
    readonly sourceType: KnowledgeSourceType;
    readonly tags: readonly string[];
    readonly target?: HomeGraphKnowledgeTarget;
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
    void this.enrichAndImproveSource(source.id, input.spaceId).catch(() => {});
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
    try {
      const record = this.artifactStore.getRecord(artifact.id);
      if (!record) return undefined;
      const { buffer } = await this.artifactStore.readContent(artifact.id);
      const extracted = await extractKnowledgeArtifact(record, buffer);
      const existing = this.store.getExtractionBySourceId(source.id);
      return this.store.upsertExtraction({
        id: existing?.id ?? `hg-extract-${source.id.replace(/^hg-src-/, '')}`,
        sourceId: source.id,
        artifactId: artifact.id,
        extractorId: extracted.extractorId,
        format: extracted.format,
        title: extracted.title,
        summary: extracted.summary,
        excerpt: extracted.excerpt,
        sections: extracted.sections,
        links: extracted.links,
        estimatedTokens: extracted.estimatedTokens,
        structure: extracted.structure,
        metadata: buildHomeGraphMetadata(spaceId, installationId, extracted.metadata),
      });
    } catch {
      return undefined;
    }
  }

  private async autoLinkExistingSources(
    spaceId: string,
    installationId: string,
  ): Promise<readonly HomeGraphAutoLinkResult[]> {
    const state = readHomeGraphState(this.store, spaceId);
    const extractionBySourceId = new Map(state.extractions.map((extraction) => [extraction.sourceId, extraction]));
    return autoLinkHomeGraphSources({
      store: this.store,
      spaceId,
      installationId,
      sources: state.sources,
      extractionBySourceId,
      state,
    });
  }

  private async upsertHomeNode(
    spaceId: string,
    installationId: string,
    input: HomeGraphSnapshotInput,
  ): Promise<KnowledgeNodeRecord> {
    return this.store.upsertNode({
      id: homeGraphNodeId(spaceId, 'ha_home', input.homeId ?? installationId),
      kind: 'ha_home',
      slug: `${spaceId.replace(/[^a-z0-9]+/gi, '-')}-home`,
      title: input.title ?? 'Home Assistant',
      summary: 'Home Assistant installation captured in the GoodVibes Home Graph.',
      aliases: [installationId],
      confidence: 100,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: { installationId, objectKind: 'home', objectId: input.homeId ?? installationId },
      }),
    });
  }

  private async upsertSnapshotObjects(
    spaceId: string,
    installationId: string,
    input: HomeGraphSnapshotInput,
    homeNodeId: string,
    sourceId: string,
  ): Promise<HomeGraphSyncResult['counts']> {
    const counts = {
      entities: 0,
      devices: 0,
      areas: 0,
      automations: 0,
      scripts: 0,
      scenes: 0,
      labels: 0,
      integrations: 0,
    };
    const upsertGroup = async (kind: Parameters<typeof buildHomeGraphNodeInput>[2], objects: readonly HomeGraphObjectInput[] | undefined) => {
      let count = 0;
      for (const rawObject of objects ?? []) {
        const object = normalizeHomeGraphObjectInput(kind, rawObject);
        const nodeInput = buildHomeGraphNodeInput(spaceId, installationId, kind, object);
        const node = await this.store.upsertNode({ ...nodeInput, sourceId, confidence: 90 });
        await this.store.upsertEdge({
          fromKind: 'node',
          fromId: node.id,
          toKind: 'node',
          toId: homeNodeId,
          relation: 'source_for',
          metadata: buildHomeGraphMetadata(spaceId, installationId),
        });
        await this.linkSnapshotObjectRelations(spaceId, installationId, node, object);
        if (node.kind === 'ha_integration') {
          await upsertIntegrationDocumentationCandidates(this.store, spaceId, installationId, node, object);
        }
        count += 1;
      }
      return count;
    };
    counts.areas = await upsertGroup('area', input.areas);
    counts.integrations = await upsertGroup('integration', input.integrations);
    counts.devices = await upsertGroup('device', input.devices);
    counts.entities = await upsertGroup('entity', input.entities);
    counts.automations = await upsertGroup('automation', input.automations);
    counts.scripts = await upsertGroup('script', input.scripts);
    counts.scenes = await upsertGroup('scene', input.scenes);
    counts.labels = await upsertGroup('label', input.labels);
    return counts;
  }

  private async linkSnapshotObjectRelations(
    spaceId: string,
    installationId: string,
    node: KnowledgeNodeRecord,
    object: { readonly deviceId?: string; readonly areaId?: string; readonly integrationId?: string },
  ): Promise<void> {
    if (object.deviceId && node.kind !== 'ha_device') {
      await this.tryLinkNode(spaceId, installationId, node.id, 'belongs_to_device', 'ha_device', object.deviceId);
    }
    if (object.areaId) {
      await this.tryLinkNode(spaceId, installationId, node.id, 'located_in', 'ha_area', object.areaId);
    }
    if (object.integrationId) {
      await this.tryLinkNode(spaceId, installationId, node.id, 'connected_via', 'ha_integration', object.integrationId);
    }
  }

  private async tryLinkNode(
    spaceId: string,
    installationId: string,
    fromId: string,
    relation: string,
    toKind: string,
    toObjectId: string,
  ): Promise<void> {
    const toId = homeGraphNodeId(spaceId, toKind, toObjectId);
    if (!this.store.getNode(toId)) return;
    await this.store.upsertEdge({
      fromKind: 'node',
      fromId,
      toKind: 'node',
      toId,
      relation,
      metadata: buildHomeGraphMetadata(spaceId, installationId),
    });
  }

  private async refreshQualityIssues(spaceId: string, installationId: string): Promise<readonly KnowledgeIssueRecord[]> {
    return refreshHomeGraphQualityIssues(this.store, spaceId, installationId);
  }

  private async enrichSpaceSources(spaceId: string): Promise<void> {
    if (!this.options.semanticService) return;
    const sources = readHomeGraphSearchState(this.store, spaceId).sources;
    await this.options.semanticService.enrichSources(sources, { knowledgeSpaceId: spaceId });
    await this.options.semanticService.selfImprove({ knowledgeSpaceId: spaceId, reason: 'reindex' });
  }

  private async enrichAndImproveSource(sourceId: string, spaceId: string): Promise<void> {
    if (!this.options.semanticService) return;
    await this.options.semanticService.enrichSource(sourceId, { knowledgeSpaceId: spaceId });
    await this.options.semanticService.selfImprove({
      knowledgeSpaceId: spaceId,
      sourceIds: [sourceId],
      reason: 'ingest',
      limit: 12,
    });
  }

  private resolveLinkSource(spaceId: string, input: HomeGraphLinkInput): { readonly kind: 'source' | 'node'; readonly id: string } {
    if (input.sourceId) {
      const source = this.store.getSource(input.sourceId);
      if (!source || !belongsToSpace(source, spaceId)) throw new Error(`Unknown Home Graph source: ${input.sourceId}`);
      return { kind: 'source', id: source.id };
    }
    if (input.nodeId) {
      const node = this.store.getNode(input.nodeId);
      if (!node || !belongsToSpace(node, spaceId)) throw new Error(`Unknown Home Graph node: ${input.nodeId}`);
      return { kind: 'node', id: node.id };
    }
    throw new Error('linkKnowledge requires sourceId or nodeId.');
  }

  private async ensureTarget(spaceId: string, installationId: string, target: HomeGraphKnowledgeTarget): Promise<{
    readonly kind: 'source' | 'node';
    readonly id: string;
    readonly record: KnowledgeSourceRecord | KnowledgeNodeRecord | null;
  }> {
    const ref = targetToReference(target);
    if (ref.kind === 'source') {
      const source = this.store.getSource(ref.id);
      if (!source || !belongsToSpace(source, spaceId)) throw new Error(`Unknown Home Graph source target: ${ref.id}`);
      return { kind: 'source', id: source.id, record: source };
    }
    const existing = this.store.getNode(ref.id);
    if (existing && belongsToSpace(existing, spaceId)) return { kind: 'node', id: existing.id, record: existing };
    const kind = ref.nodeKind ?? nodeKindForHomeGraphObject(target.kind as never);
    const deterministicId = homeGraphNodeId(spaceId, kind, ref.id);
    const deterministic = this.store.getNode(deterministicId);
    if (deterministic && belongsToSpace(deterministic, spaceId)) {
      return { kind: 'node', id: deterministic.id, record: deterministic };
    }
    const nodeInput: KnowledgeNodeUpsertInput = {
      id: ref.id.startsWith('hg-node-') ? ref.id : deterministicId,
      kind,
      slug: `${spaceId.replace(/[^a-z0-9]+/gi, '-')}-${kind}-${target.id.replace(/[^a-z0-9]+/gi, '-')}`,
      title: target.title ?? target.id,
      aliases: [target.id],
      confidence: 60,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: { installationId, objectKind: kind, objectId: target.id },
      }),
    };
    const node = await this.store.upsertNode(nodeInput);
    return { kind: 'node', id: node.id, record: node };
  }
}
function extractionHasSearchableText(extraction: KnowledgeExtractionRecord): boolean {
  const structure = readRecord(extraction.structure);
  return typeof structure.searchText === 'string' && !isUnusableHomeGraphExtractionText(structure.searchText);
}
