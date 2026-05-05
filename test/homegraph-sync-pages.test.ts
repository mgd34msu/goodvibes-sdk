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

describe('Home Graph sync and generated pages', () => {
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
    expect(map.edgeCount).toBeGreaterThanOrEqual(4);
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

  test('retires snapshot objects and generated pages missing from the latest sync', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'retired-device', name: 'Retired Device', manufacturer: 'Vendor', model: 'RET-1' }],
      entities: [{
        id: 'sensor.old_device',
        entityId: 'sensor.old_device',
        name: 'Retired Device Sensor',
        deviceId: 'retired-device',
      }],
    });

    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'new-device', name: 'New Device', manufacturer: 'Vendor', model: 'NEW-1' }],
      entities: [{
        id: 'sensor.new_device',
        entityId: 'sensor.new_device',
        name: 'New Device Sensor',
        deviceId: 'new-device',
      }],
    });

    const browse = await service.browse({ installationId: 'house-1' });
    const pages = await service.listPages({ installationId: 'house-1', limit: 20 });

    expect(browse.nodes.some((node) => node.title === 'Retired Device')).toBe(false);
    expect(browse.nodes.some((node) => node.title === 'Retired Device Sensor')).toBe(false);
    expect(pages.pages.some((page) => page.source.title === 'Retired Device passport')).toBe(false);
    expect(pages.pages.some((page) => page.source.title === 'New Device passport')).toBe(true);
  });

  test('does not retire object groups omitted from a partial snapshot', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'office', name: 'Office' }],
      devices: [{ id: 'desk-display', name: 'Desk Display', areaId: 'office', manufacturer: 'Vendor', model: 'DSP-1' }],
    });

    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'office', name: 'Office' }],
    });

    const browse = await service.browse({ installationId: 'house-1' });
    const pages = await service.listPages({ installationId: 'house-1', limit: 20 });

    expect(browse.nodes.some((node) => node.title === 'Desk Display')).toBe(true);
    expect(pages.pages.some((page) => page.source.title === 'Desk Display passport')).toBe(true);
  });

  test('reactivates retired snapshot objects when they reappear', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'returning-display', name: 'Returning Display', manufacturer: 'Vendor', model: 'RET-1' }],
    });
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [],
    });
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'returning-display', name: 'Returning Display', manufacturer: 'Vendor', model: 'RET-1' }],
    });

    const browse = await service.browse({ installationId: 'house-1' });
    const pages = await service.listPages({ installationId: 'house-1', limit: 20 });

    expect(browse.nodes.some((node) => node.title === 'Returning Display')).toBe(true);
    expect(pages.pages.some((page) => page.source.title === 'Returning Display passport')).toBe(true);
  });

  test('bounds snapshot-time automatic page generation for large spaces', async () => {
    const { service } = createHomeGraphService();
    const devices = Array.from({ length: 48 }, (_, index) => ({
      id: `device-${index}`,
      name: index === 47 ? 'LG webOS Smart TV' : `Generic Device ${index}`,
      manufacturer: index === 47 ? 'LG' : 'Vendor',
      model: index === 47 ? '86NANO90UNA' : `M${index}`,
    }));

    const synced = await service.syncSnapshot({
      installationId: 'house-1',
      devices,
    });
    const pages = await service.listPages({ installationId: 'house-1', limit: 80 });
    const priorityPages = await service.listPages({ installationId: 'house-1', limit: 5 });

    expect(synced.generated.devicePassports).toBe(32);
    expect(synced.generated.deferredDevicePassports).toBe(16);
    expect(synced.generated.truncated).toBe(true);
    expect(pages.pages.some((page) => page.source.title === 'LG webOS Smart TV passport')).toBe(true);
    expect(priorityPages.pages.some((page) => page.source.title === 'LG webOS Smart TV passport')).toBe(true);
  });

  test('lists generated pages with graph subjects and navigation neighbors', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'kitchen', name: 'Kitchen' }],
      devices: [{ id: 'kitchen-proxy', name: 'Kitchen Proxy', manufacturer: 'Espressif', model: 'XIAO ESP32C6', areaId: 'kitchen' }],
      entities: [{
        id: 'sensor.kitchen_proxy_temperature',
        entityId: 'sensor.kitchen_proxy_temperature',
        name: 'Kitchen Proxy Temperature',
        deviceId: 'kitchen-proxy',
        areaId: 'kitchen',
      }],
    });

    const pages = await service.listPages({ installationId: 'house-1', limit: 20, includeMarkdown: false });
    const kitchen = pages.pages.find((page) => page.subject?.title === 'Kitchen');
    const proxy = pages.pages.find((page) => page.subject?.title === 'Kitchen Proxy');

    expect(kitchen?.subject?.objectId).toBe('kitchen');
    expect(proxy?.subject?.objectId).toBe('kitchen-proxy');
    expect(proxy?.target?.kind).toBe('ha_device_passport');
    expect(proxy?.neighbors?.some((neighbor) => neighbor.kind === 'ha_device_passport')).toBe(false);
    expect(kitchen?.neighbors?.some((neighbor) => neighbor.title === 'Kitchen Proxy' && neighbor.relation === 'located_in')).toBe(true);
    expect(proxy?.neighbors?.some((neighbor) => neighbor.title === 'Kitchen' && neighbor.relation === 'located_in')).toBe(true);
    expect(kitchen?.relatedPages?.some((page) => page.subject?.title === 'Kitchen Proxy')).toBe(true);
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
    expect(kitchenSensor?.title).toBe('Kitchen Sensor');
    expect(garageOpener?.title).toBe('Garage Opener');
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

  test('device passports render only subject-linked facts from accepted sources', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [
        { id: 'kitchen-sensor', name: 'Kitchen Sensor', manufacturer: 'Acme', model: 'KS-1' },
        { id: 'garage-opener', name: 'Garage Opener', manufacturer: 'Acme', model: 'GO-1' },
      ],
    });
    const note = await service.ingestNote({
      installationId: 'house-1',
      title: 'Shared device evidence',
      body: 'Kitchen Sensor reports temperature and motion. Garage Opener supports Z-Wave garage door control.',
      target: { kind: 'device', id: 'kitchen-sensor', relation: 'has_manual' },
      tags: ['manual'],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const nodes = (await service.browse({ installationId: 'house-1' })).nodes;
    const kitchenSensor = nodes.find((node) => node.title === 'Kitchen Sensor');
    const garageOpener = nodes.find((node) => node.title === 'Garage Opener');
    expect(kitchenSensor).toBeDefined();
    expect(garageOpener).toBeDefined();

    await store.upsertNode({
      id: 'fact-kitchen-sensor-capability',
      kind: 'fact',
      slug: 'fact-kitchen-sensor-capability',
      title: 'Sensing capabilities',
      summary: 'Kitchen Sensor reports temperature and motion.',
      aliases: [],
      status: 'active',
      confidence: 90,
      sourceId: note.source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'capability',
        value: 'temperature and motion',
        sourceId: note.source.id,
        subjectIds: [kitchenSensor!.id],
        linkedObjectIds: [kitchenSensor!.id],
      },
    });
    await store.upsertNode({
      id: 'fact-garage-opener-capability',
      kind: 'fact',
      slug: 'fact-garage-opener-capability',
      title: 'Garage control',
      summary: 'Garage Opener supports Z-Wave garage door control.',
      aliases: [],
      status: 'active',
      confidence: 90,
      sourceId: note.source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'capability',
        value: 'Z-Wave garage door control',
        sourceId: note.source.id,
        subjectIds: [garageOpener!.id],
        linkedObjectIds: [garageOpener!.id],
      },
    });
    for (const factId of ['fact-kitchen-sensor-capability', 'fact-garage-opener-capability']) {
      await store.upsertEdge({
        fromKind: 'source',
        fromId: note.source.id,
        toKind: 'node',
        toId: factId,
        relation: 'supports_fact',
        weight: 0.95,
        metadata: { knowledgeSpaceId: spaceId },
      });
    }
    await store.upsertEdge({
      fromKind: 'node',
      fromId: 'fact-kitchen-sensor-capability',
      toKind: 'node',
      toId: kitchenSensor!.id,
      relation: 'describes',
      weight: 0.95,
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: 'fact-garage-opener-capability',
      toKind: 'node',
      toId: garageOpener!.id,
      relation: 'describes',
      weight: 0.95,
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'kitchen-sensor' });

    expect(page.markdown).toContain('Kitchen Sensor reports temperature and motion.');
    expect(page.markdown).not.toContain('Z-Wave garage door control');
  });

  test('device passports render source-backed facts associated by fact metadata', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'kitchen-sensor', name: 'Kitchen Sensor', manufacturer: 'Acme', model: 'KS-1' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const device = (await service.browse({ installationId: 'house-1' })).nodes
      .find((node) => node.title === 'Kitchen Sensor');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'Kitchen Sensor manual',
      canonicalUri: 'homegraph://house-1/kitchen-sensor-manual',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'kitchen-sensor-temperature-motion',
      title: 'Sensing capabilities',
      summary: 'Kitchen Sensor reports temperature and motion.',
      status: 'active',
      confidence: 90,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'capability',
        value: 'temperature and motion',
        sourceIds: [source.id],
        subjectIds: [device!.id],
        linkedObjectIds: [device!.id],
      },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: device!.id,
      relation: 'describes',
      weight: 0.95,
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'kitchen-sensor' });

    expect(page.markdown).toContain('Kitchen Sensor reports temperature and motion.');
    expect(page.markdown).toContain('Kitchen Sensor manual');
  });

  test('device page profiles do not promote source metadata when extraction text is missing', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const device = (await service.browse({ installationId: 'house-1' })).nodes
      .find((node) => node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'url',
      title: 'LG TV source shell',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      summary: 'LG source metadata says Dolby Vision and HDMI eARC.',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device!.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(page.markdown).toContain('LG TV source shell');
    expect(page.markdown).not.toContain('Dolby Vision');
    expect(page.markdown).not.toContain('HDMI eARC');
  });

});
