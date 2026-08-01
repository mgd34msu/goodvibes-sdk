/**
 * provider-model-parsing.test.ts
 *
 * The tolerant readers for the `provider.model` config value, and the line
 * between them and the strict registry-key reader they sit next to.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.ts';
import {
  formatProviderModel,
  getModelIdFromProviderModel,
  getProviderIdFromModel,
} from '../packages/sdk/src/platform/providers/provider-model.ts';
import { splitModelRegistryKey } from '../packages/sdk/src/platform/providers/registry-helpers.ts';
import { getConfiguredProviderId } from '../packages/sdk/src/platform/config/index.ts';

const defaultProvider = getProviderIdFromModel(DEFAULT_CONFIG.provider.model);
const defaultModel = String(DEFAULT_CONFIG.provider.model);

describe('getProviderIdFromModel', () => {
  test('splits a qualified value at the first colon', () => {
    expect(getProviderIdFromModel('anthropic:claude-fable-5')).toBe('anthropic');
    // A model id that itself carries a colon keeps it — only the FIRST colon separates.
    expect(getProviderIdFromModel('bedrock:us.anthropic.claude-fable-5-v1:0')).toBe('bedrock');
  });

  test('reads a bare value as the provider', () => {
    expect(getProviderIdFromModel('ollama')).toBe('ollama');
  });

  test('falls back to the configured default for empty, blank, null and undefined', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(getProviderIdFromModel(value)).toBe(defaultProvider);
    }
  });

  test('trims surrounding whitespace before splitting', () => {
    expect(getProviderIdFromModel('  anthropic:claude-fable-5  ')).toBe('anthropic');
  });

  test('a leading colon is not a separator — the whole value is the provider', () => {
    // indexOf(':') === 0 is not > 0, so there is no provider half to take.
    expect(getProviderIdFromModel(':claude-fable-5')).toBe(':claude-fable-5');
  });
});

describe('getModelIdFromProviderModel', () => {
  test('takes everything after the first colon', () => {
    expect(getModelIdFromProviderModel('anthropic:claude-fable-5')).toBe('claude-fable-5');
    expect(getModelIdFromProviderModel('bedrock:us.anthropic.claude-fable-5-v1:0'))
      .toBe('us.anthropic.claude-fable-5-v1:0');
  });

  test('reads a bare value as the model', () => {
    expect(getModelIdFromProviderModel('claude-fable-5')).toBe('claude-fable-5');
  });

  test('falls back to the configured default for empty, blank, null and undefined', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(getModelIdFromProviderModel(value)).toBe(defaultModel);
    }
  });
});

describe('formatProviderModel', () => {
  test('composes the two halves', () => {
    expect(formatProviderModel('anthropic', 'claude-fable-5')).toBe('anthropic:claude-fable-5');
  });

  test('leaves an already-qualified model alone rather than double-qualifying it', () => {
    expect(formatProviderModel('anthropic', 'openrouter:anthropic/claude-fable-5'))
      .toBe('openrouter:anthropic/claude-fable-5');
  });

  test('a blank provider yields the bare model', () => {
    expect(formatProviderModel('', 'claude-fable-5')).toBe('claude-fable-5');
    expect(formatProviderModel('   ', 'claude-fable-5')).toBe('claude-fable-5');
  });

  test('a blank model yields the provider with its separator, so the value stays parseable', () => {
    expect(formatProviderModel('anthropic', '')).toBe('anthropic:');
    expect(getProviderIdFromModel(formatProviderModel('anthropic', ''))).toBe('anthropic');
  });

  test('round-trips a qualified value through both readers', () => {
    const composed = formatProviderModel('openrouter', 'anthropic/claude-fable-5');
    expect(getProviderIdFromModel(composed)).toBe('openrouter');
    expect(getModelIdFromProviderModel(composed)).toBe('anthropic/claude-fable-5');
  });
});

describe('tolerant readers vs the strict registry-key reader', () => {
  test('agree on a well-formed provider-qualified key', () => {
    const key = 'openrouter:anthropic/claude-fable-5';
    const strict = splitModelRegistryKey(key);
    expect(strict.providerId).toBe(getProviderIdFromModel(key));
    expect(strict.resolvedModelId).toBe(getModelIdFromProviderModel(key));
  });

  test('differ exactly where they are meant to: the strict one refuses what config may hold', () => {
    // A bare value is a legitimate config state and a defect at a registry-key
    // call site — that difference is the reason both exist.
    expect(() => splitModelRegistryKey('ollama')).toThrow();
    expect(getProviderIdFromModel('ollama')).toBe('ollama');

    expect(() => splitModelRegistryKey('')).toThrow();
    expect(getProviderIdFromModel('')).toBe(defaultProvider);
  });
});

describe('getConfiguredProviderId', () => {
  test('reads provider.model through the tolerant parser', () => {
    expect(getConfiguredProviderId({ get: (() => 'anthropic:claude-fable-5') as never })).toBe('anthropic');
  });

  test('a config holding a bare id yields that id rather than throwing', () => {
    expect(getConfiguredProviderId({ get: (() => 'ollama') as never })).toBe('ollama');
  });

  test('a config holding a blank value yields the default provider', () => {
    expect(getConfiguredProviderId({ get: (() => '') as never })).toBe(defaultProvider);
  });
});
