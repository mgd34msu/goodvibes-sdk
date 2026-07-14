/**
 * voice-local-engines.test.ts — local STT/TTS engines behind the existing
 * voice seams, and voice cost honesty.
 *
 * - A machine without engines shows honest not-configured, never an error;
 *   nothing auto-downloads.
 * - With engines configured (scripted fixture binaries here; the live host
 *   engines when installed), a spoken conversation completes with NO cloud
 *   voice dependency — through the real VoiceService + SpokenTurnController +
 *   AudioSink seams the voice-* families mark.
 * - Metered (ElevenLabs-class) voice spend flows through cost attribution
 *   with real dollars + provenance once the one-key manual price is set;
 *   local emits NOTHING (honest no-billing-dimension, never a fake $0.00).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createLocalVoiceProvider } from '../packages/sdk/src/platform/voice/providers/local.ts';
import { VoiceProviderRegistry } from '../packages/sdk/src/platform/voice/provider-registry.ts';
import { VoiceService } from '../packages/sdk/src/platform/voice/service.ts';
import { SpokenTurnController } from '../packages/sdk/src/platform/voice/spoken-turn/controller.ts';
import type { AudioSink } from '../packages/sdk/src/platform/voice/spoken-turn/audio-sink.ts';
import { CostAttributionService } from '../packages/sdk/src/platform/runtime/cost/attribution.ts';
import type { VoiceProvider } from '../packages/sdk/src/platform/voice/types.ts';

function configReader(values: Record<string, string>) {
  return (key: string) => values[key] ?? '';
}

/** Real scripted engine binaries (shell scripts) honoring the documented CLI contracts. */
function makeFixtureEngines() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-voice-fixture-'));
  const tts = join(dir, 'fake-piper');
  // piper contract: --model <m> --output_file <wav>, text on stdin.
  writeFileSync(tts, '#!/bin/bash\nOUT=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output_file" ]; then OUT="$2"; shift; fi; shift; done\nTEXT=$(cat)\nprintf "RIFF-FIXTURE-WAV:%s" "$TEXT" > "$OUT"\n', { mode: 0o755 });
  chmodSync(tts, 0o755);
  const stt = join(dir, 'fake-whisper-cli');
  // whisper-cpp contract: -m <model> -f <wav> --no-timestamps --no-prints, text on stdout.
  writeFileSync(stt, '#!/bin/bash\nWAV=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then WAV="$2"; shift; fi; shift; done\nsed "s/^RIFF-FIXTURE-WAV://" "$WAV"\n', { mode: 0o755 });
  chmodSync(stt, 0o755);
  const model = join(dir, 'fixture-model.bin');
  writeFileSync(model, 'model-bytes');
  return { tts, stt, model };
}

describe('honest not-configured (nothing auto-downloads)', () => {
  test('a machine without engines reports unconfigured — never an error', async () => {
    const provider = createLocalVoiceProvider({ readConfig: configReader({}) });
    const status = await provider.status!();
    expect(status.state).toBe('unconfigured');
    expect(status.configured).toBe(false);
    expect(status.detail).toContain('nothing auto-downloads');
    expect(status.metadata.billing).toBe('none');
    // Using it unconfigured is a clear configuration message, not a crash.
    await expect(provider.transcribe!({ audio: { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AA==', metadata: {} }, metadata: {} }))
      .rejects.toThrow(/not configured.*nothing auto-downloads/s);
  });

  test('configured-but-missing binaries degrade honestly', async () => {
    const provider = createLocalVoiceProvider({
      readConfig: configReader({
        'voice.local.ttsEngine': 'piper',
        'voice.local.ttsBinary': '/nonexistent/piper',
        'voice.local.ttsModelPath': '/nonexistent/model.onnx',
      }),
    });
    const status = await provider.status!();
    expect(status.state).toBe('degraded');
    expect(status.detail).toContain('missing on disk');
  });
});

describe('a spoken conversation with no cloud voice dependency (scripted engines)', () => {
  test('STT -> (turn) -> TTS -> audio sink, all through the real seams', async () => {
    const { tts, stt, model } = makeFixtureEngines();
    const readConfig = configReader({
      'voice.local.sttEngine': 'whisper-cpp',
      'voice.local.sttBinary': stt,
      'voice.local.sttModelPath': model,
      'voice.local.ttsEngine': 'piper',
      'voice.local.ttsBinary': tts,
      'voice.local.ttsModelPath': model,
    });
    const registry = new VoiceProviderRegistry();
    registry.register(createLocalVoiceProvider({ readConfig }), { replace: true });
    const usages: unknown[] = [];
    const service = new VoiceService(registry, (usage) => usages.push(usage));

    // 1. The user speaks: local STT transcribes with no network at all.
    const spokenWav = Buffer.from('RIFF-FIXTURE-WAV:what is the plan for today').toString('base64');
    const heard = await service.transcribe('local', {
      audio: { mimeType: 'audio/wav', format: 'wav', dataBase64: spokenWav, metadata: {} },
      metadata: {},
    });
    expect(heard.text).toBe('what is the plan for today');
    expect(heard.metadata.billing).toBe('none');

    // 2. The assistant answers: the spoken-turn controller drives local TTS
    //    through the SAME policy engine + audio-sink contract as the cloud path.
    const played: string[] = [];
    const sink: AudioSink = {
      label: 'fixture-sink',
      available: true,
      async play(chunks) {
        for await (const chunk of chunks) played.push(new TextDecoder().decode(chunk.data));
      },
      stop() {},
      async waitForDrain() {},
    };
    const controller = new SpokenTurnController({
      voiceService: service,
      configManager: { get: (key: string) => (key === 'tts.provider' ? 'local' : key === 'tts.enabled' ? true : '') } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });
    expect(controller.submitNextTurn(heard.text)).toBe(true);
    controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'turn-1', prompt: heard.text } as never);
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 'turn-1', content: 'The plan is simple: ship the local voice engines. ', accumulated: '' } as never);
    controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 'turn-1', response: '', stopReason: 'completed' } as never);
    // Give the pipeline a few macrotasks to synthesize + play.
    for (let i = 0; i < 40 && played.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(played.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('RIFF-FIXTURE-WAV:');
    expect(played.join('')).toContain('local voice engines');

    // 3. Local is billing 'none': NOTHING was recorded — honest absence.
    expect(usages).toEqual([]);
  }, 15_000);
});

