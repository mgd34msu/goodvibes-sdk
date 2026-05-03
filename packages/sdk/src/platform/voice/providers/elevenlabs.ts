import type {
  VoiceAudioChunk,
  VoiceDescriptor,
  VoiceProvider,
  VoiceSynthesisRequest,
  VoiceSynthesisStreamResult,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
} from '../types.js';
import {
  asRecord,
  buildStatus,
  estimateConfidenceFromAvgLogprob,
  inferFilename,
  normalizeBaseUrl,
  readFirstEnv,
  resolveAudioInput,
  trimToUndefined,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2';
const DEFAULT_ELEVENLABS_REALTIME_MODEL = 'scribe_v2_realtime';
const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2';
const DEFAULT_ELEVENLABS_VOICE = 'pMsXgVXv3BLzUgSXRplE';
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
const ELEVENLABS_SINGLE_USE_TOKEN_TTL_MS = 15 * 60 * 1000;

type ElevenLabsWord = {
  readonly text?: string;
  readonly start?: number;
  readonly end?: number;
  readonly type?: string;
  readonly speaker_id?: string;
  readonly logprob?: number;
};

type ElevenLabsTranscriptionResponse = {
  readonly language_code?: string;
  readonly language_probability?: number;
  readonly text?: string;
  readonly words?: readonly ElevenLabsWord[];
  readonly transcription_id?: string;
};

type ElevenLabsSingleUseTokenResponse = {
  readonly token?: string;
};

function normalizeBooleanString(value: unknown): string | undefined {
  return typeof value === 'boolean' ? String(value) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return values.length > 0 ? values : undefined;
}

function resolveElevenLabsOutputFormat(format: string | undefined): string {
  const normalized = format?.trim().toLowerCase();
  if (!normalized) return DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
  if (normalized.includes('_')) return normalized;
  switch (normalized) {
    case 'mp3':
      return DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
    case 'pcm':
    case 'pcm16':
      return 'pcm_16000';
    case 'ulaw':
    case 'mulaw':
      return 'ulaw_8000';
    case 'opus':
    case 'ogg':
    case 'webm':
      return 'opus_48000_32';
    default:
      return DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
  }
}

function mimeTypeForElevenLabsOutputFormat(outputFormat: string): string {
  if (outputFormat.startsWith('pcm_')) return 'audio/pcm';
  if (outputFormat.startsWith('ulaw_')) return 'audio/basic';
  if (outputFormat.startsWith('opus_')) return 'audio/ogg';
  return 'audio/mpeg';
}

function artifactFormatForElevenLabsOutputFormat(outputFormat: string): string {
  if (outputFormat.startsWith('pcm_')) return 'pcm16';
  if (outputFormat.startsWith('ulaw_')) return 'ulaw';
  if (outputFormat.startsWith('opus_')) return 'ogg';
  return 'mp3';
}

function readVoiceSetting(metadata: Record<string, unknown> | undefined, camelKey: string, snakeKey: string, fallback: number): number {
  const value = metadata?.[camelKey] ?? metadata?.[snakeKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readSpeakerBoost(metadata: Record<string, unknown> | undefined): boolean {
  const value = metadata?.['useSpeakerBoost'] ?? metadata?.['use_speaker_boost'];
  return typeof value === 'boolean' ? value : true;
}

async function* streamResponseAudioChunks(
  response: Response,
  input: {
    readonly mimeType: string;
    readonly format: string;
    readonly metadata: Record<string, unknown>;
  },
): AsyncIterable<VoiceAudioChunk> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ElevenLabs streaming synthesis returned no response body');
  let sequence = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      sequence += 1;
      yield {
        data: value,
        sequence,
        mimeType: input.mimeType,
        format: input.format,
        metadata: input.metadata,
      };
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel('ElevenLabs stream was not fully consumed');
      } catch (error) {
        logger.warn('ElevenLabs stream reader cancel failed', { error: summarizeError(error) });
      }
    }
    reader.releaseLock();
  }
}

function parseElevenLabsTranscript(payload: ElevenLabsTranscriptionResponse): {
  text: string;
  language?: string;
  segments: Array<{ text: string; startMs?: number; endMs?: number; confidence?: number }>;
} {
  const text = trimToUndefined(payload.text);
  if (!text) throw new Error('ElevenLabs transcription response missing transcript');
  const segments = (payload.words ?? [])
    .filter((word) => (word.type?.trim() || 'word') === 'word')
    .map((word) => ({
      text: word.text?.trim() ?? '',
      startMs: typeof word.start === 'number' ? Math.round(word.start * 1000) : undefined,
      endMs: typeof word.end === 'number' ? Math.round(word.end * 1000) : undefined,
      confidence: estimateConfidenceFromAvgLogprob(word.logprob),
    }))
    .filter((segment) => segment.text.length > 0);
  return {
    text,
    language: trimToUndefined(payload.language_code),
    segments,
  };
}

