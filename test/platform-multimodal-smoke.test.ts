/**
 * Coverage-gap smoke test — platform/multimodal
 * Instantiates MultimodalService with minimal stub dependencies and
 * invokes getStatus() and listProviders() to assert observable return shapes.
 * Closes coverage gap: platform/multimodal (eighth-review, MAJ-1 fix)
 */

import { describe, expect, test } from 'bun:test';
import { MultimodalService } from '../packages/sdk/src/platform/multimodal/service.js';

/** Minimal stub for MediaProviderRegistry — returns empty provider list. */
function makeMediaProviders() {
  return {
    status: async () => [],
  };
}

/** Minimal stub for VoiceService — returns status with empty providers. */
function makeVoiceService() {
  return {
    getStatus: async (_detail?: boolean) => ({ providers: [] }),
  };
}

/** Minimal stub for ArtifactStore — not used by getStatus/listProviders. */
function makeArtifactStore() {
  return {};
}

/** Minimal stub for KnowledgeService — not used by getStatus/listProviders. */
function makeKnowledgeService() {
  return {};
}

function makeService(): MultimodalService {
  return new MultimodalService(
    makeArtifactStore() as never,
    makeMediaProviders() as never,
    makeVoiceService() as never,
    makeKnowledgeService() as never,
  );
}

describe('platform/multimodal — behavior smoke', () => {
  test('listProviders() resolves to a readonly array', async () => {
    const service = makeService();
    const providers = await service.listProviders();
    expect(providers).toBeInstanceOf(Array);
    // With no configured media/voice providers, only the built-in extractor is present
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const extractor = providers.find((p) => p.id === 'knowledge-extractors');
    expect(extractor).toBeDefined();
    expect(typeof extractor!.id).toBe('string');
    expect(typeof extractor!.label).toBe('string');
    expect(extractor!.capabilities).toBeInstanceOf(Array);
    expect(typeof extractor!.configured).toBe('boolean');
  });

  test('getStatus() resolves with enabled, providerCount, and providers fields', async () => {
    const service = makeService();
    const status = await service.getStatus();
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.providerCount).toBe('number');
    expect(status.providers).toBeInstanceOf(Array);
    expect(status.providerCount).toBe(status.providers.length);
  });

  test('getStatus() returns consistent providerCount matching providers array length', async () => {
    const service = makeService();
    const status = await service.getStatus();
    // providerCount should always equal the length of the providers array
    expect(status.providerCount).toBe(status.providers.length);
    // enabled should be true when providers are present
    expect(status.enabled).toBe(status.providers.length > 0);
  });
});
