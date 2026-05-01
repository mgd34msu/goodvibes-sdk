import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import {
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  HomeGraphService,
  KnowledgeSemanticService,
  homeAssistantKnowledgeSpaceId,
  type KnowledgeSemanticLlm,
} from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('semantic knowledge/wiki enrichment', () => {
  test('persists source-grounded facts, wiki pages, and synthesized answers', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Device manual',
      canonicalUri: 'manual://device',
      tags: ['manual'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      summary: 'Device manual.',
      excerpt: 'The device supports Dolby Vision and includes four HDMI ports.',
      sections: ['Features'],
      structure: { searchText: 'The device supports Dolby Vision and includes four HDMI ports.' },
    });

    const enriched = await semantic.enrichSource(source.id);
    const answer = await semantic.answer({ query: 'what features does the device have?', includeSources: true });
    const nodes = store.listNodes(100);

    expect(enriched?.facts.map((fact) => fact.title)).toContain('HDMI inputs');
    expect(nodes.some((node) => node.kind === 'wiki_page' && String(node.metadata.markdown ?? '').includes('Dolby Vision'))).toBe(true);
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('four HDMI ports');
    expect(answer.answer.sources.map((entry) => entry.id)).toContain(source.id);
    expect(answer.answer.facts.some((fact) => fact.title === 'HDMI inputs')).toBe(true);
  });

  test('falls back to deterministic facts when no LLM is configured', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Fallback manual',
      canonicalUri: 'manual://fallback',
      tags: ['manual'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      excerpt: 'The controller includes local control mode. The controller supports Wi-Fi configuration. The controller has USB-C power.',
      sections: ['Features'],
      structure: {
        searchText: 'The controller includes local control mode. The controller supports Wi-Fi configuration. The controller has USB-C power.',
      },
    });

    const enriched = await semantic.enrichSource(source.id);
    const answer = await semantic.answer({ query: 'controller features', includeSources: true });

    expect(enriched?.facts.length).toBeGreaterThan(0);
    expect(enriched?.wikiPage?.kind).toBe('wiki_page');
    expect(answer.answer.synthesized).toBe(false);
    expect(answer.answer.text).toContain('local control mode');
  });

  test('strict candidate answers exclude unrelated sources and off-intent facts', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const tv = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG TV manual',
      canonicalUri: 'manual://tv',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: tv.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: [
        'The TV supports Dolby Vision.',
        'Ultra High Speed HDMI cables are optional extras and may be purchased separately.',
        'HDMI and USB devices should have bezels less than 10 mm so they fit the TV port.',
        'Use a USB extension cable if the USB flash drive does not fit your TV USB port.',
        'Fasten the stand screws to prevent the TV from overturning during setup.',
        'Product specifications or contents of this manual may be changed without prior notice.',
        'Recommended HDMI cable types (3 m (9.',
        'New features may be added to this TV in the future.',
        'Magic Remote Control buttons ▲ ▼ ◄ ► may vary depending upon model.',
        'The Magic Remote batteries may be low.',
        'Refer all servicing to qualified personnel and contact customer service for repair.',
        'Clean the TV with a dry cloth.',
        'This remote uses infrared light and must be pointed toward the remote control sensor on the TV.',
        'Use an extension cable that supports USB if the USB flash drive does not fit into your TV USB port.',
        'Use a platform or cabinet that is strong and large enough to support the TV securely.',
        'The items supplied with your product may vary depending upon the model.',
        'Warning: do not use uncertified HDMI cables.',
        'The TV supports Magic Remote MR20GA when the wireless module includes Bluetooth.',
        ].join(' '),
      },
    });
    const plug = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Kasa plug manual',
      canonicalUri: 'manual://plug',
      tags: ['manual', 'plug'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: plug.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: 'The smart plug features energy monitoring and scheduling.',
      },
    });
    await semantic.reindex({ force: true });

    const answer = await semantic.answer({
      query: 'what features does the TV have?',
      candidateSourceIds: [tv.id],
      strictCandidates: true,
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(answer.answer.sources.map((source) => source.id)).toEqual([tv.id]);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('Kasa');
    expect(answer.answer.text).not.toContain('uncertified HDMI cables');
    expect(answer.answer.text).not.toContain('prior notice');
    expect(answer.answer.text).not.toContain('items supplied');
    expect(answer.answer.facts.every((fact) => fact.sourceId === tv.id)).toBe(true);
    expect(answer.answer.linkedObjects).toHaveLength(0);
    const factText = answer.answer.facts.map((fact) => `${fact.title} ${fact.summary ?? ''}`).join('\n');
    expect(factText).not.toContain('prior notice');
    expect(factText).not.toContain('optional extras');
    expect(factText).not.toContain('bezels');
    expect(factText).not.toContain('USB extension cable');
    expect(factText).not.toContain('overturning');
    expect(factText).not.toContain('Recommended HDMI cable types');
    expect(factText).not.toContain('New features may be added');
    expect(factText).not.toContain('qualified personnel');
    expect(factText).not.toContain('dry cloth');
    expect(factText).not.toContain('remote control sensor');
    expect(factText).not.toContain('USB flash drive does not fit');
    expect(factText).not.toContain('platform or cabinet');
    expect(factText).not.toContain('MR20GA');
  });

  test('Home Graph ask uses the shared semantic layer instead of raw snippets', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'tv', name: 'Living Room TV', areaId: 'living-room', model: 'MODEL-1' }],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Living Room TV manual',
      body: 'The Living Room TV supports Dolby Vision and includes four HDMI ports.',
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the living room tv have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });

    expect(answer.spaceId).toBe(homeAssistantKnowledgeSpaceId('house'));
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).toContain('four HDMI ports');
    expect(answer.answer.sources.some((source) => source.title === 'Living Room TV manual')).toBe(true);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toEqual(['Living Room TV']);
    expect(answer.answer.linkedObjects.every((node) => typeof node.metadata.semanticKind !== 'string')).toBe(true);
    expect(page.markdown).toContain('Verified Device Facts');
    expect(page.markdown).toContain('HDMI inputs');
  });

  test('Home Graph ask prioritizes answer synthesis before background semantic enrichment', async () => {
    const { store, artifactStore } = createStores();
    const llm = new OrderedHomeGraphAskLlm();
    const semantic = new KnowledgeSemanticService(store, { llm });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'tv', name: 'Living Room TV', areaId: 'living-room', model: 'MODEL-1' }],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Living Room TV manual',
      body: 'The Living Room TV supports Dolby Vision and includes four HDMI ports.',
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });

    llm.calls.length = 0;
    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the living room tv have?',
      includeSources: true,
      includeLinkedObjects: true,
      includeConfidence: true,
    });

    expect(llm.calls[0]).toBe('knowledge-answer-synthesis');
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.gaps?.map((gap) => gap.title)).toContain('What are the complete TV feature specifications?');
  });

  test('Home Graph semantic ask does not let unrelated semantic pages become object anchors', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [
        { id: 'tv', name: 'LG webOS Smart TV', areaId: 'living-room', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'plug', name: 'Kasa Smart Wi-Fi Plug', areaId: 'living-room', manufacturer: 'Kasa', model: 'KP125M' },
      ],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'LG 86NANO90UNA manual',
      body: [
        'The LG TV supports HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.',
        'Ultra High Speed HDMI cables are optional extras and may be purchased separately.',
        'Fasten the stand screws to prevent the TV from overturning during setup.',
        'Recommended HDMI cable types (3 m (9.',
        'New features may be added to this TV in the future.',
        'Magic Remote Control buttons ▲ ▼ ◄ ► may vary depending upon model.',
        'The Magic Remote batteries may be low.',
        'REFER TO QUALIFIED SERVICE PERSONNEL.',
        'This remote uses infrared light and must be pointed toward the remote control sensor on the TV.',
        'However, if the device does not support it, it may not work properly.',
        'In that case, change the TV HDMI Ultra HD Deep Color setting to off.',
        'Refer all servicing to qualified personnel and contact customer service for repair.',
        'Clean the TV with a dry cloth.',
      ].join(' '),
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      body: 'Features include energy monitoring, Matter support, scheduling, and away mode.',
      tags: ['manual', 'plug'],
      target: { kind: 'device', id: 'plug', relation: 'has_manual' },
    });
    await semantic.reindex({
      knowledgeSpaceId: homeAssistantKnowledgeSpaceId('house'),
      force: true,
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });
    const answerText = [
      answer.answer.text,
      ...answer.answer.sources.map((source) => source.title ?? ''),
      ...answer.answer.linkedObjects.map((node) => node.title),
      ...answer.answer.facts.map((fact) => `${fact.title} ${fact.summary ?? ''}`),
      page.markdown,
    ].join('\n');

    expect(answer.answer.text).toContain('HDR10');
    expect(answer.answer.text).toContain('HDMI eARC');
    expect(answer.answer.sources.map((source) => source.title)).toEqual(['LG 86NANO90UNA manual']);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toContain('LG webOS Smart TV');
    expect(answer.answer.linkedObjects.every((node) => typeof node.metadata.semanticKind !== 'string')).toBe(true);
    expect(answerText).not.toContain('Kasa');
    expect(answerText).not.toContain('energy monitoring');
    expect(answerText).not.toContain('optional extras');
    expect(answerText).not.toContain('overturning');
    expect(answerText).not.toContain('Recommended HDMI cable types');
    expect(answerText).not.toContain('New features may be added');
    expect(answerText).not.toContain('qualified personnel');
    expect(answerText).not.toContain('dry cloth');
    expect(answerText).not.toContain('batteries may be low');
    expect(answerText).not.toContain('QUALIFIED SERVICE PERSONNEL');
    expect(answerText).not.toContain('infrared light');
    expect(answerText).not.toContain('remote control sensor');
    expect(answerText).not.toContain('may not work properly');
    expect(answerText).not.toContain('setting to off');
    expect(answerText).not.toContain('platform or cabinet');
    expect(answerText).not.toContain('▲');
  });

  test('feature answer synthesis strips provider-returned setup boilerplate', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new BoilerplateAnswerLlm() });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'manual://lg-tv',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: [
          'The TV supports HDMI Ultra HD Deep Color with 4K at 100/120 Hz on ports 3 and 4.',
          'The TV supports True HD, Dolby Digital, Dolby Digital Plus, and PCM HDMI audio formats.',
          'The wireless module supports IEEE 802.11a/b/g/n/ac wireless LAN and Bluetooth.',
          'Use an extension cable if the USB flash drive does not fit into your TV USB port.',
          'New features may be added to this TV in the future.',
          'Use a platform or cabinet that is strong and large enough to support the TV securely.',
        ].join(' '),
      },
    });

    const answer = await semantic.answer({
      query: 'what features does the LG TV have?',
      candidateSourceIds: [source.id],
      strictCandidates: true,
      includeSources: true,
      includeConfidence: true,
    });

    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('HDMI Ultra HD Deep Color');
    expect(answer.answer.text).toContain('wireless LAN');
    expect(answer.answer.text).not.toContain('USB flash drive does not fit');
    expect(answer.answer.text).not.toContain('New features may be added');
    expect(answer.answer.text).not.toContain('platform or cabinet');
  });

  test('web gap repair ingests at least two distinct sources for answer gaps', async () => {
    const ingested: Array<{ url: string; title?: string; tags?: readonly string[]; metadata?: Record<string, unknown> }> = [];
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
                url: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
                title: 'LG 86NANO90UNA specs',
                snippet: 'LG 86NANO90UNA product specifications.',
                domain: 'www.lg.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
              {
                rank: 2,
                url: 'https://www.displayspecifications.com/en/model/example',
                title: 'LG 86NANO90UNA display specifications',
                snippet: 'Display and input specifications for LG 86NANO90UNA.',
                domain: 'www.displayspecifications.com',
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
      query: 'what features does the TV have?',
      gaps: [{
        id: 'gap-1',
        kind: 'knowledge_gap',
        slug: 'gap',
        title: 'What are the full TV display, smart platform, audio, and port specifications?',
        summary: 'The manual does not include the product spec sheet.',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [{
        id: 'manual-source',
        connectorId: 'artifact',
        sourceType: 'manual',
        title: 'LG-86NANO90UNA-manual.pdf',
        canonicalUri: 'file://manual.pdf',
        tags: ['manual', 'tv'],
        status: 'indexed',
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
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
    expect(result?.ingestedSourceIds).toEqual(['source-1', 'source-2']);
    expect(result?.sourceAssessments?.[0]?.confidence).toBeGreaterThanOrEqual(70);
    expect(ingested).toHaveLength(2);
    expect(ingested[0]?.metadata?.sourceDiscovery).toBeDefined();
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).confidence).toBeGreaterThanOrEqual(70);
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).confidenceReasons).toContain('model:86NANO90UNA');
    expect(ingested[0]?.tags).toContain('semantic-gap-repair');
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
    await semantic.answer({ query: 'what features does the TV have?', includeSources: true });
    await waitFor(() => calls.length >= 1, 250);

    expect(calls).toHaveLength(1);
  });

  test('answer-triggered refinement is queued without blocking the answer', async () => {
    const { store } = createStores();
    const calls: unknown[] = [];
    const semantic = new KnowledgeSemanticService(store, {
      llm: new GapRepairAnswerLlm(),
      gapRepairer: async (request) => {
        calls.push(request);
        await new Promise((resolve) => setTimeout(resolve, 500));
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
    expect(answer.answer.refinementTaskIds?.length).toBeGreaterThan(0);
    await waitFor(() => calls.length === 1, 250);
    await waitFor(() => store.listRefinementTasks(10, { state: 'blocked' }).length === 1, 1_000);
  });

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

class FakeKnowledgeLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    if (input.purpose === 'knowledge-semantic-enrichment') {
      return {
        summary: 'Manual describing display and input features.',
        entities: [{ title: 'Device', kind: 'device', aliases: ['TV'], summary: 'The described device.', confidence: 80 }],
        facts: [
          {
            kind: 'feature',
            title: 'Dolby Vision support',
            summary: 'The device supports Dolby Vision.',
            evidence: 'supports Dolby Vision',
            confidence: 92,
            labels: ['display'],
            targetHints: ['Device'],
          },
          {
            kind: 'specification',
            title: 'HDMI inputs',
            value: 'four HDMI ports',
            summary: 'The device includes four HDMI ports.',
            evidence: 'includes four HDMI ports',
            confidence: 94,
            labels: ['hdmi'],
            targetHints: ['Device'],
          },
        ],
        relations: [],
        gaps: [],
        wikiPage: {
          title: 'Device knowledge page',
          markdown: '# Device\n\n## Features\n\n- Supports Dolby Vision.\n- Includes four HDMI ports.\n',
        },
      };
    }
    return {
      answer: 'The device supports Dolby Vision and has four HDMI ports.',
      confidence: 91,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

class GapRepairAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: 'The manual only confirms Magic Remote Bluetooth compatibility.',
      confidence: 45,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [{
        question: 'What are the complete display, smart platform, audio, and port specifications?',
        reason: 'The manual is not a complete product specification sheet.',
        severity: 'info',
      }],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

class OrderedHomeGraphAskLlm implements KnowledgeSemanticLlm {
  readonly calls: string[] = [];

  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    this.calls.push(input.purpose);
    if (input.purpose === 'knowledge-answer-synthesis') {
      return {
        answer: 'The TV supports Dolby Vision and includes four HDMI ports. The available evidence does not include the full feature specification list.',
        confidence: 82,
        usedSourceIds: [],
        usedNodeIds: [],
        gaps: [{
          question: 'What are the complete TV feature specifications?',
          reason: 'The linked manual excerpt does not provide every display, audio, network, and app feature.',
          severity: 'info',
        }],
      };
    }
    return {
      summary: 'Manual describing display and input features.',
      entities: [],
      facts: [{
        kind: 'feature',
        title: 'Dolby Vision support',
        summary: 'The TV supports Dolby Vision.',
        evidence: 'supports Dolby Vision',
        confidence: 90,
      }],
      relations: [],
      gaps: [],
      wikiPage: {
        title: 'Living Room TV knowledge page',
        markdown: '# Living Room TV\n\n- Supports Dolby Vision.\n',
      },
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

class BoilerplateAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: [
        '- The TV supports HDMI Ultra HD Deep Color, including 4K at 100/120 Hz on ports 3 and 4.',
        '- It supports True HD, Dolby Digital, Dolby Digital Plus, and PCM HDMI audio formats.',
        '- It includes IEEE 802.11a/b/g/n/ac wireless LAN and Bluetooth support.',
        '- Use an extension cable if the USB flash drive does not fit into your TV USB port.',
        '- New features may be added to this TV in the future.',
        '- Use a platform or cabinet that is strong and large enough to support the TV securely.',
      ].join('\n'),
      confidence: 84,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [{
        question: 'What are the full display, smart platform, audio, and port specifications for this TV?',
        reason: 'The manual is a safety/reference manual and does not include a complete product feature sheet.',
        severity: 'info',
      }],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

function createStores(): { readonly store: KnowledgeStore; readonly artifactStore: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-semantic-'));
  tmpRoots.push(root);
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  };
}
