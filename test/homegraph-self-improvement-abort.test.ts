import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { refreshHomeGraphDevicePassport } from '../packages/sdk/src/platform/knowledge/home-graph/generated-pages.js';
import { buildHomeGraphMetadata, homeGraphNodeId } from '../packages/sdk/src/platform/knowledge/home-graph/helpers.js';
import { runHomeGraphSyncSelfImprovementPump } from '../packages/sdk/src/platform/knowledge/home-graph/sync-self-improvement.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph sync self-improvement cancellation', () => {
  test('does not refresh pages after a repair result if the reset signal aborts first', async () => {
    const controller = new AbortController();
    let calls = 0;

    await runHomeGraphSyncSelfImprovementPump({
      store: {} as never,
      artifactStore: {} as never,
      reportBackgroundError: () => {},
      semanticService: {
        isBackgroundWorkPaused: () => false,
        selfImprove: async () => {
          calls += 1;
          controller.abort();
          return {
            scannedGaps: 1,
            candidateGaps: 1,
            processedGaps: 1,
            createdGaps: 0,
            repairableGaps: 1,
            suppressedGaps: 0,
            skippedGaps: 0,
            searched: 1,
            ingestedSources: 1,
            linkedRepairs: 1,
            blockedGaps: 0,
            closedGaps: 1,
            queuedTasks: 0,
            truncated: false,
            budgetExhausted: false,
            taskIds: [],
            ingestedSourceIds: ['source-1'],
            acceptedSourceIds: ['source-1'],
            promotedFactCount: 1,
            errors: [],
          };
        },
      } as never,
    }, 'homeassistant:house-1', 'house-1', controller.signal);

    expect(calls).toBe(1);
  });

  test('a governor pause mid-pump stops the pump at the next ROUND boundary, with a receipt logged', async () => {
    const { logger } = await import('../packages/sdk/src/platform/utils/logger.js');
    const controller = new AbortController();
    let paused = false;
    let calls = 0;
    const infoLines: string[] = [];
    const patched = logger as unknown as { info: (message: string, data?: Record<string, unknown>) => void };
    const originalInfo = patched.info.bind(logger);
    patched.info = (message, data) => { infoLines.push(message); originalInfo(message, data); };
    try {
      await runHomeGraphSyncSelfImprovementPump({
        store: {} as never,
        artifactStore: {} as never,
        reportBackgroundError: () => {},
        semanticService: {
          isBackgroundWorkPaused: () => paused,
          selfImprove: async () => {
            calls += 1;
            // The governor enters the high tier WHILE round 0 runs (pauseAll).
            paused = true;
            // A continue-worthy result: without the pause gate the pump would
            // run up to 10 rounds of LLM-backed work through the pressure.
            return {
              scannedGaps: 3, candidateGaps: 3, processedGaps: 3, createdGaps: 0,
              repairableGaps: 3, suppressedGaps: 0, skippedGaps: 0, searched: 0,
              ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0, closedGaps: 0,
              queuedTasks: 2, truncated: false, budgetExhausted: false,
              taskIds: ['t1', 't2'], ingestedSourceIds: [], acceptedSourceIds: [],
              promotedFactCount: 0, errors: [],
            };
          },
        } as never,
      }, 'homeassistant:house-1', 'house-1', controller.signal);
    } finally {
      delete (patched as { info?: unknown }).info; // restore the prototype method
    }
    // Stopped at the round-1 boundary: exactly ONE round ran, not up to 10.
    expect(calls).toBe(1);
    // The stop is receipted, naming the pause.
    expect(infoLines.some((line) => /pump stopped.*paused for memory pressure/i.test(line))).toBe(true);
  }, 20_000);

  test('rolls back device passport node and edge when cancellation happens during refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-abort-'));
    tmpRoots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const spaceId = 'homeassistant:house-1';
    const installationId = 'house-1';
    const deviceId = 'lg-tv';
    const device = await store.upsertNode({
      id: homeGraphNodeId(spaceId, 'ha_device', deviceId),
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG TV',
      aliases: ['LG TV'],
      status: 'active',
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: { installationId, objectKind: 'device', objectId: deviceId },
        objectId: deviceId,
        deviceId,
      }),
    });
    const passportId = homeGraphNodeId(spaceId, 'ha_device_passport', deviceId);
    const controller = new AbortController();
    const abortingStore = Object.create(store) as KnowledgeStore;
    abortingStore.upsertEdge = async (input) => {
      const edge = await store.upsertEdge(input);
      if (input.fromKind === 'node' && input.fromId === passportId && input.toKind === 'node' && input.toId === device.id) {
        controller.abort();
      }
      return edge;
    };

    await expect(refreshHomeGraphDevicePassport({
      store: abortingStore,
      artifactStore,
      spaceId,
      installationId,
      input: {
        knowledgeSpaceId: spaceId,
        deviceId,
      },
      signal: controller.signal,
    })).rejects.toThrow('Home Graph device passport refresh was cancelled');

    expect(store.getNode(passportId)).toBeNull();
    expect(store.listEdges()).not.toContainEqual(expect.objectContaining({
      fromKind: 'node',
      fromId: passportId,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
    }));
    expect(store.listSources(20).filter((source) => source.metadata.generatedKnowledgePage === true)).toEqual([]);
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('rolls back profile facts when cancellation happens during page-profile promotion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-abort-'));
    tmpRoots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const spaceId = 'homeassistant:house-1';
    const installationId = 'house-1';
    const deviceId = 'lg-tv';
    const device = await store.upsertNode({
      id: homeGraphNodeId(spaceId, 'ha_device', deviceId),
      kind: 'ha_device',
      slug: 'lg-tv',
      title: 'LG TV',
      aliases: ['LG TV'],
      status: 'active',
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: { installationId, objectKind: 'device', objectId: deviceId },
        objectId: deviceId,
        deviceId,
      }),
    });
    const source = await store.upsertSource({
      id: 'source-lg-specs',
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'LG TV specs',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['homeassistant', 'manual'],
      status: 'indexed',
      metadata: buildHomeGraphMetadata(spaceId, installationId),
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device.id,
      relation: 'has_manual',
      metadata: buildHomeGraphMetadata(spaceId, installationId),
    });
    await store.upsertExtraction({
      id: 'extract-lg-specs',
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      excerpt: 'LG 86NANO90UNA has 4K UHD 3840 x 2160, HDR10, Dolby Vision, 120 Hz, HDMI 2.1, USB, Ethernet, Bluetooth, Wi-Fi, and 2 x 10W speakers.',
      sections: [],
      links: [],
      estimatedTokens: 32,
      structure: {},
      metadata: {},
    });
    const controller = new AbortController();
    const abortingStore = Object.create(store) as KnowledgeStore;
    abortingStore.upsertNode = async (input) => {
      const node = await store.upsertNode(input);
      if (input.kind === 'fact') controller.abort();
      return node;
    };

    await expect(refreshHomeGraphDevicePassport({
      store: abortingStore,
      artifactStore,
      spaceId,
      installationId,
      input: {
        knowledgeSpaceId: spaceId,
        deviceId,
      },
      signal: controller.signal,
    })).rejects.toThrow('Home Graph device passport refresh was cancelled');

    expect(store.listNodes(50).filter((node) => node.kind === 'fact')).toEqual([]);
    expect(store.listEdges()).not.toContainEqual(expect.objectContaining({
      fromKind: 'source',
      fromId: source.id,
      relation: 'supports_fact',
    }));
    expect(store.listSources(50).filter((entry) => entry.metadata.generatedKnowledgePage === true)).toEqual([]);
    expect(artifactStore.list(20)).toEqual([]);
  });
});
