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
    expect(answer.answer.gaps).toHaveLength(1);
    expect(answer.answer.gaps[0]?.metadata.knowledgeSpaceId).toBe(concreteSpaceId);
    expect(store.listRefinementTasks(10, { spaceId: concreteSpaceId })
      .filter((task) => task.gapId === answer.answer.gaps?.[0]?.id)).toHaveLength(1);
    expect(store.listRefinementTasks(10, { spaceId: 'homeassistant' })
      .filter((task) => task.gapId === answer.answer.gaps?.[0]?.id)).toHaveLength(0);
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
    expect(answer.answer.refinementTaskIds?.length).toBeGreaterThan(0);
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
    expect(repairSource).toBeDefined();
    expect(tvNode).toBeDefined();
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
    const { isLowValueFeatureOrSpecText } = await import('../packages/sdk/src/_internal/platform/knowledge/semantic/fact-quality.js');

    expect(isLowValueFeatureOrSpecText('4 HDMI ports')).toBe(false);
    expect(isLowValueFeatureOrSpecText('3 USB ports and Ethernet/LAN')).toBe(false);
    expect(isLowValueFeatureOrSpecText('2 x 10W speakers')).toBe(false);
    expect(isLowValueFeatureOrSpecText('18 m (86")')).toBe(true);
    expect(isLowValueFeatureOrSpecText('series_url nano90 product data')).toBe(true);
    expect(isLowValueFeatureOrSpecText('01 x Ethernet RJ45 Audio Audio Speakers 2 x 10W Built-in Subwoofer')).toBe(true);
    expect(isLowValueFeatureOrSpecText('0 Supported Audio Formats TrueHD')).toBe(true);
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

  test('web gap repair escalates targeted searches and caps accepted sources at five', async () => {
    const queries: string[] = [];
    const ingested: Array<{ url: string; metadata?: Record<string, unknown> }> = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          queries.push(request.query);
          const broadResults = [{
            rank: 1,
            url: 'https://example.com/tv-buying-guide',
            title: 'TV buying guide',
            snippet: 'General television advice.',
            domain: 'example.com',
            type: 'organic' as const,
            providerId: 'test-search',
            metadata: {},
          }];
          const targetedResults = ['lg.com', 'manualsnet.com', 'zkelectronics.com', 'fullspecs.net', 'displayspecifications.com', 'tab-tv.com']
            .map((domain, index) => ({
              rank: index + 1,
              url: `https://${domain}/lg-86nano90una-specs-${index}`,
              title: `LG 86NANO90UNA specifications ${index}`,
              snippet: 'LG 86NANO90UNA ports, Bluetooth, HDR, refresh rate, audio, and smart TV specifications.',
              domain,
              type: 'organic' as const,
              providerId: 'test-search',
              metadata: {},
            }));
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: queries.length === 1 ? broadResults : targetedResults,
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
      maxSources: 5,
    });

    const result = await repairer({
      spaceId: 'homeassistant:house',
      query: 'What ports and Bluetooth support does the TV have?',
      gaps: [{
        id: 'gap-ports',
        kind: 'knowledge_gap',
        slug: 'ports-gap',
        title: 'What other input/output ports are present on the LG 86NANO90UNA?',
        summary: 'The manual does not include a complete I/O specification list.',
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
      maxSources: 5,
    });

    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(result?.ingestedSourceIds).toHaveLength(5);
    expect(ingested).toHaveLength(5);
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).checkedSourceLimit).toBe(5);
    expect(Array.isArray((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).searchQueries)).toBe(true);
  });

  test('web gap repair reuses pending official sources as accepted evidence', async () => {
    const ingested: unknown[] = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: [],
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
      query: 'What Bluetooth and ports does the TV have?',
      gaps: [{
        id: 'gap-existing-source',
        kind: 'knowledge_gap',
        slug: 'existing-source-gap',
        title: 'What Bluetooth and port specifications does the LG 86NANO90UNA have?',
        summary: 'The local manual did not include a complete product spec list.',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [{
        id: 'lg-official-source',
        connectorId: 'semantic-gap-repair',
        sourceType: 'url',
        title: 'LG 86NANO90UNA official product specifications',
        canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
        summary: 'Official LG 86NANO90UNA product specifications.',
        tags: ['semantic-gap-repair'],
        status: 'pending',
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

    expect(result?.evidenceSufficient).toBe(true);
    expect(result?.acceptedSourceIds).toEqual(['lg-official-source']);
    expect(result?.ingestedSourceIds).toEqual([]);
    expect(ingested).toHaveLength(0);
    expect(result?.sourceAssessments?.some((entry) => entry.accepted && entry.reasons.includes('already-indexed'))).toBe(true);
  });

  test('self-improvement promotes accepted repair evidence into typed subject facts', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      summary: 'Official LG 86NANO90UNA product specifications.',
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
        searchText: 'LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10 and Dolby Vision support, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, and USB connectivity.',
      },
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-promote',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const passport = await store.upsertNode({
      kind: 'ha_device_passport',
      slug: 'lg-tv-passport',
      title: 'LG webOS Smart TV passport',
      aliases: [],
      confidence: 80,
      metadata: { knowledgeSpaceId: spaceId },
    });
    const integration = await store.upsertNode({
      kind: 'ha_integration',
      slug: 'webostv',
      title: 'LG webOS TV integration',
      aliases: ['webostv'],
      confidence: 80,
      metadata: { knowledgeSpaceId: spaceId },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'official-source-gap',
      title: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the LG 86NANO90UNA have?',
      aliases: [],
      confidence: 75,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'answer',
        sourceIds: [official.id],
        linkedObjectIds: [passport.id, integration.id, device.id],
      },
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
    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'what features does the LG 86NANO90UNA have?',
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(result.closedGaps).toBe(1);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((fact) => fact.metadata.sourceAuthority === 'official-vendor')).toBe(true);
    expect(facts.every((fact) => JSON.stringify(fact.metadata.linkedObjectIds) === JSON.stringify([device.id]))).toBe(true);
    expect(facts.every((fact) => JSON.stringify(fact.metadata.subjectIds) === JSON.stringify([device.id]))).toBe(true);
    expect(facts.every((fact) => fact.metadata.subject === 'LG webOS Smart TV')).toBe(true);
    expect(facts.every((fact) => Array.isArray(fact.metadata.targetHints) && fact.metadata.targetHints.length === 1)).toBe(true);
    expect(store.listEdges().some((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === device.id && edge.relation === 'describes')).toBe(true);
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('120 Hz');
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('evidence');
    expect(answer.answer.text.trim().startsWith('-')).toBe(false);
    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.linkedObjects.map((node) => node.id)).toEqual([device.id]);
    expect(answer.answer.facts.some((fact) => fact.metadata.extractor === 'repair-promotion')).toBe(true);
    expect(answer.answer.facts.some((fact) => fact.title === 'Display and picture specifications')).toBe(true);
    expect(answer.answer.facts.some((fact) => fact.title === 'Smart TV platform and integrations')).toBe(true);
  });

  test('strict Home Graph answers admit repaired sources linked to the subject', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-strict',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const generated = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG webOS Smart TV passport',
      canonicalUri: 'homegraph://passport/lg-tv',
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
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-display-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution, 100/120 Hz refresh rate, HDR10, and Dolby Vision.',
      aliases: ['display', 'picture'],
      status: 'active',
      confidence: 90,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD resolution, 100/120 Hz refresh rate, HDR10, Dolby Vision',
        sourceId: official.id,
        linkedObjectIds: [device.id],
        extractor: 'repair-promotion',
        sourceAuthority: 'official-vendor',
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
      query: 'What refresh rate and HDR features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      strictCandidates: true,
      candidateSourceIds: [generated.id],
      linkedObjects: [device],
    });

    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.sources.map((source) => source.id)).not.toContain(generated.id);
    expect(answer.answer.linkedObjects.map((node) => node.id)).toEqual([device.id]);
    expect(answer.answer.facts.map((entry) => entry.id)).toContain(fact.id);
    const returnedFact = answer.answer.facts.find((entry) => entry.id === fact.id);
    expect(returnedFact?.subject).toBe('LG webOS Smart TV');
    expect(returnedFact?.subjectIds).toEqual([device.id]);
    expect(returnedFact?.linkedObjectIds).toEqual([device.id]);
    expect(returnedFact?.targetHints?.[0]).toMatchObject({ id: device.id, kind: 'ha_device', title: 'LG webOS Smart TV' });
    expect(returnedFact?.metadata.targetHints).toEqual(returnedFact?.targetHints);
  });

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
        await new Promise((resolve) => setTimeout(resolve, 150));
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
    expect(seed.answer.gaps.length).toBeGreaterThan(0);

    const background = semantic.selfImprove({
      knowledgeSpaceId: spaceId,
      gapIds: seed.answer.gaps.map((gap) => gap.id),
      force: true,
      maxRunMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    expect(answer.answer.facts.length).toBeGreaterThan(0);
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

    expect(facts.length).toBeGreaterThan(0);
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
    expect(facts.length).toBeGreaterThan(0);
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
      llm: new SlowKnowledgeLlm(40),
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
    expect(result.enriched).toBeLessThan(5);
    expect(result.skipped).toBeGreaterThan(0);
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

class WeakFeatureAnswerLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    if (input.purpose !== 'knowledge-answer-synthesis') return null;
    return {
      answer: 'The supplied evidence identifies the TV as having an LCD screen.',
      confidence: 10,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

class ForegroundRepairLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string; readonly prompt?: string }): Promise<unknown | null> {
    if (input.purpose === 'knowledge-semantic-enrichment') {
      return {
        summary: 'LG 86NANO90UNA product specifications.',
        entities: [],
        facts: [{
          kind: 'feature',
          title: 'NanoCell 4K feature set',
          summary: 'The TV supports NanoCell 4K, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.',
          evidence: 'NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer',
          confidence: 92,
        }],
        relations: [],
        gaps: [],
      };
    }
    if (input.purpose === 'knowledge-answer-synthesis') {
      const prompt = input.prompt ?? '';
      if (prompt.includes('NanoCell 4K')) {
        return {
          answer: 'The LG 86NANO90UNA feature set includes NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.',
          confidence: 90,
          usedSourceIds: [],
          usedNodeIds: [],
          gaps: [],
        };
      }
      return {
        answer: 'The evidence only identifies the device as an LG webOS Smart TV.',
        confidence: 0,
        usedSourceIds: [],
        usedNodeIds: [],
        gaps: [{
          question: 'What are the complete features and specifications for LG 86NANO90UNA?',
          reason: 'The current evidence lacks product feature/specification details.',
          severity: 'info',
        }],
      };
    }
    return null;
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

class SlowKnowledgeLlm implements KnowledgeSemanticLlm {
  constructor(private readonly delayMs: number) {}

  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (input.purpose !== 'knowledge-semantic-enrichment') return null;
    return {
      summary: 'Slow semantic extraction.',
      entities: [],
      facts: [{
        kind: 'feature',
        title: 'HDMI support',
        summary: 'The device supports HDMI.',
        evidence: 'supports HDMI',
        confidence: 80,
      }],
      relations: [],
      gaps: [],
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
