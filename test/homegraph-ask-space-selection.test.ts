import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
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

describe('Home Graph ask space selection', () => {
  test('infers the active Home Graph space and recovers TV manual evidence when links are missing', async () => {
    const { service, store } = createHomeGraphService();
    await syncTvSnapshot(service, { installationId: 'house-1' });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    await addTvManualEvidence(store, spaceId, 'house-1');
    await addUnrelatedKasaEvidence(store, spaceId, 'house-1');

    const ask = await service.ask({ query: 'What features does the TV have?' });

    expect(ask.spaceId).toBe(spaceId);
    expect(ask.results.map((result) => result.id)).toEqual(['manual-tv']);
    expect(ask.answer.text).toContain('HDR10');
    expect(ask.answer.text).not.toContain('Kasa');
  });

  test('reads an existing Home Graph space when the installation id casing differs', async () => {
    const { service, store } = createHomeGraphService();
    const storedSpaceId = 'homeassistant:01KQ5Q952WJZATS4406K0GER9R';
    await syncTvSnapshot(service, {
      installationId: '01KQ5Q952WJZATS4406K0GER9R',
      knowledgeSpaceId: storedSpaceId,
    });
    await addTvManualEvidence(store, storedSpaceId, '01kq5q952wjzats4406k0ger9r');

    const ask = await service.ask({
      installationId: '01KQ5Q952WJZATS4406K0GER9R',
      query: 'What features does the TV have?',
    });

    expect(ask.spaceId).toBe(storedSpaceId);
    expect(ask.results.map((result) => result.id)).toEqual(['manual-tv']);
    expect(ask.answer.text).toContain('Filmmaker Mode');
  });
});

function createHomeGraphService(): {
  readonly store: KnowledgeStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-ask-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return { store, service: new HomeGraphService(store, artifactStore) };
}

async function syncTvSnapshot(
  service: HomeGraphService,
  input: { readonly installationId: string; readonly knowledgeSpaceId?: string },
): Promise<void> {
  await service.syncSnapshot({
    ...input,
    areas: [{ id: 'living-room', name: 'Living Room' }],
    devices: [{
      id: 'living-room-tv',
      name: 'Living Room TV',
      manufacturer: 'LG',
      model: '86NANO90UNA',
      areaId: 'living-room',
    }],
    entities: [{
      entityId: 'media_player.living_room_tv',
      name: 'LG webOS Smart TV',
      deviceId: 'living-room-tv',
      areaId: 'living-room',
    }],
  });
}

async function addTvManualEvidence(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
): Promise<void> {
  const metadata = homeGraphMetadata(spaceId, installationId);
  await store.upsertSource({
    id: 'manual-tv',
    connectorId: 'homeassistant',
    sourceType: 'manual',
    title: 'LG 86NANO90UNA manual',
    canonicalUri: 'homegraph://house-1/lg-86nano90una-manual',
    tags: ['homeassistant', 'home-graph', 'manual'],
    status: 'indexed',
    metadata,
  });
  await store.upsertExtraction({
    sourceId: 'manual-tv',
    extractorId: 'test-pdf',
    format: 'pdf',
    title: 'LG 86NANO90UNA manual',
    summary: 'Television owner manual.',
    sections: ['Picture and sound features'],
    links: [],
    estimatedTokens: 200,
    structure: {
      searchText: `${manualPreface()} Features include HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.`,
    },
    metadata,
  });
}

async function addUnrelatedKasaEvidence(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
): Promise<void> {
  const metadata = homeGraphMetadata(spaceId, installationId);
  await store.upsertSource({
    id: 'manual-kasa',
    connectorId: 'homeassistant',
    sourceType: 'manual',
    title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
    canonicalUri: 'homegraph://house-1/kasa-plug',
    tags: ['homeassistant', 'home-graph', 'manual'],
    status: 'indexed',
    metadata,
  });
  await store.upsertExtraction({
    sourceId: 'manual-kasa',
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
}

function homeGraphMetadata(spaceId: string, installationId: string): Record<string, unknown> {
  return {
    knowledgeSpaceId: spaceId,
    namespace: spaceId,
    homeGraph: true,
    homeAssistant: { installationId },
  };
}

function manualPreface(): string {
  return Array.from({ length: 120 }, (_, index) => `Model compatibility line ${index + 1}`).join('\n');
}
