import { describe, expect, test } from 'bun:test';
import { HomeGraphRoutes } from '../packages/sdk/src/platform/daemon/http/home-graph-routes.js';
import {
  HomeGraphService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { answerHomeGraphQuery } from '../packages/sdk/src/platform/knowledge/home-graph/ask.js';
import { reindexHomeGraphSources } from '../packages/sdk/src/platform/knowledge/home-graph/reindex.js';
import { readHomeGraphSearchState } from '../packages/sdk/src/platform/knowledge/home-graph/search.js';
import {
  createCompressedPdfBuffer,
  createHomeGraphService,
  readHomeAssistantEntityId,
  waitFor,
} from './_helpers/homegraph-service-fixtures.js';

describe('Home Graph ask, source repair, and reindex', () => {
  test('ingests notes, links and unlinks targets, and renders device passports', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'entry', name: 'Entry' }],
      devices: [{ id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'entry' }],
      entities: [{
        id: 'binary_sensor.front_door',
        entityId: 'binary_sensor.front_door',
        name: 'Front Door',
        deviceId: 'front-door-sensor',
        areaId: 'entry',
      }],
    });

    const ingested = await service.ingestNote({
      installationId: 'house-1',
      title: 'Front door battery',
      body: 'The front door sensor uses a CR2032 battery.',
      category: 'maintenance',
      target: { kind: 'device', id: 'front-door-sensor', relation: 'has_manual' },
    });
    const ask = await service.ask({ installationId: 'house-1', query: 'CR2032 front door', includeLinkedObjects: true });
    const passport = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'front-door-sensor' });
    const unlinked = await service.unlinkKnowledge({
      installationId: 'house-1',
      sourceId: ingested.source.id,
      target: { kind: 'device', id: 'front-door-sensor', relation: 'has_manual' },
    });
    const browse = await service.browse({ installationId: 'house-1' });

    expect(ingested.source.metadata.knowledgeSpaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(ask.answer.text).toContain('Front door battery');
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('Front Door Sensor');
    expect(passport.markdown).toContain('Front Door Sensor');
    expect(passport.artifact.mimeType).toBe('text/markdown');
    expect(unlinked.edge.metadata.linkStatus).toBe('unlinked');
    expect(browse.edges.some((edge) => edge.id === unlinked.edge.id)).toBe(false);
  });

  test('asks large manual-backed graphs through bounded searchable extraction text', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'living-room-tv', name: 'Living Room TV', areaId: 'living-room' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const manual = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'Living Room TV manual',
      canonicalUri: 'homegraph://house-1/living-room-tv-manual',
      tags: ['homeassistant', 'home-graph', 'manual', 'tv'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: manual.id,
      extractorId: 'test-pdf',
      format: 'pdf',
      title: 'Living Room TV manual',
      summary: 'Television owner manual.',
      excerpt: 'Owner manual feature overview.',
      sections: ['Features'],
      links: [],
      estimatedTokens: 200,
      structure: {
        searchText: 'The TV supports HDR10, HDMI eARC, low latency game mode, filmmaker mode, and voice remote features.',
      },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: manual.id,
      target: { kind: 'device', id: 'living-room-tv', relation: 'has_manual' },
    });

    for (let index = 0; index < 32; index += 1) {
      const source = await store.upsertSource({
        connectorId: 'homeassistant',
        sourceType: 'manual',
        title: `Decoy manual ${index}`,
        canonicalUri: `homegraph://house-1/decoy-${index}`,
        tags: ['homeassistant', 'home-graph', 'manual'],
        status: 'indexed',
        metadata,
      });
      await store.upsertExtraction({
        sourceId: source.id,
        extractorId: 'test-pdf',
        format: 'pdf',
        summary: 'Decoy appliance manual.',
        sections: ['x'.repeat(128 * 1024)],
        links: [],
        estimatedTokens: 50_000,
        structure: { searchText: 'decoy appliance instructions' },
        metadata,
      });
    }

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'what features does the tv have hdr10 earc game mode',
      includeLinkedObjects: true,
    });

    expect(ask.results[0]?.id).toBe(manual.id);
    expect(ask.answer.text).toContain('Living Room TV manual');
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('Living Room TV');
  });

  test('anchors ask results to linked Home Assistant objects instead of generic feature hits', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'living-room-tv', name: 'Living Room TV', areaId: 'living-room' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const manual = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'Living Room Television manual',
      canonicalUri: 'homegraph://house-1/living-room-television-manual',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: manual.id,
      extractorId: 'test-pdf',
      format: 'pdf',
      title: 'Living Room Television manual',
      summary: 'Television owner manual.',
      sections: ['Specifications', 'Picture and sound features'],
      links: [],
      estimatedTokens: 200,
      structure: {
        searchText: 'Picture and sound features include HDR10, HDMI eARC, filmmaker mode, low latency game mode, and voice remote support.',
      },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: manual.id,
      target: { kind: 'device', id: 'living-room-tv', relation: 'has_manual' },
    });

    const unrelatedPlug = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      canonicalUri: 'homegraph://house-1/kasa-plug',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: unrelatedPlug.id,
      extractorId: 'test-html',
      format: 'html',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      summary: 'Keep Track of Your Energy Use.',
      sections: ['Features'],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: 'Features include energy monitoring and Matter support.' },
      metadata,
    });

    const unrelatedTvIntegration = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'url',
      title: 'LG webOS Smart TV integration webostv',
      canonicalUri: 'https://www.home-assistant.io/integrations/webostv/',
      tags: ['homeassistant', 'home-graph', 'integration'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: unrelatedTvIntegration.id,
      extractorId: 'test-html',
      format: 'html',
      title: 'LG webOS Smart TV integration webostv',
      summary: 'Home Assistant integration documentation.',
      sections: ['Features'],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: 'Features include media playback controls for LG webOS Smart TV devices.' },
      metadata,
    });

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'what features does the tv have',
      includeLinkedObjects: true,
    });

    expect(ask.results.map((result) => result.id)).toEqual([manual.id]);
    expect(ask.answer.text).toContain('HDR10');
    expect(ask.answer.text).toContain('HDMI eARC');
    expect(ask.answer.text).not.toContain('Kasa');
    expect(ask.answer.text).not.toContain('webOS');
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('Living Room TV');
  });

  test('does not blend other television objects into singular TV feature asks', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [
        { id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'sony-tv', name: 'BRAVIA XBR-55X850B', manufacturer: 'Sony', model: 'XBR-55X850B' },
      ],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const lgSource = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'url',
      title: 'LG 86NANO90UNA specifications',
      canonicalUri: 'https://example.test/lg-86nano90una',
      tags: ['homeassistant', 'home-graph', 'specifications'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: lgSource.id,
      extractorId: 'test-html',
      format: 'html',
      title: 'LG 86NANO90UNA specifications',
      summary: 'LG NanoCell TV specifications.',
      sections: [],
      links: [],
      estimatedTokens: 200,
      structure: {
        searchText: 'LG 86NANO90UNA smart TV features include NanoCell 4K, HDR10, Dolby Vision, webOS, HDMI eARC, and gaming support.',
      },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: lgSource.id,
      target: { kind: 'device', id: 'lg-tv', relation: 'source_for' },
    });
    const sonySource = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'url',
      title: 'Sony XBR-55X850B specifications',
      canonicalUri: 'https://example.test/sony-xbr-55x850b',
      tags: ['homeassistant', 'home-graph', 'specifications'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: sonySource.id,
      extractorId: 'test-html',
      format: 'html',
      title: 'Sony XBR-55X850B specifications',
      summary: 'Sony BRAVIA TV specifications.',
      sections: [],
      links: [],
      estimatedTokens: 200,
      structure: {
        searchText: 'Sony XBR-55X850B BRAVIA TV features include Triluminos display, Motionflow, HDR, HDMI, and smart TV apps.',
      },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: sonySource.id,
      target: { kind: 'device', id: 'sony-tv', relation: 'source_for' },
    });

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(ask.results.map((result) => result.id)).toEqual([lgSource.id]);
    expect(ask.answer.sources.map((source) => source.title)).toEqual(['LG 86NANO90UNA specifications']);
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('LG webOS Smart TV');
    expect(ask.answer.linkedObjects.map((node) => node.title)).not.toContain('BRAVIA XBR-55X850B');
    expect(ask.answer.text).not.toContain('Sony');
    expect(ask.answer.text).not.toContain('BRAVIA');
  });

  test('filters contaminated Home Graph answer candidates to the singular object scope', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [
        { id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'sony-tv', name: 'BRAVIA XBR-55X850B', manufacturer: 'Sony', model: 'XBR-55X850B' },
        { id: 'google-ai', name: 'Google AI Conversation', manufacturer: 'Google', model: 'gemini-2.5-flash' },
        { id: 'mcp-server', name: 'MCP Server (HTTP Transport)', manufacturer: 'GoodVibes' },
      ],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const sources = [
      {
        target: 'google-ai',
        title: 'Google Gemini 2.5 Flash - docs.oracle.com',
        text: 'Context caching and API feature configuration for Gemini 2.5 Flash.',
      },
      {
        target: 'lg-tv',
        title: 'LG NanoCell 86NANO90UNA specifications',
        text: 'LG 86NANO90UNA smart TV features include NanoCell 4K, HDR10, Dolby Vision, webOS, HDMI eARC, and gaming support.',
      },
      {
        target: 'sony-tv',
        title: 'PDF XBR-55X850B - fullcompass.com',
        text: 'Sony BRAVIA XBR-55X850B TV features include Triluminos display, Motionflow, HDMI, and smart TV apps.',
      },
      {
        target: 'mcp-server',
        title: 'The Complete MCP Experience',
        text: 'Remote MCP server features include streamable HTTP transport and enterprise security.',
      },
    ];
    const sourceRecords = [];
    for (const entry of sources) {
      const source = await store.upsertSource({
        connectorId: 'homeassistant',
        sourceType: 'url',
        title: entry.title,
        canonicalUri: `https://example.test/${entry.target}`,
        tags: ['homeassistant', 'home-graph', 'features'],
        status: 'indexed',
        metadata,
      });
      sourceRecords.push(source);
      await store.upsertExtraction({
        sourceId: source.id,
        extractorId: 'test-html',
        format: 'html',
        title: entry.title,
        summary: entry.text,
        sections: [entry.text],
        links: [],
        estimatedTokens: 200,
        structure: { searchText: entry.text },
        metadata,
      });
      await service.linkKnowledge({
        installationId: 'house-1',
        sourceId: source.id,
        target: { kind: 'device', id: entry.target, relation: 'source_for' },
      });
    }

    const state = readHomeGraphSearchState(store, spaceId);
    const answer = await answerHomeGraphQuery({
      store,
      spaceId,
      query: {
        query: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the TV have?',
        includeSources: true,
        includeLinkedObjects: true,
      },
      state,
      results: sourceRecords.map((source, index) => ({
        kind: 'source' as const,
        id: source.id,
        score: 1_000 - index,
        title: source.title ?? source.id,
        summary: source.summary,
        excerpt: store.getExtractionBySourceId(source.id)?.summary,
        source,
      })),
    });

    const text = [
      answer.answer.text,
      ...answer.answer.sources.map((source) => source.title ?? ''),
      ...answer.answer.linkedObjects.map((node) => node.title),
      ...answer.results.map((result) => result.title),
    ].join('\n');
    expect(answer.results.map((result) => result.id)).toEqual([sourceRecords[1]!.id]);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toEqual(['LG webOS Smart TV']);
    expect(text).toContain('LG');
    expect(text).not.toContain('Sony');
    expect(text).not.toContain('BRAVIA');
    expect(text).not.toContain('Gemini');
    expect(text).not.toContain('MCP');
  });

  test('keeps Home Assistant linked objects from repaired source metadata', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'living-room-tv', name: 'Living Room TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const tvNode = store.listNodes(1_000).find((node) => node.title === 'Living Room TV');
    expect(tvNode?.title).toBe('Living Room TV');
    const repairSource = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA specifications',
      canonicalUri: 'https://example.test/lg-86nano90una-specs',
      tags: ['semantic-gap-repair', 'LG 86NANO90UNA'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: {
          purpose: 'semantic-gap-repair',
          linkedObjectIds: [tvNode!.id],
        },
      },
    });
    await store.upsertExtraction({
      sourceId: repairSource.id,
      extractorId: 'test-html',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA features include 4K NanoCell display, HDR10, Dolby Vision, HLG, eARC, and AMD FreeSync.',
      },
    });

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'what HDR and gaming features does the LG TV have',
      includeLinkedObjects: true,
    });

    expect(ask.results.map((result) => result.id)).toContain(repairSource.id);
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('Living Room TV');
    expect(ask.answer.sources[0]?.sourceId).toBe(repairSource.id);
    expect(ask.answer.sources[0]?.url).toBe('https://example.test/lg-86nano90una-specs');
  });

  test('keeps graph context edges when Home Assistant map filters match leaf entities', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'living-room-tv', name: 'Living Room TV', areaId: 'living-room' }],
      entities: [{
        id: 'media_player.living_room_tv',
        entityId: 'media_player.living_room_tv',
        name: 'Living Room TV',
        deviceId: 'living-room-tv',
        areaId: 'living-room',
      }],
    });
    const tvNode = store.listNodes(100).find((node) => node.title === 'Living Room TV');
    expect(tvNode?.title).toBe('Living Room TV');
    await store.upsertEdge({
      fromKind: 'node',
      fromId: tvNode!.id,
      toKind: 'node',
      toId: tvNode!.id,
      relation: 'connected_via',
      metadata: { knowledgeSpaceId: homeAssistantKnowledgeSpaceId('house-1') },
    });

    const map = await service.map({
      installationId: 'house-1',
      ha: { domains: ['media_player'] },
      includeSources: true,
    });
    const topLevelMap = await service.map({
      installationId: 'house-1',
      domains: ['media_player'],
      includeSources: true,
    });

    expect(map.nodes.some((node) => node.title === 'Living Room TV')).toBe(true);
    expect(topLevelMap.nodeCount).toBe(map.nodeCount);
    expect(topLevelMap.edgeCount).toBe(map.edgeCount);
    expect(map.edges.some((edge) => edge.relation === 'belongs_to_device' || edge.relation === 'located_in')).toBe(true);
    expect(map.edges.every((edge) => typeof edge.source === 'string' && typeof edge.target === 'string')).toBe(true);
    expect(map.edges.some((edge) => typeof edge.sourceTitle === 'string' && typeof edge.targetTitle === 'string')).toBe(true);
    expect(map.edges.every((edge) => edge.source !== edge.target)).toBe(true);
  });

  test('repairs already-uploaded stale stale PDF manual extractions during ask', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'lg-tv', name: 'LG TV', manufacturer: 'LG', model: '86NANO90UNA', areaId: 'living-room' }],
      entities: [{
        entityId: 'media_player.lg_webos_smart_tv',
        name: 'LG webOS Smart TV',
        deviceId: 'lg-tv',
        areaId: 'living-room',
      }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const artifact = await artifactStore.createFromStream({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'lg-86nano90una-manual.pdf',
      stream: [createCompressedPdfBuffer('LG TV features include HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.')],
      metadata,
    });
    const manual = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA manual',
      canonicalUri: 'homegraph://house-1/lg-86nano90una-manual',
      tags: ['homeassistant', 'home-graph', 'manual', 'tv'],
      status: 'indexed',
      artifactId: artifact.id,
      metadata,
    });
    await store.upsertExtraction({
      sourceId: manual.id,
      artifactId: artifact.id,
      extractorId: 'pdf',
      format: 'pdf',
      summary: 'PDF extraction produced limited text; OCR is not used in-core.',
      sections: [],
      links: [],
      estimatedTokens: 1,
      structure: { extractedStringCount: 0 },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: manual.id,
      target: { kind: 'device', id: 'lg-tv', relation: 'has_manual' },
    });
    const unrelatedPlug = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      canonicalUri: 'homegraph://house-1/kasa-plug',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: unrelatedPlug.id,
      extractorId: 'test-html',
      format: 'html',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      summary: 'Keep Track of Your Energy Use.',
      sections: ['Features'],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: 'Features include energy monitoring and Matter support.' },
      metadata,
    });

    const initial = await service.ask({
      installationId: 'house-1',
      query: 'what features does the LG TV have?',
      includeLinkedObjects: true,
    });
    await waitFor(() => store.listExtractions().some((entry) => entry.sourceId === manual.id && entry.extractorId === 'pdfjs'), 500);
    const ask = await service.ask({
      installationId: 'house-1',
      query: 'what features does the LG TV have?',
      includeLinkedObjects: true,
    });

    expect(initial.answer.text).not.toContain('Kasa');
    expect(ask.results.map((result) => result.id)).toEqual([manual.id]);
    expect(ask.answer.text).toContain('HDR10');
    expect(ask.answer.text).toContain('HDMI eARC');
    expect(ask.answer.text).toContain('Magic Remote');
    expect(ask.answer.text).not.toContain('Kasa');
    expect(ask.answer.linkedObjects.map((node) => node.title)).toContain('LG TV');
  });

  test('reindexes already-uploaded Home Graph PDF artifacts without reuploading', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const artifact = await artifactStore.createFromStream({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'lg-tv-manual.pdf',
      stream: [createCompressedPdfBuffer('The uploaded LG TV manual says supported features include Dolby Vision and HDMI eARC.')],
      metadata,
    });
    const manual = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'LG TV manual',
      canonicalUri: 'homegraph://house-1/lg-tv-manual',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      artifactId: artifact.id,
      metadata,
    });
    await store.upsertExtraction({
      sourceId: manual.id,
      artifactId: artifact.id,
      extractorId: 'pdf',
      format: 'pdf',
      summary: 'PDF extraction produced limited text; OCR is not used in-core.',
      sections: [],
      links: [],
      estimatedTokens: 1,
      structure: { extractedStringCount: 0 },
      metadata,
    });

    const reindex = await service.reindex({ installationId: 'house-1' });
    const extraction = store.getExtractionBySourceId(manual.id);

    expect(reindex.scanned).toBe(1);
    expect(reindex.reparsed).toBe(1);
    expect(extraction?.extractorId).toBe('pdfjs');
    expect(JSON.stringify(extraction?.structure)).toContain('Dolby Vision');
  });

  test('source reindex skips stale generated page sources whose artifacts were removed', async () => {
    const { store, artifactStore } = createHomeGraphService();
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const generated = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG TV generated passport',
      canonicalUri: 'homegraph://house-1/generated-page/lg-tv',
      tags: ['homeassistant', 'home-graph', 'generated-page'],
      status: 'indexed',
      artifactId: 'artifact-missing-generated-page',
      metadata: {
        knowledgeSpaceId: spaceId,
        homeGraphGeneratedPage: true,
        projectionKind: 'device-passport',
      },
    });

    const reindex = await reindexHomeGraphSources({
      spaceId,
      sources: [generated],
      extractionBySourceId: new Map(),
      artifactStore,
      extract: async () => undefined,
    });

    expect(reindex.scanned).toBe(1);
    expect(reindex.skipped).toBe(1);
    expect(reindex.failed).toBe(0);
    expect(reindex.failures).toHaveLength(0);
    expect(reindex.spaceId).toBe(spaceId);
  });

});
