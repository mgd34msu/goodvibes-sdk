/**
 * The catalog lookup tables and the source label /context window and /status
 * print (TUI and agent both read describeContextWindowSource).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCatalogContextWindowIndex,
  describeContextWindowSource,
  isLocalBaseUrl,
  matchCatalogProviderId,
  needsCatalogContextWindow,
  normalizeCatalogModelId,
  resolveCatalogContextWindow,
} from '../packages/sdk/src/platform/providers/context-window-catalog.js';
import type { CatalogModel } from '../packages/sdk/src/platform/providers/model-catalog.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

function entry(providerId: string, id: string, contextWindow?: number): CatalogModel {
  return { id, name: id, provider: providerId, providerId, providerEnvVars: [], pricing: null, tier: 'paid', ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

function model(overrides: Partial<ModelDefinition>): ModelDefinition {
  return {
    id: 'm',
    provider: 'p',
    registryKey: 'p:m',
    displayName: 'm',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    ...overrides,
  };
}

describe('catalog provider ids and model ids', () => {
  const index = buildCatalogContextWindowIndex([
    entry('abacus', 'route-llm', 128_000),
    entry('xai', 'grok-9', 256_000),
    entry('openai', 'gpt-9', 400_000),
  ]);

  test('registered provider ids map to catalog ids', () => {
    expect(matchCatalogProviderId('abacusai', index)).toBe('abacus');
    expect(matchCatalogProviderId('abacus', index)).toBe('abacus');
    expect(matchCatalogProviderId('Abacus-AI', index)).toBe('abacus');
    expect(matchCatalogProviderId('x-ai', index)).toBe('xai');
    expect(matchCatalogProviderId('openai-subscriber', index, { 'openai-subscriber': 'openai' })).toBe('openai');
    expect(matchCatalogProviderId('nobody', index)).toBeNull();
  });

  test('vendor prefixes and case are ignored', () => {
    expect(normalizeCatalogModelId('Anthropic/Claude-Sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeCatalogModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  test('entries without a window count for nothing', () => {
    const sparse = buildCatalogContextWindowIndex([entry('a', 'x'), entry('b', 'x', 64_000)]);
    expect(resolveCatalogContextWindow('c', 'x', sparse)).toMatchObject({ tokens: 64_000, origin: { kind: 'consensus', providers: 1, agreeing: 1 } });
  });
});

describe('which windows are replaced', () => {
  test('the old guess, a missing window and a guess are; real figures are not', () => {
    expect(needsCatalogContextWindow(model({ contextWindowProvenance: 'configured_cap', contextWindow: 8192 }), false)).toBe(true);
    expect(needsCatalogContextWindow(model({ contextWindowProvenance: 'fallback', contextWindow: 8192 }), false)).toBe(true);
    expect(needsCatalogContextWindow(model({ contextWindow: 0 }), false)).toBe(true);
    expect(needsCatalogContextWindow(model({ contextWindowProvenance: 'configured_cap', contextWindow: 32_000 }), false)).toBe(false);
    expect(needsCatalogContextWindow(model({ contextWindowProvenance: 'provider_api', contextWindow: 8192 }), false)).toBe(false);
    expect(needsCatalogContextWindow(model({ contextWindowProvenance: 'configured_cap', contextWindow: 8192 }), true)).toBe(false);
    expect(needsCatalogContextWindow(model({ contextWindow: 8192 }), false)).toBe(false);
  });

  test('local and private addresses are local; a public https host is not', () => {
    for (const url of ['http://localhost:1234/v1', 'http://127.0.0.1:11434', 'http://[::1]:8080', 'http://192.168.1.20:1234/v1', 'http://10.0.0.5/v1', 'http://172.20.0.2/v1', 'http://box.local:1234']) {
      expect(isLocalBaseUrl(url)).toBe(true);
    }
    for (const url of ['https://routellm.abacus.ai/v1', 'https://api.openai.com/v1', 'http://172.32.0.1/v1', 'not a url']) {
      expect(isLocalBaseUrl(url)).toBe(false);
    }
  });
});

describe('the source label', () => {
  test('names the catalog provider, the consensus, or the family default', () => {
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'catalog', catalogProviderId: 'abacus' } }))).toBe('catalog: abacus');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 4, agreeing: 4 } }))).toBe('consensus of 4 providers');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 3, agreeing: 2 } }))).toBe('consensus of 3 providers (2 agree)');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 1, agreeing: 1 } }))).toBe('consensus of 1 provider');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' } }))).toBe('family default');
  });

  test('names the other sources', () => {
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'user_override' } }))).toBe('user override');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'provider_file' } }))).toBe('provider file');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'provider_api' }))).toBe('reported by the provider');
    expect(describeContextWindowSource(model({ contextWindowProvenance: 'observed_limit' }))).toBe('learned from a provider rejection');
    expect(describeContextWindowSource(model({}))).toBe('model catalog');
  });
});
