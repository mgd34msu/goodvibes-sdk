/**
 * provider-capability-context-regression.test.ts
 *
 * Regression guards for two provider-resolution defects:
 *
 * S01 — getContextWindowForModel must NOT widen (or narrow) a model whose
 *       contextWindowProvenance === 'configured_cap', even when a fuzzy
 *       OpenRouter id (e.g. 'meta-llama/llama-3.1-8b-instruct' for a local
 *       'llama-3.1-8b-instruct') would otherwise match a larger window. The
 *       explicit user cap is authoritative.
 *
 * S05 — ProviderCapabilityRegistry.getCapability must fold a provider
 *       instance's self-declared capabilities into the cache key, so a call
 *       WITHOUT an instance cannot poison the entry a later call WITH a
 *       self-declaring instance reads back (and vice versa).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelLimitsService } from '../packages/sdk/src/platform/providers/model-limits.js';
import { ProviderCapabilityRegistry } from '../packages/sdk/src/platform/providers/capabilities.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// S01: configured_cap is authoritative over a fuzzy OpenRouter match
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'llama-3.1-8b-instruct',
    provider: 'localproxy',
    registryKey: 'localproxy:llama-3.1-8b-instruct',
    displayName: 'Llama 3.1 8B Instruct (local)',
    description: 'local model behind a capped proxy',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 65_536,
    selectable: true,
    ...overrides,
  };
}

/**
 * Build a ModelLimitsService primed with a fresh on-disk cache whose only
 * entry fuzzy-matches the local model id by trailing path segment
 * ('.../llama-3.1-8b-instruct') with a LARGER context_length (131_072).
 */
function makeServiceWithFuzzyCache(tmp: string): ModelLimitsService {
  const cachePath = join(tmp, 'model-limits.json');
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: 24 * 60 * 60 * 1000,
      models: {
        'meta-llama/llama-3.1-8b-instruct': {
          contextLength: 131_072,
          maxOutputTokens: null,
          supportedParameters: [],
        },
      },
    }),
    'utf-8',
  );
  // Guard against any background refresh attempting a real network call.
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const service = new ModelLimitsService({ cachePath });
  service.init();
  return service;
}

describe('S01: getContextWindowForModel honors configured_cap over fuzzy OpenRouter match', () => {
  test('configured_cap is NOT widened by a larger fuzzy OpenRouter entry', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-ctx-cap-'));
    try {
      const service = makeServiceWithFuzzyCache(tmp);
      const model = makeModel({ contextWindowProvenance: 'configured_cap', contextWindow: 65_536 });

      // The explicit user cap must win — never the 131_072 fuzzy match.
      expect(service.getContextWindowForModel(model)).toBe(65_536);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configured_cap is NOT narrowed when the fuzzy OpenRouter entry is smaller', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-ctx-cap-'));
    try {
      const service = makeServiceWithFuzzyCache(tmp);
      // User explicitly configured a window LARGER than the OpenRouter value.
      const model = makeModel({ contextWindowProvenance: 'configured_cap', contextWindow: 200_000 });

      expect(service.getContextWindowForModel(model)).toBe(200_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('control: a fallback-provenance model DOES consult the fuzzy OpenRouter match', () => {
    // Proves the cache really is loaded and the fuzzy endsWith match fires —
    // otherwise the configured_cap assertions above would be vacuous.
    const tmp = mkdtempSync(join(tmpdir(), 'gv-ctx-cap-'));
    try {
      const service = makeServiceWithFuzzyCache(tmp);
      const model = makeModel({ contextWindowProvenance: 'fallback', contextWindow: 65_536 });

      expect(service.getContextWindowForModel(model)).toBe(131_072);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S05: self-declared capabilities participate in the cache key
// ---------------------------------------------------------------------------

describe('S05: getCapability cache is not poisoned across provider-instance presence', () => {
  // Discovered/custom provider id with no PROVIDER_DEFAULTS entry, so the
  // resolved record depends entirely on GLOBAL_DEFAULTS + self-declared caps.
  const providerId = 'lmstudio-discovered';
  const modelId = 'local-llama-3.1-8b'; // no MODEL_OVERRIDES entry
  const selfDeclaring = { capabilities: { toolCalling: false, reasoningControls: true } };

  test('no-instance call first does NOT poison a later self-declaring call', () => {
    const registry = new ProviderCapabilityRegistry();

    // First: no instance — resolves from GLOBAL_DEFAULTS (toolCalling true).
    const withoutInstance = registry.getCapability(providerId, modelId);
    expect(withoutInstance.toolCalling).toBe(true);
    expect(withoutInstance.reasoningControls).toBe(false);

    // Then: same id pair WITH a self-declaring instance — must reflect it,
    // not return the cached defaults-only record.
    const withInstance = registry.getCapability(providerId, modelId, selfDeclaring);
    expect(withInstance.toolCalling).toBe(false);
    expect(withInstance.reasoningControls).toBe(true);
  });

  test('reverse order: self-declaring call first does NOT poison a later no-instance call', () => {
    const registry = new ProviderCapabilityRegistry();

    const withInstance = registry.getCapability(providerId, modelId, selfDeclaring);
    expect(withInstance.toolCalling).toBe(false);
    expect(withInstance.reasoningControls).toBe(true);

    // A subsequent no-instance lookup must fall back to defaults, untainted
    // by the previous self-declaration.
    const withoutInstance = registry.getCapability(providerId, modelId);
    expect(withoutInstance.toolCalling).toBe(true);
    expect(withoutInstance.reasoningControls).toBe(false);
  });

  test('identical self-declared capabilities still hit the cache (===)', () => {
    const registry = new ProviderCapabilityRegistry();
    const first = registry.getCapability(providerId, modelId, selfDeclaring);
    const second = registry.getCapability(providerId, modelId, {
      capabilities: { toolCalling: false, reasoningControls: true },
    });
    // Same resolved values and same cached frozen reference.
    expect(second).toBe(first);
  });
});
