import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

    expect(synced.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(status.nodeCount).toBeGreaterThanOrEqual(4);
    expect(status.sourceCount).toBe(1);
    expect(status.capabilities).toContain('knowledge-space-isolation');
    expect(answer.results).toHaveLength(0);
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

    expect(syncResponse?.status).toBe(200);
    expect(statusResponse?.status).toBe(200);
    const status = await statusResponse!.json() as Record<string, unknown>;
    expect(status.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(status.nodeCount).toBeGreaterThanOrEqual(2);
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
