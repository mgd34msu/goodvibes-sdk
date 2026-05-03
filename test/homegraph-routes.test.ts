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

describe('Home Graph daemon routes', () => {
  test('coalesces overlapping Home Graph reindex requests', async () => {
    const { service } = createHomeGraphService();
    (service as unknown as { activeReindex: Promise<unknown> | null }).activeReindex = new Promise(() => {});

    const reindex = await service.reindex({ installationId: 'house-1' });

    expect(reindex.coalesced).toBe(true);
    expect(reindex.truncated).toBe(true);
    expect(reindex.budgetExhausted).toBe(true);
    expect(reindex.scanned).toBe(0);
    (service as unknown as { activeReindex: Promise<unknown> | null }).activeReindex = null;
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
    const exportResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/export', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'house-1' }),
    }));
    const orphanArtifact = await artifactStore.createFromStream({
      kind: 'document',
      mimeType: 'text/plain',
      filename: 'stale-homegraph-upload.txt',
      stream: ['stale upload'],
      metadata: {
        knowledgeSpaceId: homeAssistantKnowledgeSpaceId('house-1'),
        namespace: homeAssistantKnowledgeSpaceId('house-1'),
      },
    });
    const resetDryRunResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/reset', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'house-1', dryRun: true }),
    }));
    const dryRunStatusResponse = await routes.handle(new Request(
      'http://daemon.local/api/homeassistant/home-graph/status?installationId=house-1',
    ));
    const resetResponse = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/reset', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'house-1' }),
    }));
    const resetStatusResponse = await routes.handle(new Request(
      'http://daemon.local/api/homeassistant/home-graph/status?installationId=house-1',
    ));

    expect(syncResponse?.status).toBe(200);
    expect(statusResponse?.status).toBe(200);
    expect(reindexResponse?.status).toBe(200);
    expect(mapResponse?.status).toBe(200);
    expect(svgResponse?.status).toBe(200);
    expect(exportResponse?.status).toBe(200);
    expect(resetDryRunResponse?.status).toBe(200);
    expect(dryRunStatusResponse?.status).toBe(200);
    expect(resetResponse?.status).toBe(200);
    expect(resetStatusResponse?.status).toBe(200);
    const status = await statusResponse!.json() as Record<string, unknown>;
    const reindex = await reindexResponse!.json() as Record<string, unknown>;
    const map = await mapResponse!.json() as Record<string, unknown>;
    const svg = await svgResponse!.text();
    const exported = await exportResponse!.json() as { readonly sources?: readonly unknown[] };
    const resetDryRun = await resetDryRunResponse!.json() as {
      readonly dryRun?: boolean;
      readonly deleted?: { readonly sources?: number; readonly nodes?: number };
      readonly artifactDeleteCandidates?: number;
      readonly deletedArtifacts?: number;
    };
    const dryRunStatus = await dryRunStatusResponse!.json() as Record<string, unknown>;
    const reset = await resetResponse!.json() as {
      readonly dryRun?: boolean;
      readonly deleted?: { readonly sources?: number; readonly nodes?: number };
      readonly artifactsDeleted?: boolean;
      readonly deletedArtifacts?: number;
    };
    const resetStatus = await resetStatusResponse!.json() as Record<string, unknown>;
    expect(status.spaceId).toBe(homeAssistantKnowledgeSpaceId('house-1'));
    expect(status.nodeCount).toBeGreaterThanOrEqual(2);
    expect(reindex.scanned).toBe(0);
    expect(map.svg).toContain('<svg');
    expect(svgResponse!.headers.get('content-type') ?? '').toContain('image/svg+xml');
    expect(svg).toContain('Thermostat');
    expect(exported.sources?.length).toBeGreaterThan(0);
    expect(resetDryRun.dryRun).toBe(true);
    expect(resetDryRun.deleted?.sources).toBeGreaterThan(0);
    expect(resetDryRun.deleted?.nodes).toBeGreaterThan(0);
    expect(resetDryRun.artifactDeleteCandidates).toBeGreaterThan(0);
    expect(resetDryRun.deletedArtifacts).toBe(0);
    expect(dryRunStatus.nodeCount).toBe(status.nodeCount);
    expect(reset.dryRun).toBe(false);
    expect(reset.deleted?.sources).toBeGreaterThan(0);
    expect(reset.deleted?.nodes).toBeGreaterThan(0);
    expect(reset.artifactsDeleted).toBe(true);
    expect(reset.deletedArtifacts).toBeGreaterThan(0);
    expect(resetStatus.nodeCount).toBe(0);
    expect(artifactStore.get(orphanArtifact.id)).toBeNull();
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