function buildElevenLabsRealtimeMetadata(params: {
  baseUrl: string;
  websocketUrl: string;
  token?: string;
  expiresAt?: number;
  request: VoiceRealtimeSessionRequest;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    authMode: params.token ? 'single-use-token' : 'api-key',
    ...(params.token ? { token: params.token } : {}),
    expiresAt: params.expiresAt,
    connect: {
      websocket: {
        url: params.websocketUrl,
        ...(params.token ? {} : { headers: { 'xi-api-key': '<server-managed>' } }),
      },
    },
    request: {
      modelId: params.request.modelId,
      voiceId: params.request.voiceId,
      inputFormat: params.request.inputFormat,
      outputFormat: params.request.outputFormat,
      instructions: params.request.instructions,
      metadata: params.metadata ?? {},
    },
  };
}

export function createElevenLabsProvider(): VoiceProvider {
  const envVars = ['ELEVENLABS_API_KEY', 'XI_API_KEY'] as const;
  const baseUrlEnvVars = ['ELEVENLABS_BASE_URL', 'XI_API_BASE'] as const;
  return {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    capabilities: ['tts', 'tts-stream', 'stt', 'realtime', 'voice-list'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'elevenlabs',
        'ElevenLabs',
        ['tts', 'tts-stream', 'stt', 'realtime', 'voice-list'],
        configured,
        configured
          ? 'ElevenLabs speech, transcription, and realtime APIs are available.'
          : 'Set ELEVENLABS_API_KEY or XI_API_KEY to enable ElevenLabs speech and transcription.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io'),
          defaultTtsModel: DEFAULT_ELEVENLABS_TTS_MODEL,
          defaultSttModel: DEFAULT_ELEVENLABS_STT_MODEL,
          defaultRealtimeModel: DEFAULT_ELEVENLABS_REALTIME_MODEL,
          defaultOutputFormat: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
        },
      );
    },
    async listVoices(): Promise<readonly VoiceDescriptor[]> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) return [];
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const response = await instrumentedFetch(`${baseUrl}/v1/voices`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!response.ok) throw new Error(`ElevenLabs voices failed: HTTP ${response.status}`);
      const payload = await response.json() as {
        voices?: Array<{ voice_id?: string; name?: string; category?: string; description?: string }>;
      };
      return (payload.voices ?? [])
        .map((voice) => ({
          id: voice.voice_id?.trim() ?? '',
          label: voice.name?.trim() || voice.voice_id?.trim() || 'Voice',
          metadata: {
            category: voice.category?.trim(),
            description: voice.description?.trim(),
          },
        }))
        .filter((voice) => voice.id.length > 0);
    },
    async synthesize(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const voiceId = request.voiceId?.trim() || DEFAULT_ELEVENLABS_VOICE;
      const response = await instrumentedFetch(`${baseUrl}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: request.text,
          model_id: request.modelId?.trim() || DEFAULT_ELEVENLABS_TTS_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: true,
            speed: request.speed ?? 1,
          },
        }),
      });
      if (!response.ok) throw new Error(`ElevenLabs synthesis failed: HTTP ${response.status}`);
      const mimeType = response.headers.get('content-type')?.trim() || 'audio/mpeg';
      const dataBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
      return {
        providerId: 'elevenlabs',
        audio: {
          mimeType,
          format: mimeType.includes('wav') ? 'wav' : 'mp3',
          dataBase64,
          metadata: { voiceId, baseUrl },
        },
        metadata: { voiceId, baseUrl },
      };
    },
    async synthesizeStream(request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const metadata = asRecord(request.metadata);
      const voiceId = request.voiceId?.trim() || DEFAULT_ELEVENLABS_VOICE;
      const modelId = request.modelId?.trim() || DEFAULT_ELEVENLABS_TTS_MODEL;
      const outputFormat = resolveElevenLabsOutputFormat(request.format);
      const mimeType = mimeTypeForElevenLabsOutputFormat(outputFormat);
      const format = artifactFormatForElevenLabsOutputFormat(outputFormat);
      const url = new URL(`${baseUrl}/v1/text-to-speech/${voiceId}/stream`);
      url.searchParams.set('output_format', outputFormat);
      if (metadata?.['enableLogging'] === false) {
        url.searchParams.set('enable_logging', 'false');
      }
      const languageCode = trimToUndefined(metadata?.['languageCode']);
      const body: Record<string, unknown> = {
        text: request.text,
        model_id: modelId,
        voice_settings: {
          stability: readVoiceSetting(metadata, 'stability', 'stability', 0.5),
          similarity_boost: readVoiceSetting(metadata, 'similarityBoost', 'similarity_boost', 0.75),
          style: readVoiceSetting(metadata, 'style', 'style', 0),
          use_speaker_boost: readSpeakerBoost(metadata),
          speed: request.speed ?? readVoiceSetting(metadata, 'speed', 'speed', 1),
        },
        ...(languageCode ? { language_code: languageCode } : {}),
      };
      const response = await instrumentedFetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: mimeType,
        },
        signal: request.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`ElevenLabs streaming synthesis failed: HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
      }
      const resultMetadata = {
        baseUrl,
        voiceId,
        modelId,
        outputFormat,
      };
      return {
        providerId: 'elevenlabs',
        mimeType,
        format,
        chunks: streamResponseAudioChunks(response, {
          mimeType,
          format,
          metadata: resultMetadata,
        }),
        metadata: resultMetadata,
      };
    },
    async transcribe(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const metadata = asRecord(request.metadata);
      const url = new URL(`${baseUrl}/v1/speech-to-text`);
      if (metadata?.['enableLogging'] === false) {
        url.searchParams.set('enable_logging', 'false');
      }
      const form = new FormData();
      form.append('model_id', request.modelId?.trim() || DEFAULT_ELEVENLABS_STT_MODEL);
      if (request.language?.trim()) form.append('language_code', request.language.trim());
      const uri = trimToUndefined(request.audio.uri);
      const canUseSourceUrl = !request.audio.dataBase64 && uri && /^https?:\/\//i.test(uri);
      if (canUseSourceUrl) {
        form.append('source_url', uri);
      } else {
        const { buffer, mimeType } = await resolveAudioInput(request.audio);
        form.append(
          'file',
          new Blob([Buffer.from(buffer)], { type: mimeType || 'application/octet-stream' }),
          inferFilename(request.audio, '.wav'),
        );
        form.append('file_format', request.audio.format === 'pcm16' ? 'pcm_s16le_16' : 'other');
      }
      if (metadata?.['tagAudioEvents'] !== undefined) {
        const value = normalizeBooleanString(metadata['tagAudioEvents']);
        if (value) form.append('tag_audio_events', value);
      }
      if (metadata?.['diarize'] !== undefined) {
        const value = normalizeBooleanString(metadata['diarize']);
        if (value) form.append('diarize', value);
      }
      if (
        typeof metadata?.['diarizationThreshold'] === 'number'
        && Number.isFinite(metadata['diarizationThreshold'])
      ) {
        form.append('diarization_threshold', String(metadata['diarizationThreshold']));
      }
      if (
        typeof metadata?.['numSpeakers'] === 'number'
        && Number.isFinite(metadata['numSpeakers'])
      ) {
        form.append('num_speakers', String(Math.round(metadata['numSpeakers'])));
      }
      if (
        typeof metadata?.['temperature'] === 'number'
        && Number.isFinite(metadata['temperature'])
      ) {
        form.append('temperature', String(metadata['temperature']));
      }
      if (typeof metadata?.['seed'] === 'number' && Number.isFinite(metadata['seed'])) {
        form.append('seed', String(Math.round(metadata['seed'])));
      }
      if (metadata?.['useMultiChannel'] !== undefined) {
        const value = normalizeBooleanString(metadata['useMultiChannel']);
        if (value) form.append('use_multi_channel', value);
      }
      if (metadata?.['noVerbatim'] !== undefined) {
        const value = normalizeBooleanString(metadata['noVerbatim']);
        if (value) form.append('no_verbatim', value);
      }
      const timestampsGranularity = trimToUndefined(metadata?.['timestampsGranularity']);
      if (timestampsGranularity && ['none', 'word', 'character'].includes(timestampsGranularity)) {
        form.append('timestamps_granularity', timestampsGranularity);
      }
      const keyterms = asStringArray(metadata?.['keyterms']);
      for (const keyterm of keyterms ?? []) form.append('keyterms', keyterm);
      const entityDetection = metadata?.['entityDetection'];
      if (typeof entityDetection === 'string' && entityDetection.trim()) {
        form.append('entity_detection', entityDetection.trim());
      } else {
        for (const entry of asStringArray(entityDetection) ?? []) {
          form.append('entity_detection', entry);
        }
      }
      const entityRedaction = metadata?.['entityRedaction'];
      if (typeof entityRedaction === 'string' && entityRedaction.trim()) {
        form.append('entity_redaction', entityRedaction.trim());
      } else {
        for (const entry of asStringArray(entityRedaction) ?? []) {
          form.append('entity_redaction', entry);
        }
      }
      const entityRedactionMode = trimToUndefined(metadata?.['entityRedactionMode']);
      if (entityRedactionMode) form.append('entity_redaction_mode', entityRedactionMode);
      if (metadata?.['webhookMetadata'] !== undefined) {
        form.append('webhook_metadata', JSON.stringify(metadata['webhookMetadata']));
      }
      const response = await instrumentedFetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
        body: form,
      });
      if (!response.ok) throw new Error(`ElevenLabs transcription failed: HTTP ${response.status}`);
      const payload = await response.json() as ElevenLabsTranscriptionResponse;
      const parsed = parseElevenLabsTranscript(payload);
      return {
        providerId: 'elevenlabs',
        text: parsed.text,
        language: parsed.language || request.language,
        segments: parsed.segments,
        metadata: {
          baseUrl,
          modelId: request.modelId?.trim() || DEFAULT_ELEVENLABS_STT_MODEL,
          transcriptionId: trimToUndefined(payload.transcription_id),
          sourceMode: canUseSourceUrl ? 'source_url' : 'file',
        },
      };
    },
    async openRealtimeSession(request): Promise<VoiceRealtimeSession> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const metadata = asRecord(request.metadata);
      const model = request.modelId?.trim() || DEFAULT_ELEVENLABS_REALTIME_MODEL;
      const websocketBase = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
      const websocketUrl = new URL(`${websocketBase}/v1/speech-to-text/realtime`);
      websocketUrl.searchParams.set('model_id', model);
      if (metadata?.['includeTimestamps'] !== undefined) {
        const value = normalizeBooleanString(metadata['includeTimestamps']);
        if (value) websocketUrl.searchParams.set('include_timestamps', value);
      }
      if (metadata?.['includeLanguageDetection'] !== undefined) {
        const value = normalizeBooleanString(metadata['includeLanguageDetection']);
        if (value) websocketUrl.searchParams.set('include_language_detection', value);
      }
      const audioFormat = trimToUndefined(metadata?.['audioFormat'])
        || (request.inputFormat === 'pcm16' ? 'pcm_16000' : undefined);
      if (audioFormat) websocketUrl.searchParams.set('audio_format', audioFormat);
      const languageCode = trimToUndefined(metadata?.['languageCode']);
      if (languageCode) websocketUrl.searchParams.set('language_code', languageCode);
      const commitStrategy = trimToUndefined(metadata?.['commitStrategy']);
      if (commitStrategy && ['manual', 'vad'].includes(commitStrategy)) {
        websocketUrl.searchParams.set('commit_strategy', commitStrategy);
      }
      if (
        typeof metadata?.['vadSilenceThresholdSecs'] === 'number'
        && Number.isFinite(metadata['vadSilenceThresholdSecs'])
      ) {
        websocketUrl.searchParams.set(
          'vad_silence_threshold_secs',
          String(metadata['vadSilenceThresholdSecs']),
        );
      }
      if (
        typeof metadata?.['vadThreshold'] === 'number'
        && Number.isFinite(metadata['vadThreshold'])
      ) {
        websocketUrl.searchParams.set('vad_threshold', String(metadata['vadThreshold']));
      }
      if (
        typeof metadata?.['minSpeechDurationMs'] === 'number'
        && Number.isFinite(metadata['minSpeechDurationMs'])
      ) {
        websocketUrl.searchParams.set(
          'min_speech_duration_ms',
          String(Math.round(metadata['minSpeechDurationMs'])),
        );
      }
      if (
        typeof metadata?.['minSilenceDurationMs'] === 'number'
        && Number.isFinite(metadata['minSilenceDurationMs'])
      ) {
        websocketUrl.searchParams.set(
          'min_silence_duration_ms',
          String(Math.round(metadata['minSilenceDurationMs'])),
        );
      }
      if (metadata?.['enableLogging'] !== undefined) {
        const value = normalizeBooleanString(metadata['enableLogging']);
        if (value) websocketUrl.searchParams.set('enable_logging', value);
      }
      const tokenResponse = await instrumentedFetch(`${baseUrl}/v1/single-use-token/realtime_scribe`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
      });
      if (!tokenResponse.ok) {
        throw new Error(`ElevenLabs realtime token failed: HTTP ${tokenResponse.status}`);
      }
      const tokenPayload = await tokenResponse.json() as ElevenLabsSingleUseTokenResponse;
      const token = trimToUndefined(tokenPayload.token);
      if (!token) throw new Error('ElevenLabs realtime token response missing token');
      websocketUrl.searchParams.set('token', token);
      const expiresAt = Date.now() + ELEVENLABS_SINGLE_USE_TOKEN_TTL_MS;
      return {
        providerId: 'elevenlabs',
        sessionId: `elevenlabs-realtime-${Date.now()}`,
        transport: 'websocket',
        url: websocketUrl.toString(),
        expiresAt,
        metadata: buildElevenLabsRealtimeMetadata({
          baseUrl,
          websocketUrl: websocketUrl.toString(),
          token,
          expiresAt,
          request,
          metadata,
        }),
      };
    },
  };
}
