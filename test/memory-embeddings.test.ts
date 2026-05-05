import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import {
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingProvider,
} from '../packages/sdk/src/platform/state/memory-embeddings.ts';

function makeRegistry(): MemoryEmbeddingProviderRegistry {
  const configManager = new ConfigManager({
    configDir: join(tmpdir(), `gv-memory-embeddings-${randomUUID()}`),
  });
  return new MemoryEmbeddingProviderRegistry({ configManager });
}

describe('MemoryEmbeddingProviderRegistry', () => {
  test('does not substitute hashed embeddings when an explicit async provider fails', async () => {
    const registry = makeRegistry();
    const provider: MemoryEmbeddingProvider = {
      id: 'explicit-remote',
      label: 'Explicit Remote',
      dimensions: 384,
      async embed() {
        throw new Error('remote unavailable');
      },
    };

    registry.register(provider, { makeDefault: true });

    await expect(registry.embedAsync({
      text: 'important memory',
      dimensions: 384,
      usage: 'record',
    })).rejects.toThrow('remote unavailable');
  });

  test('does not substitute hashed embeddings for async-only providers in sync calls', () => {
    const registry = makeRegistry();
    const provider: MemoryEmbeddingProvider = {
      id: 'async-only',
      label: 'Async Only',
      dimensions: 384,
      async embed() {
        return {
          vector: new Float32Array(384),
          dimensions: 384,
        };
      },
    };

    registry.register(provider, { makeDefault: true });

    expect(() => registry.embedSync({
      text: 'live write',
      dimensions: 384,
      usage: 'record',
    })).toThrow("does not support synchronous embeddings");
  });

  test('does not change the active provider when default persistence fails', () => {
    const configManager = new ConfigManager({
      configDir: join(tmpdir(), `gv-memory-embeddings-${randomUUID()}`),
    });
    const originalSet = configManager.set.bind(configManager);
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const provider: MemoryEmbeddingProvider = {
      id: 'remote-default',
      label: 'Remote Default',
      dimensions: 384,
      embedSync(request) {
        return {
          vector: new Float32Array(request.dimensions),
          dimensions: request.dimensions,
        };
      },
    };

    configManager.set = (() => {
      throw new Error('disk unavailable');
    }) as typeof configManager.set;

    expect(() => registry.register(provider, { makeDefault: true })).toThrow('disk unavailable');
    expect(registry.getDefaultProviderId()).toBe('hashed-local');

    configManager.set = originalSet;
  });
});
