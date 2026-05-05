/**
 * Coverage-gap smoke test — platform/voice (STT, realtime providers)
 * Verifies VoiceProviderRegistry can register a mock provider and query it.
 * Closes coverage gap: platform/voice/stt and realtime
 */

import { describe, expect, test } from 'bun:test';
import { ensureBuiltinVoiceProviders } from '../packages/sdk/src/platform/voice/builtin-providers.js';
import { VoiceProviderRegistry } from '../packages/sdk/src/platform/voice/provider-registry.js';

const MOCK_PROVIDER = {
  id: 'test-stt-provider',
  label: 'Test STT Provider',
  capabilities: ['stt' as const],
};

describe('platform/voice — behavior smoke', () => {
  test('register + get returns the registered provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    // VoiceProviderRegistry.get() returns null on miss, not undefined
    const found = registry.get(MOCK_PROVIDER.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(MOCK_PROVIDER.id);
    expect(found?.label).toBe(MOCK_PROVIDER.label);
  });

  test('list includes the registered provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    const all = registry.list();
    expect(all).toBeInstanceOf(Array);
    const ids = all.map((p) => p.id);
    expect(ids).toContain(MOCK_PROVIDER.id);
  });

  test('findProvider by capability returns the mock provider', () => {
    const registry = new VoiceProviderRegistry();
    registry.register(MOCK_PROVIDER);
    const found = registry.findProvider('stt');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(MOCK_PROVIDER.id);
  });

  test('get on unknown id returns null (not undefined)', () => {
    const registry = new VoiceProviderRegistry();
    const result = registry.get('unknown-provider-id');
    expect(result).toBeNull();
  });

  test('ensureBuiltinVoiceProviders does not throw when called with a registry', () => {
    const registry = new VoiceProviderRegistry();
    expect(() => ensureBuiltinVoiceProviders(registry)).not.toThrow();
  });
});
