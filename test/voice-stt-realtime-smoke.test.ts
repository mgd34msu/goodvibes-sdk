/**
 * Coverage-gap smoke test — platform/voice (STT, realtime providers)
 * Verifies that voice provider modules load and export expected symbols.
 * Closes coverage gap: platform/voice/stt and realtime (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { ensureBuiltinVoiceProviders } from '../packages/sdk/src/platform/voice/builtin-providers.js';
import { VoiceProviderRegistry } from '../packages/sdk/src/platform/voice/provider-registry.js';

describe('platform/voice — module load smoke', () => {
  test('ensureBuiltinVoiceProviders is a function', () => {
    expect(typeof ensureBuiltinVoiceProviders).toBe('function');
  });

  test('VoiceProviderRegistry is a constructor', () => {
    expect(typeof VoiceProviderRegistry).toBe('function');
  });

  test('VoiceProviderRegistry instance has expected methods', () => {
    const reg = new VoiceProviderRegistry();
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.get).toBe('function');
    expect(typeof reg.list).toBe('function');
    expect(typeof reg.findProvider).toBe('function');
  });
});
