/**
 * Coverage-gap smoke test — platform/web-search/providers
 * Constructs each web-search provider with minimal context and asserts
 * the provider returns the correct shape.
 * Closes coverage gap: platform/web-search/providers per-provider (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { createBraveSearchProvider } from '../packages/sdk/src/platform/web-search/providers/brave.js';
import { createDuckDuckGoProvider } from '../packages/sdk/src/platform/web-search/providers/duckduckgo.js';
import { createExaSearchProvider } from '../packages/sdk/src/platform/web-search/providers/exa.js';
import { createFirecrawlSearchProvider } from '../packages/sdk/src/platform/web-search/providers/firecrawl.js';
import { createPerplexitySearchProvider } from '../packages/sdk/src/platform/web-search/providers/perplexity.js';
import { createSearxngSearchProvider } from '../packages/sdk/src/platform/web-search/providers/searxng.js';
import { createTavilySearchProvider } from '../packages/sdk/src/platform/web-search/providers/tavily.js';

/** Minimal SearchProviderContext with no env and a noop serviceRegistry. */
function makeContext() {
  return {
    env: {} as Record<string, string | undefined>,
    serviceRegistry: { get: (_id: string) => undefined },
  };
}

function assertProviderShape(
  provider: { id: string; label: string; capabilities: readonly string[]; descriptor: () => unknown; search: (...args: unknown[]) => unknown },
  expectedId: string,
) {
  expect(typeof provider.id).toBe('string');
  expect(provider.id).toBe(expectedId);
  expect(typeof provider.label).toBe('string');
  expect(Array.isArray(provider.capabilities)).toBe(true);
  expect(typeof provider.descriptor).toBe('function');
  expect(typeof provider.search).toBe('function');
  // descriptor() returns {id, label}
  const desc = provider.descriptor() as Record<string, unknown>;
  expect(typeof desc.id).toBe('string');
  expect(typeof desc.label).toBe('string');
}

describe('platform/web-search/providers — behavior smoke', () => {
  test('createBraveSearchProvider returns correct provider shape', () => {
    const provider = createBraveSearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'brave');
  });

  test('createDuckDuckGoProvider returns correct provider shape (takes options, not context)', () => {
    // DuckDuckGo takes DuckDuckGoProviderOptions ({}), not SearchProviderContext
    const provider = createDuckDuckGoProvider({}) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'duckduckgo');
  });

  test('createExaSearchProvider returns correct provider shape', () => {
    const provider = createExaSearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'exa');
  });

  test('createFirecrawlSearchProvider returns correct provider shape', () => {
    const provider = createFirecrawlSearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'firecrawl');
  });

  test('createPerplexitySearchProvider returns correct provider shape', () => {
    const provider = createPerplexitySearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'perplexity');
  });

  test('createSearxngSearchProvider returns correct provider shape', () => {
    const provider = createSearxngSearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'searxng');
  });

  test('createTavilySearchProvider returns correct provider shape', () => {
    const provider = createTavilySearchProvider(makeContext()) as Parameters<typeof assertProviderShape>[0];
    assertProviderShape(provider, 'tavily');
  });
});
