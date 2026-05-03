import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import {
  HomeGraphService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph object-scoped search', () => {
  test('answers TV feature questions from TV evidence instead of unrelated feature documents', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [
        { id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'router', name: 'GL.iNet Router', manufacturer: 'GL.iNet', model: 'MT6000' },
      ],
      entities: [
        { entityId: 'media_player.lg_webos_smart_tv', name: 'LG webOS Smart TV', deviceId: 'lg-tv', metadata: { domain: 'media_player', platform: 'webostv' } },
        { entityId: 'sensor.storage_library_tv_shows', name: 'STORAGE Library - TV Shows', deviceId: 'plex', metadata: { domain: 'sensor', platform: 'plex' } },
        { entityId: 'calendar.upcoming_tv_shows', name: 'Upcoming TV Shows', metadata: { domain: 'calendar', platform: 'local_calendar' } },
      ],
      integrations: [{ id: 'webostv', name: 'LG webOS Smart TV' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = homeGraphMetadata(spaceId, 'house-1');
    await store.upsertSource({
      id: 'lg-manual',
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG-86NANO90UNA-manual.pdf',
      canonicalUri: 'homegraph://house-1/lg-tv',
      tags: ['homeassistant', 'home-graph', 'artifact'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: 'lg-manual',
      extractorId: 'pdfjs',
      format: 'pdf',
      summary: 'LG TV owner manual.',
      sections: [],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: 'TV features include HDR10, HDMI eARC, filmmaker mode, game optimizer, and Magic Remote voice control.' },
      metadata,
    });
    const routerSource = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'mt6000_datasheet.pdf',
      canonicalUri: 'homegraph://house-1/router',
      tags: ['homeassistant', 'home-graph', 'artifact'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: routerSource.id,
      extractorId: 'pdfjs',
      format: 'pdf',
      summary: 'Router datasheet.',
      sections: [],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: 'Software features include OpenWrt, repeater mode, VPN support, USB storage, and advanced network controls.' },
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: routerSource.id,
      target: { kind: 'device', id: 'router', relation: 'has_manual' },
    });

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'What features does the TV have?',
      includeLinkedObjects: true,
    });

    expect(ask.results.map((result) => result.id)).toEqual(['lg-manual']);
    expect(ask.answer.text).toContain('HDR10');
    expect(ask.answer.text).toContain('Magic Remote');
    expect(ask.answer.text).not.toContain('OpenWrt');
  });

  test('does not answer object-scoped questions from garbled unrelated PDF text', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
      entities: [
        { entityId: 'media_player.lg_webos_smart_tv', name: 'LG webOS Smart TV', deviceId: 'lg-tv', metadata: { domain: 'media_player', platform: 'webostv' } },
      ],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = homeGraphMetadata(spaceId, 'house-1');
    await store.upsertSource({
      id: 'espresso-manual',
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'MANUAL_6420-010-01628_GAG_CLASSIC_PRO_USA_Rev_00.pdf',
      canonicalUri: 'homegraph://house-1/espresso',
      tags: ['homeassistant', 'home-graph', 'artifact'],
      status: 'indexed',
      metadata,
    });
    await store.upsertExtraction({
      sourceId: 'espresso-manual',
      extractorId: 'pdf',
      format: 'pdf',
      summary: 'MANUAL_6420-010-01628_GAG_CLASSIC_PRO_USA_Rev_00.pdf: âÓÒó977 ç^Å‰zÇmÇì É¥NKºÚZjì†ÅjÒ(íÚD_EQ¥>ÅE',
      sections: [],
      links: [],
      estimatedTokens: 200,
      structure: { searchText: '%PDF-1.7 7 0 obj /Filter /FlateDecode stream âÓÒó977 ç^Å‰zÇmÇì É¥NKºÚZjì†ÅjÒ(íÚD_EQ¥>ÅE yEx¥µržSã‹irvus Æw÷ùçùy¼4°' },
      metadata,
    });

    const ask = await service.ask({
      installationId: 'house-1',
      query: 'What features does the TV have?',
    });

    expect(ask.results.some((result) => result.id === 'espresso-manual')).toBe(false);
    expect(ask.answer.text).not.toContain('GAG_CLASSIC_PRO');
    expect(ask.answer.text).not.toContain('âÓÒ');
  });
});

function createHomeGraphService(): {
  readonly store: KnowledgeStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-object-search-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return { store, service: new HomeGraphService(store, artifactStore) };
}

function homeGraphMetadata(spaceId: string, installationId: string): Record<string, unknown> {
  return {
    knowledgeSpaceId: spaceId,
    namespace: spaceId,
    homeGraph: true,
    homeAssistant: { installationId },
  };
}
