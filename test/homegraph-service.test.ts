import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import { HomeGraphRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/home-graph-routes.js';
import {
  HomeGraphService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph knowledge spaces', () => {
  test('syncs Home Assistant snapshots into an isolated knowledge space', async () => {
    const { service, store } = createHomeGraphService();
    await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'document',
      title: 'Default space source',
      canonicalUri: 'manual://default',
      tags: ['default'],
      status: 'indexed',
    });

    const synced = await service.syncSnapshot({
      installationId: 'house-1',
      title: 'House',
      areas: [{ id: 'kitchen', name: 'Kitchen' }],
      devices: [{ id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'kitchen' }],
      entities: [{
        id: 'binary_sensor.front_door',
        entityId: 'binary_sensor.front_door',
        name: 'Front Door',
        deviceId: 'front-door-sensor',
        areaId: 'kitchen',
      }],
      automations: [{ id: 'automation.porch_lights', name: 'Porch Lights' }],
    });

    const status = await service.status({ installationId: 'house-1' });
    const answer = await service.ask({ installationId: 'house-1', query: 'manualdefault' });
    const browse = await service.browse({ installationId: 'house-1' });
    const map = await service.map({ installationId: 'house-1' });
    const generatedSources = browse.sources.filter((source) => source.metadata.homeGraphGeneratedPage === true);
    const projectionKinds = generatedSources.map((source) => source.metadata.projectionKind);

    expect(synced.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(synced.generated.devicePassports).toBe(1);
    expect(synced.generated.roomPages).toBe(1);
    expect(synced.generated.errors).toHaveLength(0);
    expect(status.nodeCount).toBeGreaterThanOrEqual(4);
    expect(status.sourceCount).toBeGreaterThanOrEqual(3);
    expect(status.capabilities).toContain('knowledge-space-isolation');
    expect(status.capabilities).toContain('automatic-page-generation');
    expect(status.capabilities).toContain('visual-knowledge-map');
    expect(projectionKinds).toContain('device-passport');
    expect(projectionKinds).toContain('room-page');
    expect(browse.nodes.some((node) => node.kind === 'ha_device_passport')).toBe(true);
    expect(map.nodeCount).toBeGreaterThanOrEqual(5);
    expect(map.edgeCount).toBeGreaterThan(0);
    expect(map.svg).toContain('<svg');
    expect(map.svg).toContain('Front Door Sensor');
    expect(answer.results).toHaveLength(0);
  });

  test('allows snapshot callers to direct automatic page generation', async () => {
    const { service } = createHomeGraphService();

    const synced = await service.syncSnapshot({
      installationId: 'house-1',
      pageAutomation: {
        devicePassports: false,
        roomPages: false,
      },
      areas: [{ id: 'office', name: 'Office' }],
      devices: [{ id: 'desk-lamp', name: 'Desk Lamp', areaId: 'office' }],
    });
    const browse = await service.browse({ installationId: 'house-1' });

    expect(synced.generated.devicePassports).toBe(0);
    expect(synced.generated.roomPages).toBe(0);
    expect(synced.generated.artifacts).toBe(0);
    expect(browse.sources.some((source) => source.metadata.homeGraphGeneratedPage === true)).toBe(false);
  });

  test('keeps automatic generated pages stable across repeated syncs', async () => {
    const { service, artifactStore } = createHomeGraphService();
    const snapshot = {
      installationId: 'house-1',
      areas: [{ id: 'kitchen', name: 'Kitchen' }],
      devices: [{ id: 'kitchen-sensor', name: 'Kitchen Sensor', areaId: 'kitchen' }],
    };

    const first = await service.syncSnapshot(snapshot);
    const firstArtifactIds = artifactStore.list(20).map((artifact) => artifact.id).sort();
    const second = await service.syncSnapshot(snapshot);
    const secondArtifactIds = artifactStore.list(20).map((artifact) => artifact.id).sort();
    const roomPage = await service.generateRoomPage({ installationId: 'house-1', areaId: 'kitchen' });

    expect(first.generated.artifacts).toBe(2);
    expect(second.generated.devicePassports).toBe(1);
    expect(second.generated.roomPages).toBe(1);
    expect(second.generated.artifacts).toBe(0);
    expect(secondArtifactIds).toEqual(firstArtifactIds);
    expect(roomPage.markdown).not.toContain('Living Home Graph room page for Kitchen');
  });

  test('scopes room pages to room objects and linked source evidence', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [
        { id: 'kitchen', name: 'Kitchen' },
        { id: 'garage', name: 'Garage' },
      ],
      devices: [
        { id: 'kitchen-sensor', name: 'Kitchen Sensor', areaId: 'kitchen' },
        { id: 'garage-opener', name: 'Garage Opener', areaId: 'garage' },
      ],
      automations: [
        { id: 'automation.kitchen_lights', name: 'Kitchen Lights', areaId: 'kitchen' },
        { id: 'automation.garage_door', name: 'Garage Door', areaId: 'garage' },
      ],
    });
    await service.ingestNote({
      installationId: 'house-1',
      title: 'Kitchen sensor manual',
      body: 'The kitchen sensor reports temperature and motion.',
      target: { kind: 'device', id: 'kitchen-sensor', relation: 'has_manual' },
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const nodes = (await service.browse({ installationId: 'house-1' })).nodes;
    const kitchenSensor = nodes.find((node) => node.title === 'Kitchen Sensor');
    const garageOpener = nodes.find((node) => node.title === 'Garage Opener');
    expect(kitchenSensor).toBeDefined();
    expect(garageOpener).toBeDefined();
    await store.upsertIssue({
      id: 'issue-kitchen-sensor',
      severity: 'info',
      code: 'knowledge.intrinsic_gap',
      message: 'Kitchen Sensor needs source-backed feature details.',
      status: 'open',
      nodeId: kitchenSensor!.id,
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertIssue({
      id: 'issue-kitchen-sensor-review',
      severity: 'info',
      code: 'homegraph.device.review_note',
      message: 'Kitchen Sensor has a scoped device review note.',
      status: 'open',
      nodeId: kitchenSensor!.id,
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertIssue({
      id: 'issue-garage-opener',
      severity: 'info',
      code: 'knowledge.intrinsic_gap',
      message: 'Garage Opener needs source-backed feature details.',
      status: 'open',
      nodeId: garageOpener!.id,
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.generateRoomPage({ installationId: 'house-1', areaId: 'kitchen' });

    expect(page.markdown).toContain('Kitchen Sensor');
    expect(page.markdown).toContain('Kitchen Lights');
    expect(page.markdown).toContain('Kitchen sensor manual');
    expect(page.markdown).toContain('Kitchen Sensor has a scoped device review note.');
    expect(page.markdown).not.toContain('Kitchen Sensor needs source-backed feature details.');
    expect(page.markdown).not.toContain('Garage Opener');
    expect(page.markdown).not.toContain('Garage Door');
    expect(page.markdown).not.toContain('Garage Opener needs source-backed feature details.');
  });

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

  test('keeps Home Assistant linked objects from repaired source metadata', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'living-room-tv', name: 'Living Room TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const tvNode = store.listNodes(1_000).find((node) => node.title === 'Living Room TV');
    expect(tvNode).toBeDefined();
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
    const { service } = createHomeGraphService();
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

    const map = await service.map({
      installationId: 'house-1',
      ha: { domains: ['media_player'] },
      includeSources: true,
    });

    expect(map.nodes.some((node) => node.title === 'Living Room TV')).toBe(true);
    expect(map.edgeCount).toBeGreaterThan(0);
    expect(map.edges.some((edge) => edge.relation === 'belongs_to_device' || edge.relation === 'located_in')).toBe(true);
    expect(map.edges.every((edge) => typeof edge.source === 'string' && typeof edge.target === 'string')).toBe(true);
    expect(map.edges.some((edge) => typeof edge.sourceTitle === 'string' && typeof edge.targetTitle === 'string')).toBe(true);
  });

  test('repairs already-uploaded weak PDF manual extractions during ask', async () => {
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

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'what features does the LG TV have?',
      includeLinkedObjects: true,
    });
    const repairedExtraction = store.listExtractions().find((entry) => entry.sourceId === manual.id);

    expect(repairedExtraction?.extractorId).toBe('pdfjs');
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

  test('keeps Home Graph review decisions durable across quality refreshes', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'entry', name: 'Entry' }, { id: 'living-room', name: 'Living Room' }],
      devices: [
        { id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'entry' },
        { id: 'living-room-tv', name: 'Living Room TV', manufacturer: 'Sony', model: 'Bravia', areaId: 'living-room' },
        { id: 'zha-bridge', name: 'ZHA Bridge', manufacturer: 'Home Assistant', model: 'Coordinator' },
      ],
      entities: [
        {
          entity_id: 'binary_sensor.front_door',
          device_id: 'front-door-sensor',
          area_id: 'entry',
          attributes: { friendly_name: 'Front Door', device_class: 'door' },
        },
        {
          entity_id: 'media_player.living_room_tv',
          device_id: 'living-room-tv',
          area_id: 'living-room',
          attributes: { friendly_name: 'Living Room TV' },
        },
      ],
    });

    const initial = await service.listIssues({ installationId: 'house-1', status: 'open' });
    const batteryIssues = initial.issues.filter((issue) => issue.code === 'homegraph.device.unknown_battery');
    const frontDoorIssue = batteryIssues.find((issue) => issue.message.includes('Front Door Sensor'));

    expect(frontDoorIssue).toBeDefined();
    expect(batteryIssues.some((issue) => issue.message.includes('Living Room TV'))).toBe(false);
    expect(initial.issues.some((issue) => issue.message.includes('ZHA Bridge'))).toBe(false);

    const reviewed = await service.reviewFact({
      installationId: 'house-1',
      issueId: frontDoorIssue!.id,
      action: 'reject',
      reviewer: 'homeassistant',
      value: {
        category: 'not_applicable',
        reason: 'The device should not be tracked for batteries in this installation.',
      },
    });
    expect(reviewed.issue?.status).toBe('resolved');
    expect(reviewed.appliedFacts?.batteryPowered).toBe(false);

    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'entry', name: 'Entry' }],
      devices: [{ id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'entry' }],
      entities: [{
        entity_id: 'binary_sensor.front_door',
        device_id: 'front-door-sensor',
        area_id: 'entry',
        attributes: { friendly_name: 'Front Door', device_class: 'door' },
      }],
    });
    const afterRefresh = await service.listIssues({ installationId: 'house-1', status: 'open' });
    const browse = await service.browse({ installationId: 'house-1' });
    const frontDoorNode = browse.nodes.find((node) => node.title === 'Front Door Sensor');

    expect(afterRefresh.issues.some((issue) => issue.id === frontDoorIssue!.id)).toBe(false);
    expect(frontDoorNode?.metadata.batteryPowered).toBe(false);
    expect(frontDoorNode?.metadata.batteryType).toBe('none');
  });

  test('creates Home Assistant integration documentation candidates during sync', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      integrations: [{
        integration_id: 'zha',
        name: 'ZHA',
        metadata: {
          documentation_url: 'https://example.test/zha-docs',
          source_url: 'https://github.com/home-assistant/core/tree/dev/homeassistant/components/zha',
        },
      }],
    });

    const sources = await service.listSources({ installationId: 'house-1', limit: 10 });
    expect(sources.sources.some((source) => source.sourceUri === 'https://www.home-assistant.io/integrations/zha/')).toBe(true);
    expect(sources.sources.some((source) => source.sourceUri === 'https://example.test/zha-docs')).toBe(true);
    expect(sources.sources.filter((source) => source.metadata.homeGraphSourceKind === 'documentation-candidate').length).toBeGreaterThanOrEqual(2);
  });

  test('exposes daemon routes for Home Graph clients', async () => {
    const { service, artifactStore } = createHomeGraphService();
    const routes = new HomeGraphRoutes({
      artifactStore,
      homeGraphService: service,
      parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
      parseOptionalJsonBody: async (req) => {
        const text = await req.text();
        return text ? JSON.parse(text) as Record<string, unknown> : {};
      },
      requireAdmin: () => null,
    });

    const syncResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/sync', {
      method: 'POST',
      body: JSON.stringify({
        installationId: 'house-1',
        devices: [{ id: 'thermostat', name: 'Thermostat' }],
      }),
    }));
    const statusResponse = await routes.handle(new Request(
      'http://daemon.local/api/homeassistant/home-graph/status?installationId=house-1',
    ));
    const reindexResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/reindex', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'house-1' }),
    }));
    const mapResponse = await routes.handle(new Request(
      'http://daemon.local/api/homeassistant/home-graph/map?installationId=house-1',
    ));
    const svgResponse = await routes.handle(new Request(
      'http://daemon.local/api/homeassistant/home-graph/map?installationId=house-1&format=svg',
    ));

    expect(syncResponse?.status).toBe(200);
    expect(statusResponse?.status).toBe(200);
    expect(reindexResponse?.status).toBe(200);
    expect(mapResponse?.status).toBe(200);
    expect(svgResponse?.status).toBe(200);
    const status = await statusResponse!.json() as Record<string, unknown>;
    const reindex = await reindexResponse!.json() as Record<string, unknown>;
    const map = await mapResponse!.json() as Record<string, unknown>;
    const svg = await svgResponse!.text();
    expect(status.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(status.nodeCount).toBeGreaterThanOrEqual(2);
    expect(reindex.scanned).toBe(0);
    expect(map.svg).toContain('<svg');
    expect(svgResponse!.headers.get('content-type') ?? '').toContain('image/svg+xml');
    expect(svg).toContain('Thermostat');
  });

  test('accepts native Home Assistant snake_case snapshot objects', async () => {
    const { service, artifactStore } = createHomeGraphService();
    const routes = new HomeGraphRoutes({
      artifactStore,
      homeGraphService: service,
      parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
      parseOptionalJsonBody: async (req) => {
        const text = await req.text();
        return text ? JSON.parse(text) as Record<string, unknown> : {};
      },
      requireAdmin: () => null,
    });

    const syncResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/sync', {
      method: 'POST',
      body: JSON.stringify({
        installationId: 'house-1',
        areas: [{ area_id: 'kitchen', name: 'Kitchen' }],
        devices: [{ device_id: 'device-1', name: 'Kitchen Sensor', area_id: 'kitchen' }],
        entities: [{
          entity_id: 'binary_sensor.kitchen_motion',
          device_id: 'device-1',
          area_id: 'kitchen',
          platform: 'zha',
          attributes: { friendly_name: 'Kitchen Motion' },
        }],
      }),
    }));
    const browse = await service.browse({ installationId: 'house-1' });

    expect(syncResponse?.status).toBe(200);
    expect(browse.nodes.some((node) => node.title === 'Kitchen Motion')).toBe(true);
    expect(browse.nodes.some((node) => readHomeAssistantEntityId(node.metadata) === 'binary_sensor.kitchen_motion')).toBe(true);
    expect(browse.edges.some((edge) => edge.relation === 'belongs_to_device')).toBe(true);
    expect(browse.edges.some((edge) => edge.relation === 'located_in')).toBe(true);
  });

  test('returns JSON errors for admin route failures', async () => {
    const { artifactStore } = createHomeGraphService();
    const routes = new HomeGraphRoutes({
      artifactStore,
      homeGraphService: {
        syncSnapshot: async () => {
          throw new TypeError('synthetic sync failure');
        },
      } as unknown as HomeGraphService,
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => ({}),
      requireAdmin: () => null,
    });

    const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    const body = await response!.json() as { readonly error?: string };

    expect(response?.status).toBe(400);
    expect(body.error).toContain('synthetic sync failure');
  });
});

function createHomeGraphService(): {
  readonly root: string;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifactStore);
  return { root, store, artifactStore, service };
}

function readHomeAssistantEntityId(metadata: Record<string, unknown>): string | undefined {
  const homeAssistant = metadata.homeAssistant;
  return homeAssistant && typeof homeAssistant === 'object' && !Array.isArray(homeAssistant)
    ? (homeAssistant as { readonly entityId?: string }).entityId
    : undefined;
}

function createCompressedPdfBuffer(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const compressed = deflateSync(Buffer.from(content, 'utf-8'));
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const add = (chunk: string | Buffer): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
    chunks.push(buffer);
    size += buffer.length;
  };
  const object = (id: number, body: string | Buffer): void => {
    offsets[id] = size;
    add(`${id} 0 obj\n`);
    add(body);
    add('\nendobj\n');
  };

  add('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  object(5, Buffer.concat([
    Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'binary'),
    compressed,
    Buffer.from('\nendstream', 'binary'),
  ]));
  const xrefOffset = size;
  add('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) {
    add(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
