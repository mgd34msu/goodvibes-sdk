import { describe, expect, test } from 'bun:test';
import {
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  HomeGraphService,
  KnowledgeSemanticService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import {
  BoilerplateAnswerLlm,
  FakeKnowledgeLlm,
  ForegroundRepairLlm,
  GapRepairAnswerLlm,
  OrderedHomeGraphAskLlm,
  SlowKnowledgeLlm,
  WeakFeatureAnswerLlm,
  createStores,
  waitFor,
} from './_helpers/knowledge-semantic-fixtures.js';

describe('semantic knowledge/wiki enrichment: runtime bounds', () => {
  test('scheduled self-improvement repairs intrinsic device gaps without waiting for Ask', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async (request) => {
        calls.push(request);
        const source = await store.upsertSource({
          connectorId: 'semantic-gap-repair',
          sourceType: 'url',
          title: 'LG 86NANO90UNA product specifications',
          canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
          tags: ['semantic-gap-repair'],
          status: 'indexed',
          metadata: {
            knowledgeSpaceId: spaceId,
            sourceDiscovery: { purpose: 'semantic-gap-repair' },
          },
        });
        await store.upsertExtraction({
          sourceId: source.id,
          extractorId: 'test-web',
          format: 'html',
          structure: {
            searchText: 'LG 86NANO90UNA specifications include an 86-inch 4K NanoCell display, Dolby Vision HDR, HDR10, 120 Hz refresh rate, webOS smart TV features, Wi-Fi, Bluetooth, HDMI eARC, FreeSync VRR, ATSC tuner support, and 2 x 10W speakers.',
          },
          metadata: { knowledgeSpaceId: spaceId },
        });
        return {
          searched: true,
          query: 'LG 86NANO90UNA product specifications',
          ingestedSourceIds: [source.id],
          skippedUrls: [],
          sourceAssessments: [{
            url: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
            title: 'LG 86NANO90UNA product specifications',
            domain: 'www.lg.com',
            rank: 1,
            confidence: 95,
            reasons: ['subject:LG 86NANO90UNA'],
            trustReason: 'official vendor result',
            accepted: true,
          }],
        };
      },
    });
    const manual = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA safety manual',
      canonicalUri: 'manual://lg-tv-limited',
      tags: ['manual', 'tv'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: manual.id,
      toKind: 'node',
      toId: device.id,
      relation: 'has_manual',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, reason: 'scheduled' });
    const gap = store.listNodes(100).find((node) => node.kind === 'knowledge_gap' && node.metadata.gapKind === 'intrinsic_features');
    const task = store.listRefinementTasks(10, { spaceId })[0];

    expect(result.createdGaps).toBe(1);
    expect(result.repairableGaps).toBe(1);
    expect(result.searched).toBe(1);
    expect(task).toBeDefined();
    expect(result.taskIds).toContain(task?.id);
    expect(calls).toHaveLength(1);
    expect(gap?.title).toContain('complete features and specifications');
    expect(store.listEdges().some((edge) => edge.relation === 'repairs_gap' && edge.toId === gap?.id)).toBe(true);
    expect(task?.state).toBe('closed');
    expect(task?.subjectTitle).toContain('LG');
    expect(task?.trace.some((entry) => entry.state === 'evaluating' && JSON.stringify(entry.data).includes('sourceAssessments'))).toBe(true);
  });

  test('self-improvement defers run-budget failures instead of leaving dead failed tasks', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => {
        throw new Error('Semantic gap repair exceeded its run budget.');
      },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-budget',
      title: 'LG webOS Smart TV',
      aliases: [],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'budget-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      aliases: [],
      confidence: 75,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        linkedObjectIds: [device.id],
      },
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true, maxRunMs: 5 });
    const task = store.listRefinementTasks(10, { spaceId })[0];
    const updatedGap = store.getNode(gap.id);

    expect(result.blockedGaps).toBe(1);
    expect(task?.state).toBe('blocked');
    expect(task?.blockedReason).toContain('deferred');
    expect(typeof task?.nextRepairAttemptAt).toBe('number');
    expect(updatedGap?.metadata.repairStatus).toBe('deferred');
    expect(typeof updatedGap?.metadata.nextRepairAttemptAt).toBe('number');
  });

  test('self-improvement does not treat unrelated repair sources as repairing every subject gap', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async (request) => {
        calls.push(request);
        return { searched: true, ingestedSourceIds: [], skippedUrls: [], reason: 'no sources in test' };
      },
    });
    const manual = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-limited',
      tags: ['manual', 'tv'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const priorRepairSource = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG support article for a different question',
      canonicalUri: 'https://www.lg.com/support/example',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { purpose: 'semantic-gap-repair' },
      },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: manual.id,
      toKind: 'node',
      toId: device.id,
      relation: 'has_manual',
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: priorRepairSource.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'feature-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA LG webOS Smart TV?',
      aliases: [],
      confidence: 75,
      sourceId: manual.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        sourceIds: [manual.id],
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: device.id,
      toKind: 'node',
      toId: gap.id,
      relation: 'has_gap',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });

    expect(result.repairableGaps).toBe(1);
    expect(result.searched).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('self-improvement suppresses non-applicable gaps before external search', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async (request) => {
        calls.push(request);
        return { searched: true, ingestedSourceIds: [], skippedUrls: [] };
      },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'living-room-tv',
      title: 'Living Room TV',
      aliases: [],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, batteryPowered: false, batteryType: 'none' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'battery-gap',
      title: 'What battery does the Living Room TV use?',
      aliases: [],
      confidence: 70,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: device.id,
      toKind: 'node',
      toId: gap.id,
      relation: 'has_gap',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const updated = store.getNode(gap.id);

    expect(result.suppressedGaps).toBe(1);
    expect(calls).toHaveLength(0);
    expect(updated?.status).toBe('stale');
    expect(updated?.metadata.repairStatus).toBe('not_applicable');
  });

  test('self-improvement caps broad refinement runs and reports truncation metadata', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    for (let i = 0; i < 60; i += 1) {
      await store.upsertNode({
        kind: 'knowledge_gap',
        slug: `broad-gap-${i}`,
        title: `What are the complete features and specifications for device ${i}?`,
        aliases: [],
        confidence: 75,
        metadata: {
          knowledgeSpaceId: spaceId,
          semanticKind: 'gap',
          gapKind: 'intrinsic_features',
        },
      });
    }

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, limit: 500, reason: 'manual' });

    expect(result.candidateGaps).toBe(60);
    expect(result.requestedLimit).toBe(500);
    expect(result.effectiveLimit).toBe(24);
    expect(result.scannedGaps).toBe(24);
    expect(result.processedGaps).toBe(24);
    expect(result.truncated).toBe(true);
    expect(result.blockedGaps).toBe(24);
  });

  test('overlapping broad self-improvement reports the requested limit in coalesced metadata', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    let releaseRepair!: () => void;
    const blockedRepair = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => {
        await blockedRepair;
        return { searched: true, ingestedSourceIds: [], skippedUrls: [] };
      },
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-overlap-limit',
      tags: ['manual'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-overlap-limit',
      title: 'LG webOS Smart TV',
      aliases: [],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'coalesced-limit-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      aliases: [],
      confidence: 75,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        sourceIds: [source.id],
        linkedObjectIds: [device.id],
      },
    });

    const first = semantic.selfImprove({ knowledgeSpaceId: spaceId, limit: 5, reason: 'manual' });
    await waitFor(() => store.listRefinementTasks(10, { spaceId }).some((task) => task.state === 'searching'), 250);
    const second = await semantic.selfImprove({ knowledgeSpaceId: spaceId, limit: 500, reason: 'manual' });
    releaseRepair();
    await first;

    expect(second.requestedLimit).toBe(500);
    expect(second.effectiveLimit).toBe(0);
    expect(second.coalesced).toBe(true);
    expect(second.skippedGaps).toBe(1);
    expect(second.truncated).toBe(true);
    expect(second.budgetExhausted).toBe(true);
  });

  test('self-improvement recovers stale no-repairer blocks when a repairer is configured', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const manual = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-no-repairer',
      tags: ['manual'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG webOS Smart TV',
      aliases: [],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: manual.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const gaps = [];
    for (let i = 0; i < 2; i += 1) {
      const gap = await store.upsertNode({
        kind: 'knowledge_gap',
        slug: `no-repairer-gap-${i}`,
        title: `What are the complete features and specifications for LG 86NANO90UNA ${i}?`,
        aliases: [],
        confidence: 75,
        sourceId: manual.id,
        metadata: {
          knowledgeSpaceId: spaceId,
          semanticKind: 'gap',
          gapKind: 'intrinsic_features',
          sourceIds: [manual.id],
          linkedObjectIds: [device.id],
        },
      });
      gaps.push(gap);
      await store.upsertEdge({
        fromKind: 'node',
        fromId: device.id,
        toKind: 'node',
        toId: gap.id,
        relation: 'has_gap',
        metadata: { knowledgeSpaceId: spaceId },
      });
    }

    await new KnowledgeSemanticService(store).selfImprove({ knowledgeSpaceId: spaceId, limit: 2 });
    expect(store.listRefinementTasks(10, { spaceId })
      .filter((task) => /No semantic gap repairer is configured/i.test(task.blockedReason ?? ''))).toHaveLength(2);

    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => ({ searched: true, ingestedSourceIds: [], skippedUrls: [] }),
    });
    await semantic.selfImprove({ knowledgeSpaceId: spaceId, limit: 1 });

    expect(store.listRefinementTasks(10, { spaceId })
      .filter((task) => /No semantic gap repairer is configured/i.test(task.blockedReason ?? ''))).toHaveLength(0);
    for (const gap of gaps) {
      expect(store.getNode(gap.id)?.metadata.repairStatus).not.toBe('no_repairer');
    }
  });

  test('self-improvement does not stack overlapping repair runs', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    let releaseRepair!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async (request) => {
        calls.push(request);
        await repairStarted;
        return { searched: true, ingestedSourceIds: [], skippedUrls: [] };
      },
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-overlap',
      tags: ['manual'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-overlap',
      title: 'LG webOS Smart TV',
      aliases: [],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'overlap-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      aliases: [],
      confidence: 75,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        sourceIds: [source.id],
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: device.id,
      toKind: 'node',
      toId: gap.id,
      relation: 'has_gap',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const first = semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    await waitFor(() => calls.length === 1, 250);
    const second = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    releaseRepair();
    await first;

    expect(calls).toHaveLength(1);
    expect(second.skippedGaps).toBe(1);
    expect(second.truncated).toBe(false);
    expect(second.budgetExhausted).toBe(false);
  });

  test('semantic reindex honors a run budget instead of processing every LLM source inline', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store, {
      llm: new SlowKnowledgeLlm(120),
      maxLlmSourcesPerReindex: 10,
      maxReindexRunMs: 20,
    });
    for (let i = 0; i < 5; i += 1) {
      const source = await store.upsertSource({
        connectorId: 'manual',
        sourceType: 'manual',
        title: `Manual ${i}`,
        canonicalUri: `manual://slow-${i}`,
        tags: ['manual'],
        status: 'indexed',
      });
      await store.upsertExtraction({
        sourceId: source.id,
        extractorId: 'test',
        format: 'text',
        structure: { searchText: `Manual ${i} says the device supports HDMI and Bluetooth features.` },
      });
    }

    const result = await semantic.reindex();

    expect(result.scanned).toBe(5);
    expect(result.enriched).toBe(1);
    expect(result.skipped).toBe(4);
  });

  test('provider-backed semantic LLM calls time out and abort provider requests', async () => {
    let aborted = false;
    const semanticLlm = createProviderBackedKnowledgeSemanticLlm({
      getCurrentModel: () => ({ id: 'model', provider: 'test' }),
      getForModel: () => ({
        name: 'test',
        models: ['model'],
        chat: ({ signal }: { readonly signal?: AbortSignal }) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve({
              content: '',
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: 'error',
            });
          }, { once: true });
        }),
      }),
    } as never, { timeoutMs: 25 });

    const startedAt = Date.now();
    const result = await semanticLlm.completeText({
      purpose: 'test-timeout',
      systemPrompt: 'test',
      prompt: 'test',
      timeoutMs: 25,
    });

    expect(result).toBeNull();
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
