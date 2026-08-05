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

// Where captured audio becomes words: the connected host first, this process's
// own provider as a stated fallback. See ./stt-routing.ts.
export { SttRoutesExhaustedError, describeRoute, transcribeThroughBestRoute } from './stt-routing.js';
export type { SttAudioInput, SttRouteCandidate, SttRoutingDeps, SttTranscription } from './stt-routing.js';

// What a setup request actually commits the platform to: do the ask, propose
// the inferred extensions, ask only at genuine forks. See ./setup-chain.ts.
export {
  planVoiceSetupChain,
  renderVoiceSetupChain,
  voiceSetupChainStrings,
  voiceSetupStepMentionsUserCommand,
  voiceSetupStepsOfKind,
} from './setup-chain.js';
export type {
  VoiceSetupChain,
  VoiceSetupContext,
  VoiceSetupIntent,
  VoiceSetupOption,
  VoiceSetupStep,
} from './setup-chain.js';

// Voice failures leave evidence on disk rather than only in a banner.
export {
  VOICE_DIAGNOSTICS_FILE,
  VOICE_DIAGNOSTICS_MAX_AGE_MS,
  VOICE_DIAGNOSTICS_MAX_ENTRIES,
  describeVoiceDiagnostic,
  readVoiceDiagnostics,
  recordVoiceDiagnostic,
  voiceDiagnosticsPath,
} from './diagnostics.js';
export type { VoiceDiagnosticEntry, VoiceDiagnosticRoute, VoiceDiagnosticsWriteOptions } from './diagnostics.js';
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

// Audio capture — one microphone path, two consumers (push-to-talk voice input
// and wake-word detection). Runtime-neutral: the host supplies what opens a
// device. See ./capture.
export * from './capture/index.js';

// Wake-word detection — SDK-owned and isomorphic: the engine takes an inference
// session from the host rather than importing a runtime, and its front end is
// computed in code, so the same detector runs in a daemon child process and in
// a browser tab. See ./wake.
export * from './wake/index.js';
