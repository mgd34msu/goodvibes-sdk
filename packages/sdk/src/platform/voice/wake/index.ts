/**
 * voice/wake — wake-word detection, SDK-owned and isomorphic.
 *
 * The engine runs unchanged in a daemon child process and in a browser tab: it
 * never imports an inference runtime, taking a session loader from the host
 * instead, and its front end is computed in code rather than downloaded.
 *
 * What lives here is behaviour every surface must share — the front end, the
 * buffering the published classifier was trained against, the patience and
 * cooldown rules, the restart policy, and the checksum-pinned provisioning with
 * its recovery housekeeping, plus the settings resolution and the listener that
 * drive them. Opening a device does NOT live here — that is per-surface, and
 * arrives as an opener from ../capture, which the listener consumes.
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
} from './engine.js';

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

export {
  WakeSupervisor,
  WAKE_SUPERVISOR_DEFAULTS,
  type WakeSupervisorPolicy,
  type WakeSupervisorState,
  type WakeRestartDecision,
} from './supervisor.js';

export {
  provisionWakeWordModels,
  resolveWakeModelFiles,
  wakeProvisionStatus,
  wakeArtifactStatus,
  resolveManagedWakePaths,
  describeWakeModel,
  type ManagedWakePaths,
  type WakeProvisionStatus,
  type WakeProvisionResult,
  type WakeProvisionOptions,
  type WakeProvisionProgress,
  type WakeProvisionComponent,
  type WakeComponentOutcome,
  type ResolvedWakeModelFile,
} from './provisioning.js';

export {
  provisionWakeWordModelsAtInstall,
  startWakeBootProvisioning,
  WAKE_INSTALL_SKIP_ENV,
  WAKE_INSTALL_DEFAULT_RECOVERY_HINT,
  WAKE_INSTALL_TIMEOUT_MS,
  WAKE_BOOT_PROVISION_DELAY_MS,
  type WakeInstallProvisionState,
  type WakeInstallProvisionOutcome,
  type WakeInstallProvisionOptions,
  type WakeBootProvisioning,
  type WakeBootProvisioningOptions,
} from './install-provision.js';

export {
  retainedClipFileName,
  sweepWakeStorage,
  startWakeRecoverySweeper,
  WAKE_REAP_RECEIPT_FILE,
  WAKE_RETAINED_MAX_FILES,
  WAKE_RETAINED_MAX_AGE_HOURS,
  WAKE_PARTIAL_MAX_AGE_HOURS,
  WAKE_SWEEP_INTERVAL_MS,
  type WakeReapSummary,
  type WakeReapedEntry,
  type WakeReapReason,
  type WakeRecoveryOptions,
  type WakeRecoverySweeper,
} from './recovery.js';

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
