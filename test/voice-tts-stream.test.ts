import { describe, expect, test } from 'bun:test';
import { createDaemonMediaRouteHandlers } from '../packages/daemon-sdk/src/media-routes.js';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.js';
import { VoiceProviderRegistry } from '../packages/sdk/src/platform/voice/provider-registry.js';
import { VoiceService } from '../packages/sdk/src/platform/voice/service.js';
import { createElevenLabsProvider } from '../packages/sdk/src/platform/voice/providers/elevenlabs.js';
import type { VoiceAudioChunk, VoiceSynthesisStreamResult } from '../packages/sdk/src/platform/voice/types.js';

async function collectBytes(chunks: AsyncIterable<{ readonly data: Uint8Array }>): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of chunks) bytes.push(...chunk.data);
  return bytes;
}

async function* byteChunks(chunks: readonly Uint8Array[]): AsyncIterable<VoiceAudioChunk> {
  let sequence = 0;
  for (const data of chunks) {
    sequence += 1;
    yield { data, sequence };
  }
}

describe('streaming TTS configuration', () => {
  test('defaults to ElevenLabs while allowing clients to override provider and voice', () => {
    expect(DEFAULT_CONFIG.tts.provider).toBe('elevenlabs');
    expect(DEFAULT_CONFIG.tts.voice).toBe('');
    expect(DEFAULT_CONFIG.tts.llmProvider).toBe('');
    expect(DEFAULT_CONFIG.tts.llmModel).toBe('');

    const keys = new Set(CONFIG_SCHEMA.map((setting) => setting.key));
    expect(keys.has('tts.provider')).toBe(true);
    expect(keys.has('tts.voice')).toBe(true);
    expect(keys.has('tts.llmProvider')).toBe(true);
    expect(keys.has('tts.llmModel')).toBe(true);
  });
});

describe('VoiceService.synthesizeStream', () => {
  test('routes to providers with the tts-stream capability', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register({
      id: 'streamer',
      label: 'Streamer',
      capabilities: ['tts-stream'],
      async synthesizeStream(request): Promise<VoiceSynthesisStreamResult> {
        return {
          providerId: 'streamer',
          mimeType: 'audio/mpeg',
          format: 'mp3',
          chunks: byteChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
          metadata: { text: request.text },
        };
      },
    });

    const service = new VoiceService(registry);
    const result = await service.synthesizeStream(undefined, { text: 'speak this' });

    expect(result.providerId).toBe('streamer');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(await collectBytes(result.chunks)).toEqual([1, 2, 3]);
  });
});

describe('ElevenLabs streaming TTS provider', () => {
  test('calls the ElevenLabs streaming endpoint and yields audio chunks', async () => {
    const originalFetch = globalThis.fetch;
    const originalElevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const originalXiKey = process.env.XI_API_KEY;
    let captured: { input: RequestInfo | URL; init?: RequestInit } | null = null;

    process.env.ELEVENLABS_API_KEY = 'test-key';
    delete process.env.XI_API_KEY;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured = { input, init };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([10, 11]));
          controller.enqueue(new Uint8Array([12]));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof globalThis.fetch;

    try {
      const provider = createElevenLabsProvider();
      const result = await provider.synthesizeStream?.({
        text: 'Hello there',
        voiceId: 'voice-1',
        modelId: 'eleven_flash_v2_5',
        format: 'mp3',
        speed: 1.1,
        metadata: {
          stability: 0.2,
          similarityBoost: 0.8,
          style: 0.1,
          useSpeakerBoost: false,
          languageCode: 'en',
          enableLogging: false,
        },
      });

      expect(result).toBeDefined();
      expect(await collectBytes(result!.chunks)).toEqual([10, 11, 12]);
      expect(result!.providerId).toBe('elevenlabs');
      expect(result!.mimeType).toBe('audio/mpeg');
      expect(result!.format).toBe('mp3');

      expect(captured).not.toBeNull();
      const url = new URL(String(captured!.input));
      expect(url.pathname).toBe('/v1/text-to-speech/voice-1/stream');
      expect(url.searchParams.get('output_format')).toBe('mp3_44100_128');
      expect(url.searchParams.get('enable_logging')).toBe('false');

      const headers = new Headers(captured!.init?.headers);
      expect(headers.get('xi-api-key')).toBe('test-key');
      expect(headers.get('accept')).toBe('audio/mpeg');

      const requestBody = JSON.parse(String(captured!.init?.body)) as Record<string, unknown>;
      expect(requestBody.text).toBe('Hello there');
      expect(requestBody.model_id).toBe('eleven_flash_v2_5');
      expect(requestBody.language_code).toBe('en');
      expect(requestBody.voice_settings).toMatchObject({
        stability: 0.2,
        similarity_boost: 0.8,
        style: 0.1,
        use_speaker_boost: false,
        speed: 1.1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalElevenLabsKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = originalElevenLabsKey;
      if (originalXiKey === undefined) delete process.env.XI_API_KEY;
      else process.env.XI_API_KEY = originalXiKey;
    }
  });
});

describe('daemon streaming TTS route', () => {
  test('uses configured TTS provider and voice when a request omits them', async () => {
    let capturedProviderId: string | undefined;
    let capturedInput: Record<string, unknown> | undefined;
    const handlers = createDaemonMediaRouteHandlers({
      artifactStore: {
        list: () => [],
        create: async () => ({}),
        get: () => null,
        readContent: async () => ({
          record: { mimeType: 'text/plain' },
          buffer: new Uint8Array(),
        }),
      },
      configManager: {
        get: (key: string) => {
          if (key === 'tts.provider') return 'elevenlabs';
          if (key === 'tts.voice') return 'configured-voice';
          return false;
        },
      },
      mediaProviders: {
        status: async () => [],
        findProvider: () => null,
      },
      multimodalService: {
        getStatus: async () => ({}),
        listProviders: async () => [],
        analyze: async () => ({}),
        buildPacket: () => ({}),
        writeBackAnalysis: async () => ({}),
      },
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      requireAdmin: () => null,
      voiceService: {
        getStatus: async () => ({ providers: [] }),
        listVoices: async () => [],
        synthesize: async () => ({}),
        synthesizeStream: async (providerId, input) => {
          capturedProviderId = providerId;
          capturedInput = input;
          return {
            providerId: providerId ?? 'fallback',
            mimeType: 'audio/mpeg',
            format: 'mp3',
            chunks: byteChunks([new Uint8Array([5]), new Uint8Array([6, 7])]),
            metadata: {},
          };
        },
        transcribe: async () => ({}),
        openRealtimeSession: async () => ({}),
      },
      webSearchService: {
        getStatus: async () => ({ providers: [] }),
        search: async () => ({}),
      },
    });

    const response = await handlers.postVoiceTtsStream(new Request('http://127.0.0.1/api/voice/tts/stream', {
      method: 'POST',
      body: JSON.stringify({ text: 'Read this aloud' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('x-goodvibes-voice-provider')).toBe('elevenlabs');
    expect(response.headers.get('x-goodvibes-audio-format')).toBe('mp3');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([5, 6, 7]);
    expect(capturedProviderId).toBe('elevenlabs');
    expect(capturedInput).toMatchObject({
      text: 'Read this aloud',
      voiceId: 'configured-voice',
      metadata: {},
    });
    expect(capturedInput?.signal).toBeInstanceOf(AbortSignal);
  });
});
