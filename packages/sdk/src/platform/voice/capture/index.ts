/**
 * voice/capture — microphone capture as a platform capability.
 *
 * Two consumers share one device path: push-to-talk voice input, and wake-word
 * detection (which, on a confirmed wake, hands the utterance that follows to the
 * same speech-to-text call). See ./types.ts for why they cannot be separate
 * stacks.
 *
 * Everything here is runtime-neutral: the host supplies the thing that opens a
 * device, so this module imports no `node:` builtin and a browser bundle can
 * carry all of it. `createRecorderCaptureOpener` is the host-shaped opener — it
 * takes `spawn` as an argument rather than importing it, for the same reason.
 *
 * `voice.wake.noiseSuppression` is applied here too, by
 * `createNoiseSuppressingOpener` wrapping whatever the host opens: the filter is
 * a WebAssembly module carried in the package, so it runs in a daemon child
 * process and in a browser tab identically, and every consumer downstream of the
 * device sees the same filtered frames. See ./noise-suppression.ts.
 */
export {
  CAPTURE_SAMPLE_RATE,
  CAPTURE_CHANNELS,
  AudioCaptureError,
  type AudioCaptureBackend,
  type AudioCaptureNoiseSuppression,
  type AudioCaptureRequest,
  type AudioCaptureFailureReason,
  type AudioCaptureStopReason,
  type AudioCaptureHandlers,
  type AudioCaptureStream,
  type AudioCaptureOpener,
  type AudioCaptureWarn,
} from './types.js';

export {
  PCM16_BYTES_PER_SAMPLE,
  PCM16_FULL_SCALE,
  pcm16ToFloatSamples,
  floatSamplesToPcm16,
  frameRms,
  AudioFrameSlicer,
  concatSamples,
  encodeWavPcm16,
  bytesToBase64,
  base64ToBytes,
} from './frames.js';

export {
  SPEEXDSP_PREPROCESS,
  SPEEX_BLOCK_SAMPLES,
  noiseSuppressionSupport,
  createSpeexNoiseSuppression,
  createNoiseSuppressingOpener,
  type NoiseSuppressionStage,
  type NoiseSuppressionFactory,
  type NoiseSuppressionSupport,
  type NoiseSuppressingOpenerOptions,
} from './noise-suppression.js';

export {
  RECORDER_PROBE_ORDER,
  buildRecorderCommand,
  resolveRecorderCommand,
  type RecorderBackend,
  type ResolvedRecorderCommand,
  type RecorderCommandOptions,
  type RecorderResolutionOptions,
} from './recorder-command.js';

export {
  createRecorderCaptureOpener,
  type CaptureChildProcess,
  type CaptureSpawn,
  type RecorderCaptureOptions,
} from './recorder-source.js';

export {
  VOICE_INPUT_SILENCE_RMS,
  VOICE_INPUT_ADAPTIVE_FLOOR_MAX,
  VOICE_INPUT_ADAPTIVE_MARGIN,
  VOICE_INPUT_AMBIENT_FRAME_MS,
  VOICE_INPUT_AMBIENT_MIN_FRAMES,
  VOICE_INPUT_AMBIENT_PERCENTILE,
  VOICE_INPUT_ROLLING_WINDOW_MS,
  VOICE_INPUT_ROLLING_FLOOR_MAX,
  VOICE_INPUT_SPEECH_FLOOR_RATIO,
  VOICE_INPUT_SPEECH_LEVEL_HALF_LIFE_MS,
  VOICE_INPUT_SPEECH_RETRIGGER_MS,
  VoiceInputRecorder,
  estimateAmbientRms,
  isSilenceFloorPinned,
  resolveSilenceFloorRms,
  utteranceToAudioArtifact,
  type VoiceInputEndpointing,
  type VoiceInputStopReason,
  type VoiceInputPolicy,
  type CapturedUtterance,
  type UtteranceAudioArtifact,
} from './voice-input.js';

export {
  PushToTalkSession,
  type PushToTalkPhase,
  type PushToTalkOptions,
} from './push-to-talk.js';

// A configured input device is a HINT, validated rather than believed: an
// absent pin falls back to the OS default and says so, and a host whose only
// sources are output monitors is reported as having no microphone.
export {
  parseArecordCaptureDevices,
  parsePactlSources,
  resolveAudioInputBinding,
} from './device-binding.js';
export type {
  AudioInputBinding,
  AudioInputBindingState,
  AudioInputDevice,
  AudioInputDeviceEnumerator,
} from './device-binding.js';
