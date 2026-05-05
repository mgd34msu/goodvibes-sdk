import { describe, expect, test } from 'bun:test';
import {
  compareHomeGraphPageSources,
  homeGraphPageSourceWeight,
  isUsefulHomeGraphPageSource,
  isUsefulHomeGraphPageSourceCandidate,
} from '../packages/sdk/src/platform/knowledge/home-graph/page-quality.js';
import type { KnowledgeSourceRecord } from '../packages/sdk/src/platform/knowledge/types.js';

const FIXED_TEST_EPOCH_MS = Date.UTC(2026, 0, 1);

function source(overrides: Partial<KnowledgeSourceRecord>): KnowledgeSourceRecord {
  return {
    id: 'source-test',
    connectorId: 'test',
    sourceType: 'url',
    title: 'Source',
    tags: [],
    status: 'indexed',
    metadata: {},
    createdAt: FIXED_TEST_EPOCH_MS,
    updatedAt: FIXED_TEST_EPOCH_MS,
    ...overrides,
  };
}

describe('Home Graph page source quality', () => {
  test('keeps official indexed evidence and rejects generated or commercial sources', () => {
    const official = source({
      id: 'official',
      title: 'Vendor product specifications',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generated = source({
      id: 'generated',
      metadata: { generatedKnowledgePage: true, generatedProjection: true },
    });
    const commercial = source({
      id: 'commercial',
      title: 'Latest price and ranking system',
      sourceUri: 'https://store.example/prices-features',
      summary: 'Buy now using affiliate links.',
    });

    expect(isUsefulHomeGraphPageSource(official)).toBe(true);
    expect(isUsefulHomeGraphPageSource(generated)).toBe(false);
    expect(isUsefulHomeGraphPageSource(commercial)).toBe(false);
  });

  test('weights and sorts stronger evidence ahead of generic sources', () => {
    const official = source({
      id: 'official',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generic = source({
      id: 'generic',
      sourceUri: 'https://example.org/blog/device-overview',
      metadata: {},
    });

    expect(homeGraphPageSourceWeight(official)).toBe(0.98);
    expect(homeGraphPageSourceWeight(generic)).toBe(0.25);
    expect([generic, official].sort(compareHomeGraphPageSources).map((item) => item.id)).toEqual(['official', 'generic']);
    expect(isUsefulHomeGraphPageSourceCandidate(official)).toBe(true);
  });

  test('recognizes official evidence carried only in url aliases', () => {
    const officialUrlOnly = source({
      id: 'official-url-only',
      url: 'https://vendor.example/support/product/specifications',
      metadata: {
        sourceDiscovery: {
          trustReason: 'official-vendor-domain',
          sourceRank: 1,
        },
      },
    });
    const generic = source({
      id: 'generic',
      sourceUri: 'https://example.org/blog/device-overview',
      metadata: {},
    });

    expect(homeGraphPageSourceWeight(officialUrlOnly)).toBe(0.98);
    expect(homeGraphPageSourceWeight(generic)).toBe(0.25);
    expect(isUsefulHomeGraphPageSourceCandidate(officialUrlOnly)).toBe(true);
  });

  test('rejects marketplace sources even when they look product-specific', () => {
    const marketplace = source({
      id: 'marketplace',
      title: 'Vendor model store listing',
      url: 'https://www.amazon.com/example-product',
      summary: 'Sponsored marketplace listing with latest price and seller details.',
      metadata: {
        sourceDiscovery: {
          trustReason: 'model-match',
          sourceRank: 1,
        },
      },
    });

    expect(isUsefulHomeGraphPageSource(marketplace)).toBe(false);
    expect(isUsefulHomeGraphPageSourceCandidate(marketplace)).toBe(false);
  });

  test('keeps relevant pending support/spec sources so generated pages can link accepted repair evidence', () => {
    const pendingSupport = source({
      id: 'pending-support',
      status: 'pending',
      title: 'Vendor support specifications',
      sourceUri: 'https://vendor.example/support/product/specifications',
      metadata: {},
    });
    const pendingCommercial = source({
      id: 'pending-commercial',
      status: 'pending',
      title: 'Latest price comparison and affiliate ranking',
      sourceUri: 'https://shop.example/product/latest-price',
      metadata: {},
    });

    expect(isUsefulHomeGraphPageSource(pendingSupport)).toBe(true);
    expect(isUsefulHomeGraphPageSource(pendingCommercial)).toBe(false);
  });
});
