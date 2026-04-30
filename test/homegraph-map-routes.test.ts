import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import { HomeGraphRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/home-graph-routes.js';
import { HomeGraphService } from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph map routes', () => {
  test('accepts query, trailing slash, and JSON body map requests', async () => {
    const { service, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'thermostat', name: 'Thermostat' }],
    });
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

    const query = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/map?installationId=house-1'));
    const slash = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/map/?installationId=house-1'));
    const post = await routes.handle(new Request('http://daemon.local/api/homeassistant/home-graph/map', {
      method: 'POST',
      body: JSON.stringify({ installationId: 'house-1', limit: 10, includeSources: false }),
    }));

    expect(query?.status).toBe(200);
    expect(slash?.status).toBe(200);
    expect(post?.status).toBe(200);
    expect((await slash!.json() as { readonly svg: string }).svg).toContain('Thermostat');
  });
});

function createHomeGraphService(): {
  readonly artifactStore: ArtifactStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-map-routes-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return { artifactStore, service: new HomeGraphService(store, artifactStore) };
}
