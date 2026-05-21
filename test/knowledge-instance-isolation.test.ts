import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_DB_FILE,
  REGULAR_KNOWLEDGE_DB_FILE,
} from '../packages/sdk/src/platform/knowledge/store-config.js';
import { HomeGraphService, KnowledgeService, KnowledgeStore } from '../packages/sdk/src/platform/knowledge/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge instance isolation', () => {
  test('keeps regular Knowledge/Wiki, Agent knowledge, and Home Graph on separate stores', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-isolation-'));
    tmpRoots.push(root);
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const regularStore = new KnowledgeStore({ configManager, dbFileName: REGULAR_KNOWLEDGE_DB_FILE });
    const agentStore = new KnowledgeStore({ configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE });
    const homeGraphStore = new KnowledgeStore({ configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE });
    const regularService = new KnowledgeService(regularStore, artifactStore, undefined, {
      memoryRegistry: {
        add: async () => {},
        getAll: () => [],
        getStore: () => null,
      },
    });
    const agentService = new KnowledgeService(agentStore, artifactStore, undefined, {
      memoryRegistry: {
        add: async () => {},
        getAll: () => [],
        getStore: () => null,
      },
    });
    const homeGraphService = new HomeGraphService(homeGraphStore, artifactStore);

    await agentStore.upsertSource({
      connectorId: 'manual',
      sourceType: 'document',
      canonicalUri: 'https://example.test/goodvibes-agent',
      title: 'GoodVibes Agent Operator Notes',
      tags: ['goodvibes-agent'],
      status: 'indexed',
    });

    await homeGraphService.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA', areaId: 'living-room' }],
      entities: [{ entityId: 'media_player.tv', name: 'LG webOS Smart TV', deviceId: 'tv', areaId: 'living-room', metadata: { domain: 'media_player' } }],
    });

    expect(regularStore.storagePath).toEndWith(REGULAR_KNOWLEDGE_DB_FILE);
    expect(agentStore.storagePath).toEndWith(GOODVIBES_AGENT_KNOWLEDGE_DB_FILE);
    expect(homeGraphStore.storagePath).toEndWith(HOME_GRAPH_KNOWLEDGE_DB_FILE);
    expect(regularStore.storagePath).not.toBe(homeGraphStore.storagePath);
    expect(regularStore.storagePath).not.toBe(agentStore.storagePath);
    expect(agentStore.storagePath).not.toBe(homeGraphStore.storagePath);
    expect(agentService.querySources({ limit: 100, includeAllSpaces: true }).items.map((source) => source.title)).toContain('GoodVibes Agent Operator Notes');
    expect((await homeGraphService.status({ installationId: 'house-1' })).nodeCount).toBeGreaterThan(0);

    expect(regularService.querySources({ limit: 100, includeAllSpaces: true }).items).toEqual([]);
    expect(regularService.queryNodes({ limit: 100, includeAllSpaces: true }).items).toEqual([]);
    expect(regularService.queryIssues({ limit: 100, includeAllSpaces: true }).items).toEqual([]);
    const regularProjectionTargets = await regularService.listProjectionTargets(100, { includeAllSpaces: true });
    const serializedTargets = JSON.stringify(regularProjectionTargets);
    expect(serializedTargets).not.toContain('LG webOS Smart TV');
    expect(serializedTargets).not.toContain('homeassistant');
    expect(serializedTargets).not.toContain('GoodVibes Agent');
  });
});
