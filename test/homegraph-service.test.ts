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

  test('exposes daemon routes for Home Graph clients', async () => {
    const { service } = createHomeGraphService();
    const routes = new HomeGraphRoutes({
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
