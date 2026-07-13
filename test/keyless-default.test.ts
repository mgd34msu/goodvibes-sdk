/**
 * keyless-default.test.ts — the keyless default actually works (or honestly
 * asks for a key).
 *
 * The shipped default model (`provider.model` = openrouter:openrouter/free)
 * was promised keyless by hand-written onboarding copy while openrouter is
 * registered auth-required (authEnvVars, no allowAnonymous) — a fresh
 * install's first prompt died in a wire 401. Covers:
 *   - readiness DERIVED from the provider's registered auth state
 *   - copy GENERATED from readiness — the "no API key needed" promise is
 *     structurally unwritable for an auth-required provider
 *   - RED TEST: a keyless-default claim pointing at an auth-required provider
 *     fails the pairing gate
 *   - the copy for the real shipped default + real builtin registration state
 *     matches live reality (no key ⇒ honestly asks; key ⇒ configured)
 *   - no dead-end 401: an unconfigured compat provider's chat() refuses the
 *     request BEFORE the wire, naming the env var it needs
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDefaultModelReadiness,
  buildOnboardingModelCopy,
  assertKeylessDefaultPairing,
  type ModelProviderSource,
} from '../packages/sdk/src/platform/providers/keyless-default.ts';
import { OpenAICompatProvider } from '../packages/sdk/src/platform/providers/openai-compat.ts';
import { AnthropicCompatProvider } from '../packages/sdk/src/platform/providers/anthropic-compat.ts';
import { registerBuiltinProviders } from '../packages/sdk/src/platform/providers/builtin-registry.ts';
import { coreConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-core.ts';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.ts';
import { ProviderError } from '../packages/sdk/src/platform/types/errors.ts';

/** The openrouter registration shape from builtin-registry.ts, keyless-install state. */
function openrouterLike(apiKey = ''): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'openrouter',
    baseURL: 'http://127.0.0.1:1/v1', // never reached in these tests
    apiKey,
    defaultModel: 'openrouter/free',
    models: ['openrouter/free'],
    modelsAsOf: '2026-07-12',
    modelListing: 'none',
    reasoningFormat: 'openrouter',
    authEnvVars: ['OPENROUTER_API_KEY'],
    serviceNames: ['openrouter'],
  });
}

function anonymousLike(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'local-anon',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'gv-local',
    authConfigured: false,
    defaultModel: 'local-model',
    models: ['local-model'],
    modelsAsOf: '2026-07-12',
    modelListing: 'none',
    allowAnonymous: true,
    anonymousConfigured: true,
  });
}

function sourceFor(provider: LLMProvider): ModelProviderSource {
  return { getForModel: () => provider };
}

// ── Readiness derivation from registered auth state ──────────────────────────

describe('resolveDefaultModelReadiness', () => {
  test('auth-required provider with no key → needs-key, naming the env var', () => {
    const readiness = resolveDefaultModelReadiness(sourceFor(openrouterLike()), 'openrouter:openrouter/free');
    expect(readiness).toEqual({
      kind: 'needs-key',
      modelKey: 'openrouter:openrouter/free',
      provider: 'openrouter',
      authEnvVars: ['OPENROUTER_API_KEY'],
    });
  });

  test('auth-required provider WITH a key → configured', () => {
    const readiness = resolveDefaultModelReadiness(sourceFor(openrouterLike('sk-live')), 'openrouter:openrouter/free');
    expect(readiness.kind).toBe('configured');
  });

  test('genuinely anonymous-ready provider → keyless', () => {
    const readiness = resolveDefaultModelReadiness(sourceFor(anonymousLike()), 'local-anon:local-model');
    expect(readiness.kind).toBe('keyless');
  });

  test('unresolvable model key is an honest answer, not a throw', () => {
    const readiness = resolveDefaultModelReadiness(
      { getForModel: () => { throw new Error("No model 'nope' in registry."); } },
      'nope',
    );
    expect(readiness.kind).toBe('unresolvable');
    expect((readiness as { detail: string }).detail).toContain("No model 'nope'");
  });
});

// ── Copy generation: a false keyless promise is structurally unwritable ──────

describe('buildOnboardingModelCopy', () => {
  test('only the keyless readiness can produce the "no API key needed" promise', () => {
    const keyless = buildOnboardingModelCopy(
      resolveDefaultModelReadiness(sourceFor(anonymousLike()), 'local-anon:local-model'),
    );
    expect(keyless.keyless).toBe(true);
    expect(keyless.detail).toContain('no API key needed');

    const nonKeyless = [
      resolveDefaultModelReadiness(sourceFor(openrouterLike()), 'openrouter:openrouter/free'),
      resolveDefaultModelReadiness(sourceFor(openrouterLike('sk-live')), 'openrouter:openrouter/free'),
      resolveDefaultModelReadiness({ getForModel: () => { throw new Error('x'); } }, 'nope'),
    ];
    for (const readiness of nonKeyless) {
      const copy = buildOnboardingModelCopy(readiness);
      expect(copy.keyless).toBe(false);
      expect(`${copy.headline} ${copy.detail}`).not.toContain('no API key');
    }
  });

  test('needs-key copy honestly asks for the key by env-var name', () => {
    const copy = buildOnboardingModelCopy(
      resolveDefaultModelReadiness(sourceFor(openrouterLike()), 'openrouter:openrouter/free'),
    );
    expect(copy.headline).toContain('Add an API key');
    expect(copy.detail).toContain('OPENROUTER_API_KEY');
    expect(copy.detail).toContain('openrouter');
  });
});

