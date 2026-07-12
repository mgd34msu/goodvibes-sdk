/**
 * Shared live-model-discovery machinery: TTL cache respect/bypass, the
 * live -> cache -> dated-static fallback chain, diffing, and reporting.
 * Every scenario proves the model list is never a silent, undated snapshot.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffModelIds,
  formatModelDiscoveryReport,
  getProviderModelsCachePath,
  runLiveModelRefresh,
} from '../packages/sdk/src/platform/providers/live-model-discovery.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-live-model-discovery-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('diffModelIds', () => {
  test('reports additions and removals independent of order', () => {
    const { added, removed } = diffModelIds(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(added).toEqual(['d']);
    expect(removed).toEqual(['a']);
  });

  test('no changes yields empty arrays', () => {
    const { added, removed } = diffModelIds(['a', 'b'], ['b', 'a']);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('runLiveModelRefresh — not configured', () => {
  test('falls back to the dated-static list with an asOf label, never a bare empty array', async () => {
    const result = await runLiveModelRefresh({
      providerName: 'test-provider',
      datedStaticModels: ['model-a', 'model-b'],
      datedStaticAsOf: '2026-07-12',
      isConfigured: false,
      fetchLive: async () => { throw new Error('should not be called'); },
    });
    expect(result.source).toBe('dated-static');
    expect(result.models).toEqual(['model-a', 'model-b']);
    expect(result.asOf).toBe('2026-07-12');
  });
});

describe('runLiveModelRefresh — live fetch success', () => {
  test('reports added/removed against the dated-static baseline on first run and persists a cache', () =>
    withTempDir(async (dir) => {
      const cachePath = join(dir, 'test-provider.json');
      const result = await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive: async () => ['model-a', 'model-c'],
      });
      expect(result.source).toBe('live');
      expect(result.models).toEqual(['model-a', 'model-c']);
      expect(result.added).toEqual(['model-c']);
      expect(result.removed).toEqual(['model-b']);
      expect(formatModelDiscoveryReport('test-provider', result)).toBe('test-provider: 1 new, 1 retired');
    }));

  test('a second force refresh with the same live result reports no changes', () =>
    withTempDir(async (dir) => {
      const cachePath = join(dir, 'test-provider.json');
      const fetchLive = async () => ['model-a', 'model-c'];
      await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
        force: true,
      });
      const second = await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
        force: true,
      });
      expect(second.source).toBe('live');
      expect(second.added).toEqual([]);
      expect(second.removed).toEqual([]);
      expect(formatModelDiscoveryReport('test-provider', second)).toBe('test-provider: no changes (2 models)');
    }));
});

describe('runLiveModelRefresh — TTL cache respected unless forced', () => {
  test('a fresh on-disk cache short-circuits the live fetch when force is not set', () =>
    withTempDir(async (dir) => {
      const cachePath = join(dir, 'test-provider.json');
      let fetchCount = 0;
      const fetchLive = async () => {
        fetchCount++;
        return ['model-a', 'model-c'];
      };
      await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
      });
      expect(fetchCount).toBe(1);

      const second = await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
      });
      expect(fetchCount).toBe(1); // not re-fetched
      expect(second.source).toBe('cache');
      expect(second.models).toEqual(['model-a', 'model-c']);
    }));

  test('force: true bypasses a fresh cache and re-checks live', () =>
    withTempDir(async (dir) => {
      const cachePath = join(dir, 'test-provider.json');
      let fetchCount = 0;
      const fetchLive = async () => {
        fetchCount++;
        return ['model-a', 'model-c'];
      };
      await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
      });
      const second = await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a', 'model-b'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive,
        force: true,
      });
      expect(fetchCount).toBe(2);
      expect(second.source).toBe('live');
    }));
});

describe('runLiveModelRefresh — honest failure reporting', () => {
  test('a live fetch failure with a prior cache falls back to the cache and reports the real error', () =>
    withTempDir(async (dir) => {
      const cachePath = join(dir, 'test-provider.json');
      await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive: async () => ['model-a', 'model-b'],
      });
      const result = await runLiveModelRefresh({
        providerName: 'test-provider',
        cachePath,
        datedStaticModels: ['model-a'],
        datedStaticAsOf: '2026-07-12',
        isConfigured: true,
        fetchLive: async () => { throw new Error('connection reset'); },
        force: true,
      });
      expect(result.source).toBe('cache');
      expect(result.models).toEqual(['model-a', 'model-b']);
      expect(result.error).toContain('connection reset');
      expect(formatModelDiscoveryReport('test-provider', result)).toContain('connection reset');
    }));

  test('a live fetch failure with no prior cache falls back to the dated-static list and reports the real error', async () => {
    const result = await runLiveModelRefresh({
      providerName: 'test-provider',
      datedStaticModels: ['model-a', 'model-b'],
      datedStaticAsOf: '2026-07-12',
      isConfigured: true,
      fetchLive: async () => { throw new Error('401 unauthorized') },
    });
    expect(result.source).toBe('dated-static');
    expect(result.models).toEqual(['model-a', 'model-b']);
    expect(result.error).toContain('401 unauthorized');
    expect(result.asOf).toBe('2026-07-12');
  });

  test('an empty live response is treated as a failure, not a valid (empty) model list', async () => {
    const result = await runLiveModelRefresh({
      providerName: 'test-provider',
      datedStaticModels: ['model-a'],
      datedStaticAsOf: '2026-07-12',
      isConfigured: true,
      fetchLive: async () => [],
    });
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.source).toBe('dated-static');
    expect(result.error).toBeDefined();
  });
});

describe('getProviderModelsCachePath', () => {
  test('builds a stable per-provider path under a provider-models subdirectory', () => {
    const path = getProviderModelsCachePath('/home/user/.goodvibes', 'anthropic');
    expect(path).toBe(join('/home/user/.goodvibes', 'provider-models', 'anthropic.json'));
  });
});
