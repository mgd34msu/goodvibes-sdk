export type {
  VoiceAudioArtifact,
  VoiceAudioChunk,
  VoiceAudioFormat,
  VoiceDescriptor,
  VoiceProvider,
  VoiceProviderCapability,
  VoiceProviderState,
  VoiceProviderStatus,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceSynthesisStreamResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from './types.js';
export { VoiceProviderRegistry } from './provider-registry.js';
export type { VoiceProviderDescriptor } from './provider-registry.js';
export { VoiceService } from './service.js';
export type { VoiceServiceStatus } from './service.js';
export { ensureBuiltinVoiceProviders } from './builtin-providers.js';
export type { BuiltinVoiceProviderOptions } from './builtin-providers.js';
export { createLocalVoiceProvider } from './providers/local.js';
export type { LocalVoiceProviderOptions, LocalEngineRunner, LocalVoiceConfigReader, ManagedEngineResolver } from './providers/local.js';
export { downloadVoiceModel } from './model-download.js';
export type { VoiceModelDownloadOptions, VoiceModelDownloadResult } from './model-download.js';
export * from './provisioning/index.js';
export type { VoiceBillableUsage } from './service.js';

// Spoken-turn (live TTS) policy engine — shared behavioral contract; consumers
// inject an AudioSink for I/O. See ./spoken-turn.
export { SpokenTurnController, TtsTextChunker, normalizeSpeechText } from './spoken-turn/index.js';
export type {
  SpokenTurnControllerOptions,
  TtsTextChunkerOptions,
  AudioSink,
  AudioSinkPlaybackOptions,
} from './spoken-turn/index.js';