describe('live host engines (when installed)', () => {
  test('real whisper.cpp + piper round-trip through the provider', async () => {
    const home = homedir();
    const piperBin = join(home, '.local/opt/piper/piper');
    const piperModel = join(home, '.local/opt/piper-voices/en_US-lessac-low.onnx');
    const whisperBin = join(home, '.local/opt/whisper.cpp/build/bin/whisper-cli');
    const whisperModel = join(home, '.local/opt/whisper.cpp/ggml-tiny.en.bin');
    if (![piperBin, piperModel, whisperBin, whisperModel].every((path) => existsSync(path))) {
      // Honest skip: the blessed engines are not installed on this machine.
      console.warn('[voice test] live engines not installed at ~/.local/opt — live round-trip skipped honestly');
      return;
    }
    const provider = createLocalVoiceProvider({
      readConfig: configReader({
        'voice.local.sttEngine': 'whisper-cpp',
        'voice.local.sttBinary': whisperBin,
        'voice.local.sttModelPath': whisperModel,
        'voice.local.ttsEngine': 'piper',
        'voice.local.ttsBinary': piperBin,
        'voice.local.ttsModelPath': piperModel,
      }),
    });
    const started = Date.now();
    const synthesis = await provider.synthesize!({ text: 'The quick brown fox jumps over the lazy dog.', metadata: {} });
    const ttsMs = Date.now() - started;
    expect(synthesis.audio.dataBase64).toBeDefined();
    const sttStarted = Date.now();
    const transcript = await provider.transcribe!({ audio: synthesis.audio, metadata: {} });
    const sttMs = Date.now() - sttStarted;
    expect(transcript.text.toLowerCase()).toContain('quick brown fox');
    console.warn(`[voice test] LIVE local round-trip on this host: TTS ${ttsMs}ms, STT ${sttMs}ms`);
  }, 60_000);
});

describe('voice cost honesty — metered vs local', () => {
  function meteredProvider(id: string): VoiceProvider {
    return {
      id,
      label: id,
      capabilities: ['tts'],
      // billing undefined = metered (the safe cloud default).
      synthesize: async (request) => ({
        providerId: id,
        audio: { mimeType: 'audio/mpeg', format: 'mp3', dataBase64: 'AA==', metadata: {} },
        metadata: { characters: request.text.length },
      }),
    };
  }

  test('ElevenLabs-class spend lands in attribution and prices with provenance via the one-key manual fix', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(meteredProvider('elevenlabs'), { replace: true });
    const attribution = new CostAttributionService({
      resolvePricing: (model) =>
        model === 'elevenlabs:voice-tts:characters'
          // The owner's one-key manual price: USD per 1M characters.
          ? { input: 150, output: 0, source: 'user' as const, asOf: '2026-07-14' }
          : null,
    });
    const service = new VoiceService(registry, (usage) => {
      attribution.record({
        at: Date.now(),
        provider: usage.providerId,
        model: `${usage.providerId}:voice-${usage.kind}:${usage.unit}`,
        sessionId: 'sess-voice',
        inputTokens: usage.billableUnits,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    const text = 'x'.repeat(2_000);
    await service.synthesize('elevenlabs', { text, metadata: {} });

    const byProvider = attribution.attribution('24h', 'provider');
    // Real dollars: 2,000 chars at $150/1M chars = $0.30 — with provenance.
    expect(byProvider.totalCostUsd).toBeCloseTo(0.3, 6);
    expect(byProvider.costState).toBe('priced');
    expect(byProvider.pricedRecordCount).toBe(1);
    expect(JSON.stringify(byProvider.costSource)).toContain('user');
  });

  test('local records nothing at all — no billing dimension, never $0.00', async () => {
    const { tts, model } = makeFixtureEngines();
    const registry = new VoiceProviderRegistry();
    registry.register(createLocalVoiceProvider({
      readConfig: configReader({
        'voice.local.ttsEngine': 'piper',
        'voice.local.ttsBinary': tts,
        'voice.local.ttsModelPath': model,
      }),
    }), { replace: true });
    const attribution = new CostAttributionService({ resolvePricing: () => null });
    let sinkCalls = 0;
    const service = new VoiceService(registry, () => { sinkCalls += 1; });
    await service.synthesize('local', { text: 'free and offline', metadata: {} });
    expect(sinkCalls).toBe(0);
    const result = attribution.attribution('24h', 'provider');
    expect(result.pricedRecordCount).toBe(0);
    expect(result.unpricedRecordCount).toBe(0);
    expect(result.totalCostUsd).toBeNull();
  });
});
