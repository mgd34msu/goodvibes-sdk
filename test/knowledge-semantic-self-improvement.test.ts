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
import { settleEvents } from './_helpers/test-timeout.js';

describe('semantic knowledge/wiki enrichment: self-improvement', () => {
  test('strict answers keep official sources linked by graph edges even without source discovery metadata', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-edge-source-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const generated = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG webOS Smart TV passport',
      canonicalUri: 'homegraph://passport/lg-edge-source-tv',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId, homeGraphGeneratedPage: true },
    });
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: {
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    const secondary = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA secondary specifications',
      canonicalUri: 'https://example.test/lg-86nano90una',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertExtraction({
      sourceId: official.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG official specifications list NanoCell display technology, 4K UHD resolution, HDR10, Dolby Vision, HLG, and 100/120 Hz refresh rate.',
      },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-secondary-display-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution and 100/120 Hz refresh rate.',
      aliases: ['display'],
      status: 'active',
      confidence: 80,
      sourceId: secondary.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD resolution, 100/120 Hz refresh rate',
        sourceId: secondary.id,
        linkedObjectIds: [device.id],
        extractor: 'repair-promotion',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: official.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId, linkedBy: 'semantic-gap-repair' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: secondary.id,
      toKind: 'node',
      toId: fact.id,
      relation: 'supports_fact',
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: device.id,
      relation: 'describes',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'What HDR and display features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      strictCandidates: true,
      candidateSourceIds: [generated.id],
      linkedObjects: [device],
    });

    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.sources.map((source) => source.id)).toContain(secondary.id);
    expect(answer.answer.linkedObjects.map((node) => node.id)).toEqual([device.id]);
    expect(answer.answer.facts.map((entry) => entry.id)).toContain(fact.id);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('matching sources');
  });

  test('foreground answers wait for overlapping repair work before returning stale gaps', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-overlap-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const generated = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG webOS Smart TV passport',
      canonicalUri: 'homegraph://passport/lg-overlap-tv',
      summary: 'Generated passport for LG 86NANO90UNA.',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId, homeGraphGeneratedPage: true },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: generated.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    await store.upsertExtraction({
      sourceId: official.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA specifications include NanoCell 4K display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS, Wi-Fi, and Bluetooth.',
      },
      metadata: { knowledgeSpaceId: spaceId },
    });
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => {
        await settleEvents(150);
        return {
          searched: true,
          evidenceSufficient: true,
          acceptedSourceIds: [official.id],
          ingestedSourceIds: [],
          skippedUrls: [],
        };
      },
    });
    const seed = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'What features does the LG 86NANO90UNA have?',
      includeSources: true,
      includeLinkedObjects: true,
      linkedObjects: [device],
      strictCandidates: true,
      candidateSourceIds: [generated.id],
      autoRepairGaps: false,
    });
    expect(seed.answer.gaps.map((gap) => gap.title)).toContain('What features does the LG 86NANO90UNA have?');

    const background = semantic.selfImprove({
      knowledgeSpaceId: spaceId,
      gapIds: seed.answer.gaps.map((gap) => gap.id),
      force: true,
      maxRunMs: 5_000,
    });
    await settleEvents(10);
    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'What features does the LG 86NANO90UNA have?',
      includeSources: true,
      includeLinkedObjects: true,
      linkedObjects: [device],
      strictCandidates: true,
      candidateSourceIds: [generated.id],
      timeoutMs: 30_000,
    });
    await background;

    expect(answer.answer.gaps).toHaveLength(0);
    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.facts.map((fact) => fact.title)).toContain('Display and picture specifications');
    expect(answer.answer.facts.every((fact) => fact.linkedObjectIds?.includes(device.id))).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('matching sources');
  });

  test('semantic enrichment inherits source subject links from graph edges', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-edge-enrichment-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: {
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    await store.upsertExtraction({
      sourceId: official.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'The LG 86NANO90UNA supports HDMI eARC, HDR10, Dolby Vision, and webOS smart TV features.',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: official.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });

    await semantic.enrichSource(official.id);
    const facts = store.listNodes(100).filter((node) => node.kind === 'fact' && node.sourceId === official.id);

    expect(facts.map((fact) => fact.title)).toContain('Display and picture specifications');
    expect(facts.every((fact) => (fact.metadata.linkedObjectIds as string[] | undefined)?.includes(device.id))).toBe(true);
    expect(facts.every((fact) => (fact.metadata.subjectIds as string[] | undefined)?.includes(device.id))).toBe(true);
  });

  test('self-improvement preserves subject links from gap edges when metadata is incomplete', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    await store.upsertExtraction({
      sourceId: official.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS, Wi-Fi, and Bluetooth.',
      },
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-edge-subject',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'edge-only-gap',
      title: 'What features does the LG 86NANO90UNA have?',
      aliases: [],
      confidence: 75,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'answer',
        sourceIds: [official.id],
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
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => ({
        searched: true,
        evidenceSufficient: true,
        acceptedSourceIds: [official.id],
        ingestedSourceIds: [],
        skippedUrls: [],
      }),
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const facts = store.listNodes(100).filter((node) => node.kind === 'fact' && node.metadata.extractor === 'repair-promotion');

    expect(result.closedGaps).toBe(1);
    expect(facts.map((fact) => fact.title)).toContain('Display and picture specifications');
    expect(facts.every((fact) => JSON.stringify(fact.metadata.linkedObjectIds) === JSON.stringify([device.id]))).toBe(true);
    expect(store.listEdges().some((edge) => edge.fromKind === 'source' && edge.fromId === official.id && edge.toKind === 'node' && edge.toId === device.id && edge.relation === 'source_for')).toBe(true);
  });

  test('web gap repair rejects low-confidence search results', async () => {
    const ingested: unknown[] = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: [
              {
                rank: 1,
                url: 'https://example.com/generic-tv-buying-guide',
                title: 'Generic TV buying guide',
                snippet: 'General television features and shopping advice.',
                domain: 'example.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
              {
                rank: 2,
                url: 'https://example.org/hdmi-cables',
                title: 'HDMI cable tips',
                snippet: 'Cable fit and setup guidance.',
                domain: 'example.org',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
            ],
            metadata: {},
          };
        },
      },
      ingestService: {
        async ingestUrl(input) {
          ingested.push(input);
          return { source: { id: `source-${ingested.length}`, status: 'indexed' } };
        },
      },
    });

    const result = await repairer({
      spaceId: 'homeassistant:house',
      query: 'LG 86NANO90UNA full specifications',
      gaps: [{
        id: 'gap-1',
        kind: 'knowledge_gap',
        slug: 'gap',
        title: 'What are the full TV display, smart platform, audio, and port specifications?',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [],
      linkedObjects: [{
        id: 'tv-node',
        kind: 'ha_device',
        slug: 'tv',
        title: 'LG webOS Smart TV',
        aliases: [],
        status: 'active',
        confidence: 90,
        metadata: { knowledgeSpaceId: 'homeassistant:house', manufacturer: 'LG', model: '86NANO90UNA' },
        createdAt: 1,
        updatedAt: 1,
      }],
      facts: [],
    });

    expect(result?.searched).toBe(true);
    expect(result?.ingestedSourceIds).toEqual([]);
    expect(result?.sourceAssessments?.every((entry) => entry.confidence < 70)).toBe(true);
    expect(ingested).toHaveLength(0);
  });

  test('web gap repair can accept high-confidence subject sources without model numbers', async () => {
    const ingested: Array<{ url: string; metadata?: Record<string, unknown> }> = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: [
              {
                rank: 1,
                url: 'https://developers.cloudflare.com/queues/',
                title: 'Cloudflare Queues documentation',
                snippet: 'Cloudflare Queues features, producers, consumers, retries, and dead-letter queues.',
                domain: 'developers.cloudflare.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
              {
                rank: 2,
                url: 'https://developers.cloudflare.com/queues/platform/limits/',
                title: 'Cloudflare Queues limits',
                snippet: 'Cloudflare Queues limits, throughput, retention, and configuration guidance.',
                domain: 'developers.cloudflare.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
              {
                rank: 3,
                url: 'https://blog.cloudflare.com/queues-ga/',
                title: 'Cloudflare Queues announcement',
                snippet: 'Cloudflare Queues background and product capabilities.',
                domain: 'blog.cloudflare.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
            ],
            metadata: {},
          };
        },
      },
      ingestService: {
        async ingestUrl(input) {
          ingested.push(input);
          return { source: { id: `cloudflare-source-${ingested.length}`, status: 'indexed' } };
        },
      },
    });

    const result = await repairer({
      spaceId: 'project:cloudflare',
      query: 'Cloudflare Queues capabilities and limits',
      gaps: [{
        id: 'gap-cloudflare-queues',
        kind: 'knowledge_gap',
        slug: 'cloudflare-queues-gap',
        title: 'What are the Cloudflare Queues capabilities and limits?',
        aliases: [],
        status: 'active',
        confidence: 75,
        metadata: { knowledgeSpaceId: 'project:cloudflare' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [],
      linkedObjects: [{
        id: 'service-cloudflare',
        kind: 'service',
        slug: 'cloudflare',
        title: 'Cloudflare',
        aliases: [],
        status: 'active',
        confidence: 90,
        metadata: { knowledgeSpaceId: 'project:cloudflare', entityKind: 'service' },
        createdAt: 1,
        updatedAt: 1,
      }],
      facts: [],
    });

    expect(result?.searched).toBe(true);
    expect(result?.ingestedSourceIds.length).toBeGreaterThanOrEqual(2);
    expect(result?.sourceAssessments?.[0]?.reasons).toContain('subject:Cloudflare');
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).confidenceReasons).toContain('subject:Cloudflare');
  });

  test('semantic gap repair is idempotent once a repair source is linked', async () => {
    const { store } = createStores();
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      llm: new GapRepairAnswerLlm(),
      gapRepairer: async (request) => {
        calls.push(request);
        await store.upsertSource({
          id: 'repair-source',
          connectorId: 'semantic-gap-repair',
          sourceType: 'url',
          title: 'LG 86NANO90UNA repair source',
          canonicalUri: 'https://example.test/lg-tv-specs',
          tags: ['semantic-gap-repair'],
          status: 'indexed',
          metadata: { knowledgeSpaceId: 'default', sourceDiscovery: { purpose: 'semantic-gap-repair' } },
        });
        await store.upsertExtraction({
          sourceId: 'repair-source',
          extractorId: 'test-web',
          format: 'html',
          structure: {
            searchText: 'LG 86NANO90UNA specifications include a NanoCell 4K display, Dolby Vision, HDR10, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, and Game Optimizer.',
          },
          metadata: { knowledgeSpaceId: 'default' },
        });
        return {
          searched: true,
          query: 'lg 86nano90una full specifications',
          ingestedSourceIds: ['repair-source'],
          skippedUrls: [],
        };
      },
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-gap',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG 86NANO90UNA'],
      confidence: 90,
      metadata: { manufacturer: 'LG', model: '86NANO90UNA' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device.id,
      relation: 'has_manual',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: 'The LG TV supports Magic Remote MR20GA when the wireless module includes Bluetooth.',
      },
    });

    await semantic.answer({ query: 'what features does the TV have?', includeSources: true });
    await waitFor(() => store.listEdges().some((edge) => edge.relation === 'repairs_gap'), 250);
    await waitFor(() => store.listNodes(10).some((node) => node.kind === 'knowledge_gap' && node.metadata.repairStatus === 'repaired'), 250);
    const secondAnswer = await semantic.answer({ query: 'what features does the TV have?', includeSources: true });
    await waitFor(() => calls.length >= 1, 250);

    expect(calls).toHaveLength(1);
    expect(secondAnswer.answer.gaps).toHaveLength(0);
    expect(store.listIssues(10).filter((issue) => issue.code === 'knowledge.answer_gap' && issue.status === 'open')).toHaveLength(0);
  });

  test('self-improvement bounds repair-source text waits when accepted sources have no extraction yet', async () => {
    const { store } = createStores();
    const repairSource = await store.upsertSource({
      id: 'repair-source-without-text',
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: 'default',
        sourceDiscovery: {
          purpose: 'semantic-gap-repair',
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    const manual = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-gap',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG 86NANO90UNA'],
      confidence: 90,
      metadata: { manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'lg-tv-features-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      summary: 'Existing evidence lacks a full feature and specification profile.',
      aliases: [],
      confidence: 70,
      sourceId: manual.id,
      metadata: {
        semanticKind: 'gap',
        gapKind: 'answer',
        linkedObjectIds: [device.id],
        sourceIds: [manual.id],
      },
    });
    await store.upsertEdge({ fromKind: 'source', fromId: manual.id, toKind: 'node', toId: device.id, relation: 'has_manual' });
    await store.upsertEdge({ fromKind: 'node', fromId: device.id, toKind: 'node', toId: gap.id, relation: 'has_gap' });
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => ({
        searched: true,
        evidenceSufficient: true,
        acceptedSourceIds: [repairSource.id],
        ingestedSourceIds: [],
        skippedUrls: [],
      }),
    });

    const startedAt = Date.now();
    const result = await semantic.selfImprove({ knowledgeSpaceId: 'default', gapIds: [gap.id], maxRunMs: 5_000 });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.blockedGaps).toBe(1);
    expect(result.promotedFactCount).toBe(0);
    const task = store.listRefinementTasks(10, { spaceId: 'default' })[0];
    expect(task?.state).toBe('blocked');
    expect(task?.nextRepairAttemptAt).toBeGreaterThan(Date.now());
  });

  test('self-improvement promotes extracted repair text before waiting for slow enrichment', async () => {
    const { store } = createStores();
    const repairSource = await store.upsertSource({
      id: 'repair-source-with-rich-text',
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: 'default',
        sourceDiscovery: {
          purpose: 'semantic-gap-repair',
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    await store.upsertExtraction({
      sourceId: repairSource.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA specifications include an 86-inch 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HLG, HDMI eARC, USB ports, Ethernet, Wi-Fi, Bluetooth, webOS smart TV features, Apple AirPlay 2, HomeKit, FreeSync VRR, Game Optimizer, ATSC tuner support, and 2 x 10W speakers.',
      },
      metadata: { knowledgeSpaceId: 'default' },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-rich-repair',
      title: 'LG webOS Smart TV',
      aliases: ['LG 86NANO90UNA'],
      confidence: 90,
      metadata: { manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'lg-tv-rich-features-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      summary: 'Existing evidence lacks a full feature and specification profile.',
      aliases: [],
      confidence: 70,
      metadata: {
        semanticKind: 'gap',
        gapKind: 'answer',
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({ fromKind: 'node', fromId: device.id, toKind: 'node', toId: gap.id, relation: 'has_gap' });
    const semantic = new KnowledgeSemanticService(store, {
      llm: new SlowKnowledgeLlm(2_000),
      gapRepairer: async () => ({
        searched: true,
        evidenceSufficient: true,
        acceptedSourceIds: [repairSource.id],
        ingestedSourceIds: [],
        skippedUrls: [],
      }),
    });

    const startedAt = Date.now();
    const result = await semantic.selfImprove({ knowledgeSpaceId: 'default', gapIds: [gap.id], maxRunMs: 5_000 });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.closedGaps).toBe(1);
    expect(result.promotedFactCount).toBeGreaterThanOrEqual(3);
    expect(store.listNodes(100).filter((node) => node.kind === 'fact' && node.metadata.extractor === 'repair-promotion')).toHaveLength(result.promotedFactCount);
  });

  test('self-improvement promotes already-indexed source facts by linking them to the repair subject', async () => {
    const { store } = createStores();
    const repairSource = await store.upsertSource({
      id: 'indexed-official-source-with-facts',
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: 'default',
        sourceDiscovery: {
          purpose: 'semantic-gap-repair',
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-existing-facts',
      title: 'LG webOS Smart TV',
      aliases: ['LG 86NANO90UNA'],
      confidence: 90,
      metadata: { manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const otherDevice = await store.upsertNode({
      kind: 'ha_device',
      slug: 'sony-tv-existing-facts',
      title: 'Sony BRAVIA TV',
      aliases: ['XBR-55X850B'],
      confidence: 90,
      metadata: { manufacturer: 'Sony', model: 'XBR-55X850B' },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'lg-tv-existing-source-gap',
      title: 'What are the complete features and specifications for LG 86NANO90UNA?',
      summary: 'Existing evidence lacks a full feature and specification profile.',
      aliases: [],
      confidence: 70,
      metadata: {
        semanticKind: 'gap',
        gapKind: 'answer',
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({ fromKind: 'node', fromId: device.id, toKind: 'node', toId: gap.id, relation: 'has_gap' });
    const goodFacts = await Promise.all([
      ['Display and picture specifications', 'Display and picture specifications: 4K UHD resolution, HDR10, Dolby Vision, and 120 Hz refresh rate.'],
      ['Input and output ports', 'Input and output ports: HDMI inputs, HDMI eARC, USB ports, Ethernet, optical audio output, RF antenna input, and RS-232C/external control.'],
      ['Audio capabilities', 'Audio capabilities: 2 x 10W speakers.'],
    ].map(([title, summary], index) => store.upsertNode({
      kind: 'fact',
      slug: `existing-official-lg-fact-${index}`,
      title,
      summary,
      aliases: [],
      confidence: 88,
      sourceId: repairSource.id,
      metadata: {
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: repairSource.id,
      },
    })));
    for (const fact of goodFacts) {
      await store.upsertEdge({ fromKind: 'source', fromId: repairSource.id, toKind: 'node', toId: fact.id, relation: 'supports_fact' });
    }
    const unrelated = await store.upsertNode({
      kind: 'fact',
      slug: 'existing-official-sony-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: Sony XBR-55X850B has a 55-inch 4K display.',
      aliases: [],
      confidence: 88,
      sourceId: repairSource.id,
      metadata: {
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: repairSource.id,
        subjectIds: [otherDevice.id],
        linkedObjectIds: [otherDevice.id],
      },
    });
    await store.upsertEdge({ fromKind: 'source', fromId: repairSource.id, toKind: 'node', toId: unrelated.id, relation: 'supports_fact' });
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => ({
        searched: true,
        evidenceSufficient: true,
        acceptedSourceIds: [repairSource.id],
        ingestedSourceIds: [],
        skippedUrls: [],
      }),
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: 'default', gapIds: [gap.id], maxRunMs: 5_000 });

    expect(result.closedGaps).toBe(1);
    expect(result.promotedFactCount).toBe(3);
    const linkedFacts = goodFacts.map((fact) => store.getNode(fact.id));
    expect(linkedFacts.every((fact) => (fact?.metadata.subjectIds as string[] | undefined)?.includes(device.id))).toBe(true);
    expect(linkedFacts.every((fact) => (fact?.metadata.linkedObjectIds as string[] | undefined)?.includes(device.id))).toBe(true);
    expect(store.getNode(unrelated.id)?.metadata.linkedObjectIds).toEqual([otherDevice.id]);
  });

  test('answer-triggered refinement is queued without blocking the answer', async () => {
    const { store } = createStores();
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      llm: new GapRepairAnswerLlm(),
      gapRepairer: async (request) => {
        calls.push(request);
        await settleEvents(500);
        return {
          searched: true,
          query: 'lg 86nano90una full specifications',
          ingestedSourceIds: [],
          skippedUrls: [],
          reason: 'no sources in test',
        };
      },
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv-answer-gap',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: 'The LG TV supports Magic Remote MR20GA when the wireless module includes Bluetooth.',
      },
    });

    const startedAt = Date.now();
    const answer = await semantic.answer({ query: 'what features does the TV have?', includeSources: true });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(answer.answer.refinementTaskIds).toHaveLength(1);
    await waitFor(() => calls.length === 1, 250);
    await waitFor(() => store.listRefinementTasks(10, { state: 'blocked' }).length === 1, 1_000);
  });

});