// ── RED TEST: the pairing gate ────────────────────────────────────────────────

describe('assertKeylessDefaultPairing', () => {
  test('RED: a keyless-default claim pointing at an auth-required provider FAILS', () => {
    expect(() => assertKeylessDefaultPairing(sourceFor(openrouterLike()), 'openrouter:openrouter/free'))
      .toThrow(/Keyless-default pairing violated.*openrouter.*OPENROUTER_API_KEY/s);
  });

  test('RED: a keyless claim on an unresolvable default FAILS', () => {
    expect(() => assertKeylessDefaultPairing({ getForModel: () => { throw new Error('gone'); } }, 'ghost:model'))
      .toThrow(/Keyless-default pairing violated/);
  });

  test('a genuinely anonymous-ready pairing passes', () => {
    expect(() => assertKeylessDefaultPairing(sourceFor(anonymousLike()), 'local-anon:local-model'))
      .not.toThrow();
  });
});

// ── The real shipped default against the real builtin registration state ─────

describe('shipped default model × live builtin registration', () => {
  function registerBuiltins(apiKey: (name: string) => string): Map<string, LLMProvider> {
    const captured = new Map<string, LLMProvider>();
    registerBuiltinProviders(
      { register: (p) => captured.set(p.name, p) },
      (name) => captured.has(name),
      apiKey,
      {
        resolveProvider: (n) => captured.get(n)!,
        getCatalogModels: () => [],
        getBenchmarks: () => undefined,
        githubCopilotTokenCachePath: join(mkdtempSync(join(tmpdir(), 'gv-keyless-')), 'copilot.json'),
        subscriptionManager: {
          get: () => null,
          getPending: () => null,
          saveSubscription: () => {},
          resolveAccessToken: async () => null,
        } as never,
        persistenceRoot: mkdtempSync(join(tmpdir(), 'gv-keyless-root-')),
      },
    );
    return captured;
  }

  test('fresh install (no keys anywhere): the shipped default honestly asks for a key — never promises keyless', () => {
    const providers = registerBuiltins(() => '');
    const defaultModelKey = coreConfigDefaults.provider.model; // the REAL shipped default
    const providerId = defaultModelKey.split(':')[0]!;
    const provider = providers.get(providerId);
    expect(provider).toBeDefined();

    const readiness = resolveDefaultModelReadiness({ getForModel: () => provider! }, defaultModelKey);
    const copy = buildOnboardingModelCopy(readiness);

    // Live reality this cycle: openrouter 401s without a key. The generated
    // copy must ask for the key — and the keyless promise must be absent.
    expect(readiness.kind).toBe('needs-key');
    expect(copy.keyless).toBe(false);
    expect(`${copy.headline} ${copy.detail}`).not.toContain('no API key');
    expect(copy.detail).toContain('OPENROUTER_API_KEY');

    // And the pairing gate red-flags any surface still claiming keyless.
    expect(() => assertKeylessDefaultPairing({ getForModel: () => provider! }, defaultModelKey)).toThrow();
  });

  test('with a key configured, the same derivation reports configured (copy flips honestly)', () => {
    const providers = registerBuiltins((name) => (name === 'openrouter' ? 'sk-live' : ''));
    const defaultModelKey = coreConfigDefaults.provider.model;
    const provider = providers.get(defaultModelKey.split(':')[0]!)!;
    const readiness = resolveDefaultModelReadiness({ getForModel: () => provider }, defaultModelKey);
    expect(readiness.kind).toBe('configured');
    const copy = buildOnboardingModelCopy(readiness);
    expect(copy.headline).toBe('Start now');
    expect(copy.keyless).toBe(false);
  });
});

// ── No dead-end 401: chat() refuses before the wire ──────────────────────────

describe('unconfigured provider chat preflight', () => {
  test('OpenAI-compat: chat() rejects with the honest ask-for-key error, request never sent', async () => {
    const provider = openrouterLike();
    expect(provider.isConfigured()).toBe(false);
    const started = Date.now();
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter/free' }))
      .rejects.toThrow(/no API key configured.*was not sent.*OPENROUTER_API_KEY/s);
    // Preflight, not a network failure: rejects immediately (no retry loop).
    expect(Date.now() - started).toBeLessThan(1_000);
    try {
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter/free' });
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
    }
  });

  test('Anthropic-compat: same preflight, same honest copy', async () => {
    const provider = new AnthropicCompatProvider({
      name: 'anthro-compat-test',
      baseURL: 'http://127.0.0.1:1',
      apiKey: '',
      defaultModel: 'm',
      models: ['m'],
      modelsAsOf: '2026-07-12',
      modelListing: 'none',
      authEnvVars: ['ANTHRO_TEST_KEY'],
    });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }))
      .rejects.toThrow(/no API key configured.*was not sent.*ANTHRO_TEST_KEY/s);
  });

  test('an anonymous-ready provider passes the preflight (fails later on the unreachable host, NOT on auth)', async () => {
    const provider = anonymousLike();
    expect(provider.isConfigured()).toBe(true);
    try {
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'local-model' });
      throw new Error('expected the unreachable host to fail');
    } catch (err) {
      expect(String(err)).not.toContain('no API key configured');
    }
  }, 30_000);
});
