/**
 * The defect this pins (live on two hosts, 2026-08-06): an UNNAMED STT request
 * resolved to the FIRST registered provider with the capability, OpenAI, by
 * builtin registration order, even when the host carried a fully provisioned
 * local whisper and no OpenAI key. The call then failed "OpenAI API key
 * missing" while the engine the user configured was never asked.
 *
 * The rule now: unnamed requests prefer providers that report configured, with
 * a configured 'local' first; nothing-configured falls back to the old
 * first-registered pick so the error still names one concrete provider; a
 * NAMED provider keeps exact findProvider semantics.
 */
import { describe, expect, test } from 'bun:test';
import { VoiceProviderRegistry } from '../packages/sdk/src/platform/voice/provider-registry.js';
import type { VoiceProvider, VoiceProviderStatus } from '../packages/sdk/src/platform/voice/types.js';

function provider(
  id: string,
  configured: boolean,
  capabilities: VoiceProvider['capabilities'] = ['stt', 'tts'],
): VoiceProvider {
  return {
    id,
    label: id,
    capabilities,
    status(): VoiceProviderStatus {
      return {
        id,
        label: id,
        state: configured ? 'healthy' : 'unconfigured',
        capabilities,
        configured,
        metadata: {},
      };
    },
  } as VoiceProvider;
}

describe('unnamed voice requests resolve by configured state, not registration order', () => {
  test('the original defect: unconfigured cloud first, configured local last — local wins now', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('openai', false));
    registry.register(provider('deepgram', false));
    registry.register(provider('local', true));

    // The old behavior this replaces: first-registered wins regardless of state.
    expect(registry.findProvider('stt')?.id).toBe('openai');

    // The rule now: the configured local engine is what an unnamed request gets.
    const resolved = await registry.resolveProvider('stt');
    expect(resolved?.id).toBe('local');
  });

  test('configured local beats other CONFIGURED providers too', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('elevenlabs', true));
    registry.register(provider('local', true));
    expect((await registry.resolveProvider('tts'))?.id).toBe('local');
  });

  test('unconfigured local loses to a configured cloud provider', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('openai', true));
    registry.register(provider('local', false));
    expect((await registry.resolveProvider('stt'))?.id).toBe('openai');
  });

  test('nothing configured falls back to first-registered so the error names a provider', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('openai', false));
    registry.register(provider('local', false));
    expect((await registry.resolveProvider('stt'))?.id).toBe('openai');
  });

  test('a NAMED provider keeps exact semantics, configured or not', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('openai', false));
    registry.register(provider('local', true));
    expect((await registry.resolveProvider('stt', 'openai'))?.id).toBe('openai');
    expect(await registry.resolveProvider('stt', 'absent')).toBeNull();
  });

  test('a provider whose status probe throws is skipped as a default choice', async () => {
    const registry = new VoiceProviderRegistry();
    const broken = provider('broken', true);
    (broken as { status: () => VoiceProviderStatus }).status = () => {
      throw new Error('probe exploded');
    };
    registry.register(broken);
    registry.register(provider('local', true));
    expect((await registry.resolveProvider('stt'))?.id).toBe('local');
  });

  test('capability filtering still applies to the configured pool', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(provider('tts-only', true, ['tts']));
    registry.register(provider('openai', false));
    expect((await registry.resolveProvider('stt'))?.id).toBe('openai');
  });
});
