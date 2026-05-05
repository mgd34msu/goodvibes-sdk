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

describe('semantic knowledge/wiki enrichment: answer quality', () => {
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
      title: 'Deterministic manual',
      canonicalUri: 'manual://deterministic',
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

    expect(enriched?.facts.map((fact) => fact.title)).toContain('controller includes local control mode');
    expect(enriched?.wikiPage?.kind).toBe('wiki_page');
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text.trim().startsWith('-')).toBe(false);
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
        'Use a certified cable with the HDMI logo attached or the screen may not display.',
        'External Devices Supported USB to Serial SERVICE ONLY.',
        '0 Yes Smart Phone Connectivity.',
        '1HDMI Audio Return Channel.',
        '1 ports.',
        '1 features such as ALLM or 4K/120 over HDMI.',
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
    expect(factText).not.toContain('certified cable');
    expect(factText).not.toContain('USB to Serial');
    expect(factText).not.toContain('Smart Phone Connectivity');
    expect(factText).not.toContain('1HDMI');
    expect(factText).not.toContain('1 ports');
    expect(factText).not.toContain('ALLM or 4K/120');
  });

  test('strict candidate answers use canonical facts linked by secondary source ids and support edges', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'living-room-tv',
      title: 'Living Room TV',
      aliases: ['LG TV'],
      status: 'active',
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const official = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA official manual',
      canonicalUri: 'manual://official-lg-tv',
      tags: ['manual'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    const secondary = await store.upsertSource({
      connectorId: 'web',
      sourceType: 'url',
      title: 'LG 86NANO90UNA secondary specifications',
      canonicalUri: 'https://example.test/lg-86nano90una',
      tags: ['specifications'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-display-canonical-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution, HDR10, and Dolby Vision.',
      aliases: ['display'],
      status: 'active',
      confidence: 88,
      sourceId: secondary.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD resolution, HDR10, Dolby Vision',
        sourceId: secondary.id,
        sourceIds: [official.id, secondary.id],
        subjectIds: [device.id],
        linkedObjectIds: [device.id],
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: official.id,
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
      query: 'what display features does the living room tv have?',
      includeSources: true,
      includeLinkedObjects: true,
      linkedObjects: [device],
      strictCandidates: true,
      candidateSourceIds: [official.id],
      autoRepairGaps: false,
    });

    expect(answer.answer.sources.map((source) => source.id)).toEqual([official.id]);
    expect(answer.answer.facts.map((entry) => entry.id)).toContain(fact.id);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('matching sources');
  });

  test('semantic re-enrichment detaches superseded shared fact support without staling other sources', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const official = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Official display manual',
      canonicalUri: 'manual://official-display',
      tags: ['manual'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain', sourceRank: 1 },
      },
    });
    const secondary = await store.upsertSource({
      connectorId: 'web',
      sourceType: 'url',
      title: 'Superseded display page',
      canonicalUri: 'https://example.test/display',
      tags: ['display'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'shared-display-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution and Dolby Vision.',
      aliases: ['display'],
      status: 'active',
      confidence: 90,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD resolution, Dolby Vision',
        sourceId: official.id,
        sourceIds: [official.id, secondary.id],
      },
    });
    for (const source of [official, secondary]) {
      await store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: fact.id,
        relation: 'supports_fact',
        metadata: { knowledgeSpaceId: spaceId },
      });
    }
    await store.upsertExtraction({
      sourceId: secondary.id,
      extractorId: 'test',
      format: 'text',
      excerpt: 'This page now contains a general historical overview and no current device specifications or capabilities.',
      structure: { searchText: 'This page now contains a general historical overview and no current device specifications or capabilities.' },
    });

    await semantic.enrichSource(secondary.id, { force: true, knowledgeSpaceId: spaceId });

    const updatedFact = store.getNode(fact.id);
    const secondarySupport = store.listEdges().find((edge) => (
      edge.fromKind === 'source'
      && edge.fromId === secondary.id
      && edge.toKind === 'node'
      && edge.toId === fact.id
      && edge.relation === 'supports_fact'
    ));
    expect(updatedFact?.status).toBe('active');
    expect(updatedFact?.sourceId).toBe(official.id);
    expect(updatedFact?.metadata.sourceIds).toEqual([official.id]);
    expect(secondarySupport?.weight).toBe(0);
    expect(secondarySupport?.metadata.deleted).toBe(true);
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

  test('base knowledge ask treats homeassistant as a namespace alias', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [{ id: 'tv', name: 'Living Room TV', model: 'MODEL-1' }],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Living Room TV manual',
      body: 'The Living Room TV supports Dolby Vision and includes four HDMI ports.',
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'what features does the living room tv have?',
      includeSources: true,
    });

    expect(answer.spaceId).toBe('homeassistant');
    expect(answer.answer.sources.map((source) => source.title)).toContain('Living Room TV manual');
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).toContain('four HDMI ports');
  });

  test('base Home Assistant alias ask suppresses unrelated broad facts', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [
        { id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'bravia', name: 'BRAVIA XBR-55X850B TV', manufacturer: 'Sony', model: 'XBR-55X850B' },
        { id: 'router', name: 'Storage Router', manufacturer: 'GL.iNet', model: 'MT6000' },
      ],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'LG TV feature sheet',
      body: 'The LG 86NANO90UNA TV has 4K NanoCell display, HDR10, Dolby Vision, HDMI eARC, and webOS smart TV features.',
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Router network notes',
      body: 'Smart TV users can stream Plex from this NAS, but the GL.iNet MT6000 has Wi-Fi 6 routing, NAS storage shares, WireGuard VPN, firewall rules, and Ethernet services.',
      target: { kind: 'device', id: 'router', relation: 'has_manual' },
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Sony BRAVIA XBR feature sheet',
      body: 'The Sony XBR-55X850B TV has Triluminos display, Motionflow processing, and BRAVIA smart TV apps.',
      target: { kind: 'device', id: 'bravia', relation: 'has_manual' },
    });
    await semantic.reindex({ knowledgeSpaceId: homeAssistantKnowledgeSpaceId('house'), force: true });

    const answer = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const text = [
      answer.answer.text,
      ...answer.answer.sources.map((source) => source.title ?? ''),
      ...answer.answer.linkedObjects.map((node) => node.title),
      ...answer.answer.facts.map((fact) => `${fact.title} ${fact.summary ?? ''}`),
    ].join('\n');

    expect(answer.answer.linkedObjects.map((node) => node.title)).toContain('LG webOS Smart TV');
    expect(text).toContain('Dolby Vision');
    expect(text).not.toContain('WireGuard');
    expect(text).not.toContain('NAS storage');
    expect(text).not.toContain('firewall');
    expect(text).not.toContain('Sony');
    expect(text).not.toContain('BRAVIA');
  });

  test('base Home Assistant alias does not invent a linked object for a generic device ask', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [
        { id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'router', name: 'Storage Router', manufacturer: 'GL.iNet', model: 'MT6000' },
      ],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'LG TV feature sheet',
      body: 'The LG 86NANO90UNA TV has 4K NanoCell display and Dolby Vision.',
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Router feature sheet',
      body: 'The GL.iNet MT6000 router has Wi-Fi 6 and WireGuard VPN.',
      target: { kind: 'device', id: 'router', relation: 'has_manual' },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'what features does the device have?',
      includeLinkedObjects: true,
    });

    expect(answer.answer.linkedObjects).toHaveLength(0);
  });

  test('base Home Assistant alias stores answer-gap refinement in the concrete installation space', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, {
      llm: new GapRepairAnswerLlm(),
      gapRepairer: async () => ({ searched: true, ingestedSourceIds: [], skippedUrls: [] }),
    });
    const snapshotService = new HomeGraphService(store, artifactStore);
    await snapshotService.syncSnapshot({
      installationId: 'house',
      devices: [{ id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.ingestNote({
      installationId: 'house',
      title: 'LG TV setup note',
      body: 'The LG webOS Smart TV is installed in Home Assistant.',
      target: { kind: 'device', id: 'tv', relation: 'source_for' },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const concreteSpaceId = homeAssistantKnowledgeSpaceId('house');

    expect(answer.spaceId).toBe('homeassistant');
    expect(answer.answer.refinement?.status).toBe('active');
    const concreteTasks = store.listRefinementTasks(10, { spaceId: concreteSpaceId });
    expect(concreteTasks).toHaveLength(1);
    expect(answer.answer.refinementTaskIds).toEqual([concreteTasks[0]!.id]);
    const gap = store.getNode(concreteTasks[0]!.gapId);
    expect(gap?.metadata.knowledgeSpaceId).toBe(concreteSpaceId);
    expect(answer.answer.refinementTaskIds).toContain(concreteTasks[0]!.id);
    expect(store.listRefinementTasks(10, { spaceId: 'homeassistant' })
      .filter((task) => task.gapId === concreteTasks[0]!.gapId)).toHaveLength(0);
  });

  test('broad feature asks create gaps when only weak generated profile evidence matches', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new WeakFeatureAnswerLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [{ id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(answer.answer.gaps?.some((gap) => (
      gap.summary?.includes('source-backed feature or specification facts')
    ))).toBe(true);
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

  test('Home Graph ask repairs concrete feature gaps from repaired sources', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, {
      llm: new ForegroundRepairLlm(),
      gapRepairer: async (request) => {
        const source = await store.upsertSource({
          connectorId: 'semantic-gap-repair',
          sourceType: 'url',
          title: 'LG 86NANO90UNA product specifications',
          canonicalUri: 'https://example.test/lg-86nano90una-specs',
          tags: ['semantic-gap-repair', 'tv'],
          status: 'indexed',
          metadata: {
            knowledgeSpaceId: request.spaceId,
            sourceDiscovery: {
              purpose: 'semantic-gap-repair',
              linkedObjectIds: request.linkedObjects.map((node) => node.id),
            },
          },
        });
        await store.upsertExtraction({
          sourceId: source.id,
          extractorId: 'test-html',
          format: 'html',
          structure: {
            searchText: 'LG 86NANO90UNA features include NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.',
          },
          metadata: { knowledgeSpaceId: request.spaceId },
        });
        return {
          searched: true,
          query: request.query,
          ingestedSourceIds: [source.id],
          skippedUrls: [],
        };
      },
    });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [{ id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const tvNode = store.listNodes(100).find((node) => node.title === 'LG webOS Smart TV');

    expect(answer.answer.text).toContain('NanoCell 4K');
    expect(answer.answer.refinementTaskIds).toHaveLength(1);
    await waitFor(() => store.listEdges().some((edge) => edge.relation === 'repairs_gap'), 500);
    const repaired = await service.ask({
      installationId: 'house',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const repairSource = repaired.answer.sources.find((source) => source.title === 'LG 86NANO90UNA product specifications');
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });

    expect(repaired.answer.text).toContain('NanoCell 4K');
    expect(repairSource).not.toBeUndefined(); // presence-only: repairSource returned
    expect(tvNode).not.toBeUndefined(); // presence-only: tvNode found
    expect(store.listEdges().some((edge) => (
      edge.fromKind === 'source'
      && edge.fromId === repairSource?.id
      && edge.toKind === 'node'
      && edge.toId === tvNode?.id
      && edge.relation === 'source_for'
    ))).toBe(true);
    expect(page.markdown).toContain('LG 86NANO90UNA product specifications');
    expect(page.markdown).toContain('Verified Device Facts');
    expect(page.markdown).toContain('Display and picture specifications');
    expect(page.markdown).not.toContain('manual/source');
  });

  test('cold Home Graph ask waits for accepted repair source promotion before returning', async () => {
    const { store, artifactStore } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    let officialSourceId = '';
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async (request) => {
        const source = await store.upsertSource({
          connectorId: 'semantic-gap-repair',
          sourceType: 'url',
          title: 'LG 86NANO90UNA official specifications',
          canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
          sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
          tags: ['semantic-gap-repair', 'tv'],
          status: 'indexed',
          metadata: {
            knowledgeSpaceId: request.spaceId,
            sourceDiscovery: {
              purpose: 'semantic-gap-repair',
              linkedObjectIds: request.linkedObjects.map((node) => node.id),
              trustReason: 'official-vendor-domain, model:86NANO90UNA',
              sourceRank: 1,
            },
          },
        });
        officialSourceId = source.id;
        // replaced race-prone setTimeout(..., 120) with an
        // awaited call so the extraction is committed before the gapRepairer returns.
        // The ask() timeout (30 s) is the only deadline that now matters.
        await store.upsertExtraction({
          sourceId: source.id,
          extractorId: 'web',
          format: 'html',
          structure: {
            searchText: 'LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, 2 x 10W speakers, and Game Optimizer.',
          },
          metadata: { knowledgeSpaceId: request.spaceId },
        });
        return {
          searched: true,
          evidenceSufficient: true,
          acceptedSourceIds: [source.id],
          ingestedSourceIds: [],
          skippedUrls: [],
        };
      },
    });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [{ id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      includeConfidence: true,
      timeoutMs: 30_000,
    });
    const base = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      includeConfidence: true,
      timeoutMs: 30_000,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });

    expect(officialSourceId).not.toBe('');
    expect(answer.answer.gaps).toHaveLength(0);
    expect(answer.answer.sources[0]?.id).toBe(officialSourceId);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toEqual(['LG webOS Smart TV']);
    expect(answer.answer.facts.map((fact) => fact.title)).toContain('Display and picture specifications');
    expect(answer.answer.facts.every((fact) => fact.linkedObjectIds?.length === 1)).toBe(true);
    expect(answer.answer.refinement?.status).toBe('repaired');
    expect(answer.answer.refinement?.acceptedSourceIds).toContain(officialSourceId);
    expect(answer.answer.refinement?.promotedFactCount).toBe(answer.answer.facts.length);
    expect(answer.answer.refinement?.pageRefreshRequested).toBe(true);
    expect(answer.answer.refinement?.pageRefreshed).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).toContain('120 Hz');
    expect(base.answer.gaps).toHaveLength(0);
    expect(base.answer.sources[0]?.id).toBe(officialSourceId);
    expect(base.answer.linkedObjects.map((node) => node.title)).toEqual(['LG webOS Smart TV']);
    expect(base.answer.facts.every((fact) => fact.linkedObjectIds?.length === 1)).toBe(true);
    expect(page.markdown).toContain('LG 86NANO90UNA official specifications');
    expect(page.markdown).toContain('Verified Device Facts');
    expect(page.markdown).toContain('2 x 10W');
    expect(page.markdown).not.toContain('0 source(s)');
    expect(page.markdown).not.toContain('manual/source');
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
        'Crutchfield SpeakerCompare gives you a sense of equal-power and equal-volume speaker differences.',
        'Shake the Magic Remote to make the pointer appear on the screen.',
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
    expect(answer.answer.text).toContain('HDMI ARC/eARC');
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
    expect(answerText).not.toContain('SpeakerCompare');
    expect(answerText).not.toContain('equal-power');
    expect(answerText).not.toContain('pointer appear');
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

  test('renders synthesized prose from usable facts without falling back to raw snippets', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-tv-refresh-rate',
      title: 'Native refresh rate',
      summary: 'The TV supports a native 120 Hz refresh rate.',
      aliases: ['120 Hz'],
      confidence: 92,
      sourceId: source.id,
      metadata: {
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: source.id,
        value: '120 Hz',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: fact.id,
      relation: 'supports_fact',
      metadata: {},
    });

    const answer = await semantic.answer({ query: 'what refresh rate does the LG 86NANO90UNA have?', includeSources: true });

    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).not.toContain('Available source-backed details');
    expect(answer.answer.text).toContain('120 Hz');
    expect(answer.answer.text.trim().startsWith('-')).toBe(false);
  });

  test('renders synthesized prose from matched evidence even before facts are extracted', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA product page',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      summary: 'LG 86NANO90UNA has NanoCell 4K display, webOS, HDR10, Dolby Vision, and 120 Hz support.',
      tags: ['semantic-gap-repair', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA has NanoCell 4K display, webOS, HDR10, Dolby Vision, and 120 Hz support.',
      },
    });

    const answer = await semantic.answer({ query: 'what features does the LG 86NANO90UNA have?', includeSources: true });

    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text.trim().startsWith('-')).toBe(false);
    expect(answer.answer.text).toContain('NanoCell');
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).toContain('120 Hz');
  });

  test('renders specific single-category support answers from evidence instead of source placeholders', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official HDR specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG official specifications list HDR10, Dolby Vision, HLG, and Filmmaker Mode.',
      },
    });

    const answer = await semantic.answer({ query: 'Does the LG 86NANO90UNA support Dolby Vision?', includeSources: true });

    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('matching sources');
    expect(answer.answer.text).not.toContain('semantic-gap-repair');
  });

  test('feature fact quality keeps legitimate port facts and rejects broken fragments', async () => {
    const { isLowValueFeatureOrSpecText } = await import('../packages/sdk/src/platform/knowledge/semantic/fact-quality.js');

    expect(isLowValueFeatureOrSpecText('4 HDMI ports')).toBe(false);
    expect(isLowValueFeatureOrSpecText('3 USB ports and Ethernet/LAN')).toBe(false);
    expect(isLowValueFeatureOrSpecText('2 x 10W speakers')).toBe(false);
    expect(isLowValueFeatureOrSpecText('18 m (86")')).toBe(true);
    expect(isLowValueFeatureOrSpecText('series_url nano90 product data')).toBe(true);
    expect(isLowValueFeatureOrSpecText('01 x Ethernet RJ45 Audio Audio Speakers 2 x 10W Built-in Subwoofer')).toBe(true);
    expect(isLowValueFeatureOrSpecText('0 Supported Audio Formats TrueHD')).toBe(true);
    expect(isLowValueFeatureOrSpecText('AMD Freesync Premium and HGiG mode… AMD Freesync Premium and HGiG mode for smoother gameplay')).toBe(true);
    expect(isLowValueFeatureOrSpecText('Selected Features Nano Cell Technology and webOS marketing copy')).toBe(true);
    expect(isLowValueFeatureOrSpecText('Amazon affiliate ranking system and latest price comparison')).toBe(true);
    expect(isLowValueFeatureOrSpecText('HDR10 historical background introduced by the Consumer Technology Association')).toBe(true);
    expect(isLowValueFeatureOrSpecText('Compatibility line 40W/WF:20W/10W per Channel from a source table')).toBe(true);
    expect(isLowValueFeatureOrSpecText('Motion interpolation TruMotion 240 motion interpolation TruMotion 240 for smoother scenes')).toBe(true);
    expect(isLowValueFeatureOrSpecText('Input and output ports: HDMI, USB, Ethernet, optical audio, RF antenna, and RS-232C/external control.')).toBe(false);
    expect(isLowValueFeatureOrSpecText('Audio capabilities: 2 x 10W speakers with 10W per channel.')).toBe(false);
    expect(isLowValueFeatureOrSpecText('RS-232C external control setup command table for SERVICE ONLY')).toBe(true);
  });

  test('feature answers still report a gap when prose is not backed by persisted concrete facts', async () => {
    const { answerNeedsFeatureGap } = await import('../packages/sdk/src/platform/knowledge/semantic/answer-quality.js');
    const { store } = createStores();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-gap-backed-by-facts',
      title: 'LG webOS Smart TV',
      aliases: ['LG 86NANO90UNA'],
      confidence: 90,
      metadata: { manufacturer: 'LG', model: '86NANO90UNA' },
    });

    expect(answerNeedsFeatureGap({
      query: 'What features does the LG 86NANO90UNA have?',
      text: 'It has a 4K NanoCell display, HDR10, Dolby Vision, webOS, HDMI, USB, Wi-Fi, Bluetooth, and 2 x 10W speakers.',
      facts: [],
      sources: [source],
      linkedObjects: [device],
    })).toBe(true);

    const facts = await Promise.all(['Display and picture specifications', 'Input and output ports', 'Audio capabilities'].map((title, index) => store.upsertNode({
      kind: 'fact',
      slug: `lg-tv-backed-fact-${index}`,
      title,
      summary: `${title}: 4K UHD resolution, HDMI inputs, USB ports, Wi-Fi, Bluetooth, and 2 x 10W speakers.`,
      aliases: [],
      confidence: 90,
      sourceId: source.id,
      metadata: {
        semanticKind: 'fact',
        factKind: index === 1 ? 'specification' : 'feature',
        sourceId: source.id,
        subjectIds: [device.id],
        linkedObjectIds: [device.id],
      },
    })));

    expect(answerNeedsFeatureGap({
      query: 'What features does the LG 86NANO90UNA have?',
      text: 'It has a 4K NanoCell display, HDR10, Dolby Vision, webOS, HDMI, USB, Wi-Fi, Bluetooth, and 2 x 10W speakers.',
      facts,
      sources: [source],
      linkedObjects: [device],
    })).toBe(false);
  });

  test('base Home Assistant alias does not return generic device facts without a subject', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      devices: [
        { id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'app', name: 'Home Assistant App Example', manufacturer: 'Home Assistant', model: 'App' },
      ],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Home Assistant app feature note',
      body: 'The app supports dashboards, automations, and notifications.',
      target: { kind: 'device', id: 'app', relation: 'source_for' },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: 'homeassistant',
      query: 'What features does the device have?',
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(answer.answer.sources).toHaveLength(0);
    expect(answer.answer.linkedObjects).toHaveLength(0);
    expect(answer.answer.facts).toHaveLength(0);
    expect(answer.answer.gaps).toHaveLength(0);
    expect(answer.answer.text).toContain('No knowledge matched');
  });

});
