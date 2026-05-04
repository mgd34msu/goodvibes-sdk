/**
 * Coverage-gap smoke test — platform/web-search/providers
 * Verifies that each web-search provider factory loads and exports expected symbols.
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

describe('platform/web-search/providers — module load smoke', () => {
  test('createBraveSearchProvider is a function', () => {
    expect(typeof createBraveSearchProvider).toBe('function');
  });

  test('createDuckDuckGoProvider is a function', () => {
    expect(typeof createDuckDuckGoProvider).toBe('function');
  });

  test('createExaSearchProvider is a function', () => {
    expect(typeof createExaSearchProvider).toBe('function');
  });

  test('createFirecrawlSearchProvider is a function', () => {
    expect(typeof createFirecrawlSearchProvider).toBe('function');
  });

  test('createPerplexitySearchProvider is a function', () => {
    expect(typeof createPerplexitySearchProvider).toBe('function');
  });

  test('createSearxngSearchProvider is a function', () => {
    expect(typeof createSearxngSearchProvider).toBe('function');
  });

  test('createTavilySearchProvider is a function', () => {
    expect(typeof createTavilySearchProvider).toBe('function');
  });
});
