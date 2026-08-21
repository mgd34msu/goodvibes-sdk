/**
 * runtime.ts, the wake-word detector, minus everything that needs a filesystem.
 *
 * `./index.ts` is the full module and includes provisioning and the recovery
 * sweeper, both of which read and write files and therefore import `node:fs`.
 * That is correct for a host, and fatal for a browser tab: one `node:` import
 * anywhere in the graph is enough to break a web bundle, so a tab that wants the
 * detector cannot import the barrel that also downloads it.
 *
 * So this is the runtime-neutral half, the front end, the engine, the detection
 * rules, the restart policy, the settings resolution and the listener, exported
 * as `@pellux/goodvibes-sdk/platform/voice/wake/runtime`. A browser host provides
 * the model bytes and the inference session; a terminal or daemon host can import
 * either this or the full barrel.
 *
 * Keep this list `node:`-free. Anything that touches a path belongs in
 * ./provisioning.ts or ./recovery.ts, which this deliberately does not re-export.
 */
export {
  melFrames,
  melFrameCount,
  melFilterbank,
  analysisWindow,
  applyEmbeddingScaling,
  createMelScratch,
  WAKE_SAMPLE_RATE,
  WAKE_MEL_N_FFT,
  WAKE_MEL_HOP,
  WAKE_MEL_WIN_LENGTH,
  WAKE_MEL_BINS,
  WAKE_MEL_FMIN,
  WAKE_MEL_FMAX,
  WAKE_MEL_AMIN,
  WAKE_MEL_TOP_DB,
  WAKE_MEL_FFT_BINS,
  WAKE_MEL_MIN_SAMPLES,
  type MelScratch,
} from './melspectrogram.js';

export {
  WakeFeaturePipeline,
  WAKE_CHUNK_SAMPLES,
  WAKE_CHUNK_MS,
  WAKE_EMBED_WINDOW_FRAMES,
  WAKE_EMBED_DIM,
  WAKE_CLASSIFIER_FRAMES,
  WAKE_MEL_CONTEXT_SAMPLES,
  WAKE_RAW_TAIL_SECONDS,
  type FeaturePipelineOptions,
} from './feature-pipeline.js';

export {
  WakeDetector,
  WAKE_DETECTOR_DEFAULTS,
  type WakeFrameOutcome,
} from './detector.js';

export {
  WakeWordEngine,
  type WakeEngineOptions,
  type WakeFrameResult,
  type WakeVadGate,
  type WakeVadOutcome,
} from './engine.js';

export {
  WakeSupervisor,
  WAKE_SUPERVISOR_DEFAULTS,
  type WakeSupervisorPolicy,
  type WakeSupervisorState,
  type WakeRestartDecision,
} from './supervisor.js';

export {
  WAKE_SETTING_KEYS,
  resolveWakeRuntimeSettings,
  wakeSurfaceKey,
  type WakeSurface,
  type WakeSurfaceCapabilities,
  type WakeSettingBlocker,
  type WakeSettingLimitation,
  type WakeActivationSound,
  type WakeCaptureSettings,
  type WakeRuntimeSettings,
  type WakeSettingReader,
} from './settings.js';

export {
  WakeListener,
  type WakeListenerPhase,
  type WakeListenerState,
  type WakeListenerHandlers,
  type WakeListenerOptions,
  type WakeStartOutcome,
  type WakeStartRefusal,
  type WakeTriggered,
} from './listener.js';

export type {
  WakeTensor,
  WakeInferenceSession,
  WakeSessionLoader,
  WakeDetectorTuning,
  WakeDetection,
  WakeFrameScores,
  WakeModelHandle,
  WakeUnavailableReason,
  WakeArtifactStatus,
} from './types.js';
