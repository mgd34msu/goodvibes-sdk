/**
 * settings.ts — every `voice.wake.*` row, resolved into runtime behaviour once.
 *
 * ONE READER, SO A ROW CANNOT QUIETLY CONFIGURE NOTHING
 *
 * Twenty-five rows shipped before anything captured audio. The failure mode that
 * creates is not a crash, it is a settings surface where some rows work and
 * others are decoration, with no way to tell which from the outside. So every row
 * is read HERE, in one function, and the list of keys it reads is exported as
 * {@link WAKE_SETTING_KEYS} and asserted against the schema by test. A row added
 * to the schema and not read here fails that test; a row read here is by
 * construction reaching the runtime.
 *
 * BLOCKERS AND LIMITATIONS ARE DIFFERENT, AND BOTH ARE WRITTEN DOWN
 *
 * Some rows cannot be honoured on some surfaces, and the honest answers differ:
 *
 *  - A {@link WakeSettingBlocker} means the detector must NOT start. Asking for a
 *    voice-activity floor with no VAD model to run, or `speex` suppression on a
 *    runtime that cannot run the filter, would otherwise mean audio flowing
 *    unfiltered through a stage the user believes is screening it. `speex` itself
 *    is no longer such a case on either shipped surface — the filter is a
 *    WebAssembly module the platform carries, and both hosts run it — so the
 *    blocker is now reserved for a surface that genuinely cannot.
 *  - A {@link WakeSettingLimitation} means the detector runs, with one row not in
 *    force, and says which. Retaining audio needs a filesystem, so a browser tab
 *    keeps listening and reports that retention is not happening rather than
 *    pretending it is.
 *
 * Config is read through an injected getter, so this resolves the same whether
 * the caller holds a ConfigManager, a config tree fetched from the daemon by a
 * browser tab, or a fixture.
 */
import {
  parseWakeModelList,
  voiceWakeConfigDefaults,
} from '../../config/schema-domain-voice-wake.js';
import { noiseSuppressionSupport } from '../capture/noise-suppression.js';
import type { AudioCaptureBackend, AudioCaptureNoiseSuppression } from '../capture/types.js';
import { WAKE_CHUNK_SAMPLES } from './feature-pipeline.js';
import type { WakeSupervisorPolicy } from './supervisor.js';
import type { WakeDetectorTuning } from './types.js';

/** The surfaces `voice.wake.surfaces.*` enumerates. */
export type WakeSurface = 'tui' | 'agent' | 'webui';

/** What a surface can actually do, so a row is refused rather than faked. */
export interface WakeSurfaceCapabilities {
  /**
   * Whether speex suppression can be applied to captured audio on this surface.
   *
   * Left out, it is ANSWERED rather than assumed: the platform carries SpeexDSP's
   * preprocessor as a WebAssembly module, so the answer is whether this runtime
   * has WebAssembly — see `noiseSuppressionSupport()`. Both shipped surfaces do,
   * and both apply the stage, which is why `speex` runs rather than refusing.
   *
   * A surface that genuinely cannot — a JavaScript runtime with no WebAssembly —
   * passes `false` and gets a blocker with that reason, because the wrong reading
   * of this flag is the exact lie the row exists to prevent: audio captured
   * unfiltered while the setting claims a filter is running.
   */
  readonly speexAvailable?: boolean | undefined;
  /**
   * A voice-activity-detection model is loadable. False everywhere today: no VAD
   * model is pinned by the manifest, so `voice.wake.vadThreshold` above 0 is
   * refused rather than silently skipped.
   */
  readonly vadAvailable?: boolean | undefined;
  /** Audio can be written to disk, for `retainAudio: session-temp`. */
  readonly canRetainAudio?: boolean | undefined;
  /** A local audio file path can be played, for `activationSound: custom`. */
  readonly canPlayLocalFile?: boolean | undefined;
}

/** A row that prevents the detector from starting, with the reason to show. */
export interface WakeSettingBlocker {
  readonly key: string;
  readonly detail: string;
}

/** A row not in force on this surface, while the detector still runs. */
export interface WakeSettingLimitation {
  readonly key: string;
  readonly detail: string;
}

/** The activation sound to play the moment a wake confirms. */
export interface WakeActivationSound {
  readonly kind: 'none' | 'chime' | 'custom';
  /** Only meaningful when `kind` is `custom`. */
  readonly path: string;
}

/** Capture settings, shared by wake detection and push-to-talk voice input. */
export interface WakeCaptureSettings {
  readonly device: string;
  readonly backend: AudioCaptureBackend;
  readonly noiseSuppression: AudioCaptureNoiseSuppression;
  /** Samples per frame; fixed by what the classifier was trained at. */
  readonly frameSamples: number;
}

/** Every `voice.wake.*` row, resolved for one surface. */
export interface WakeRuntimeSettings {
  readonly surface: WakeSurface;
  /** `voice.wake.enabled`. */
  readonly enabled: boolean;
  /** `voice.wake.surfaces.<surface>`. */
  readonly surfaceEnabled: boolean;
  /**
   * True only when the feature is on, this surface is one of its delivery
   * surfaces, and no row blocks it. A surface must consult THIS and nothing
   * else before opening a device.
   */
  readonly active: boolean;
  readonly modelIds: readonly string[];
  readonly tuning: WakeDetectorTuning;
  readonly vadThreshold: number;
  readonly capture: WakeCaptureSettings;
  readonly activationSound: WakeActivationSound;
  readonly indicator: 'off' | 'statusline' | 'banner';
  readonly preRollMs: number;
  readonly captureMaxSeconds: number;
  readonly silenceStopMs: number;
  readonly autoSubmit: boolean;
  readonly retainAudio: 'none' | 'session-temp';
  readonly customModelDir: string;
  readonly supervisor: WakeSupervisorPolicy;
  readonly browserBackend: 'wasm' | 'webgpu';
  readonly blockers: readonly WakeSettingBlocker[];
  readonly limitations: readonly WakeSettingLimitation[];
}

/** Reads one config key. Returns undefined for a key the source does not hold. */
export type WakeSettingReader = (key: string) => unknown;

/**
 * Every key {@link resolveWakeRuntimeSettings} reads. Exported so a test can
 * assert it against the schema's `voice.wake.*` rows in both directions — a row
 * the resolver ignores is a row that configures nothing.
 */
export const WAKE_SETTING_KEYS: readonly string[] = [
  'voice.wake.enabled',
  'voice.wake.models',
  'voice.wake.threshold',
  'voice.wake.patienceFrames',
  'voice.wake.cooldownMs',
  'voice.wake.vadThreshold',
  'voice.wake.noiseSuppression',
  'voice.wake.inputDevice',
  'voice.wake.captureCommand',
  'voice.wake.surfaces.tui',
  'voice.wake.surfaces.agent',
  'voice.wake.surfaces.webui',
  'voice.wake.activationSound',
  'voice.wake.activationSoundPath',
  'voice.wake.indicator',
  'voice.wake.preRollMs',
  'voice.wake.captureMaxSeconds',
  'voice.wake.silenceStopMs',
  'voice.wake.autoSubmit',
  'voice.wake.retainAudio',
  'voice.wake.customModelDir',
  'voice.wake.maxRestarts',
  'voice.wake.restartBackoffMs',
  'voice.wake.crashWindowSeconds',
  'voice.wake.browserBackend',
];

const DEFAULTS = voiceWakeConfigDefaults.voice.wake;

function readBoolean(read: WakeSettingReader, key: string, fallback: boolean): boolean {
  const value = read(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(read: WakeSettingReader, key: string, fallback: number): number {
  const value = read(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(read: WakeSettingReader, key: string, fallback: string): string {
  const value = read(key);
  return typeof value === 'string' ? value : fallback;
}

function readEnum<T extends string>(
  read: WakeSettingReader,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = read(key);
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** The `voice.wake.surfaces.*` key for a surface. */
export function wakeSurfaceKey(surface: WakeSurface): string {
  return `voice.wake.surfaces.${surface}`;
}

/**
 * Resolve every `voice.wake.*` row for one surface.
 *
 * Reads defaults for anything the source does not hold, so a partial config tree
 * (a browser tab that fetched only part of it, a fixture) resolves to the shipped
 * behaviour rather than to zeroes.
 */
export function resolveWakeRuntimeSettings(
  read: WakeSettingReader,
  surface: WakeSurface,
  capabilities: WakeSurfaceCapabilities = {},
): WakeRuntimeSettings {
  const enabled = readBoolean(read, 'voice.wake.enabled', DEFAULTS.enabled);
  const surfaceEnabled = readBoolean(read, wakeSurfaceKey(surface), DEFAULTS.surfaces[surface]);
  const modelIds = parseWakeModelList(readString(read, 'voice.wake.models', DEFAULTS.models));
  const noiseSuppression = readEnum<AudioCaptureNoiseSuppression>(
    read, 'voice.wake.noiseSuppression', ['none', 'speex'], DEFAULTS.noiseSuppression,
  );
  const vadThreshold = readNumber(read, 'voice.wake.vadThreshold', DEFAULTS.vadThreshold);
  const retainAudio = readEnum(read, 'voice.wake.retainAudio', ['none', 'session-temp'] as const, DEFAULTS.retainAudio);
  const activationSoundKind = readEnum(
    read, 'voice.wake.activationSound', ['none', 'chime', 'custom'] as const, DEFAULTS.activationSound,
  );
  const activationSoundPath = readString(read, 'voice.wake.activationSoundPath', DEFAULTS.activationSoundPath);

  const blockers: WakeSettingBlocker[] = [];
  const limitations: WakeSettingLimitation[] = [];

  const speexSupport = noiseSuppressionSupport();
  const speexAvailable = capabilities.speexAvailable ?? speexSupport.supported;
  if (noiseSuppression === 'speex' && !speexAvailable) {
    // Two different noes, and they read differently: the runtime cannot run a
    // WebAssembly module at all, or the surface says it does not apply the stage.
    const reason = speexSupport.supported
      ? 'this surface reports that it does not apply the speexdsp stage to the audio it captures'
      : speexSupport.reason;
    blockers.push({
      key: 'voice.wake.noiseSuppression',
      detail:
        `set to "speex", which cannot run here: ${reason}. Rather than capture unfiltered audio through a filter `
        + 'you have configured, the detector does not start. "none" captures without one.',
    });
  }
  if (vadThreshold > 0 && capabilities.vadAvailable !== true) {
    blockers.push({
      key: 'voice.wake.vadThreshold',
      detail:
        `set to ${vadThreshold}, but no voice-activity-detection model is available: the platform pins a wake `
        + 'classifier and a speech-embedding front end, and no VAD model beside them. Frames would reach the '
        + 'classifier unfiltered while the row says they are being screened, so the detector does not start. '
        + 'Set the row back to 0 to run without the VAD stage.',
    });
  }
  if (modelIds.length === 0) {
    // Not a blocker: the row's own description says an empty list disables
    // detection WITHOUT stopping the service, so capture stays available for
    // push-to-talk voice input and the detector simply scores nothing.
    limitations.push({
      key: 'voice.wake.models',
      detail: 'empty, so no wake model is loaded and nothing is scored. Voice input is unaffected.',
    });
  }
  if (retainAudio === 'session-temp' && capabilities.canRetainAudio !== true) {
    limitations.push({
      key: 'voice.wake.retainAudio',
      detail:
        'set to "session-temp", which needs a filesystem this surface does not have. Nothing is being retained; '
        + 'the detector runs normally.',
    });
  }
  if (activationSoundKind === 'custom' && capabilities.canPlayLocalFile !== true) {
    limitations.push({
      key: 'voice.wake.activationSoundPath',
      detail:
        'names a local file, which this surface cannot read. The built-in chime is played instead so a confirmed '
        + 'wake is still audible.',
    });
  }

  return {
    surface,
    enabled,
    surfaceEnabled,
    active: enabled && surfaceEnabled && blockers.length === 0,
    modelIds,
    tuning: {
      threshold: readNumber(read, 'voice.wake.threshold', DEFAULTS.threshold),
      patienceFrames: readNumber(read, 'voice.wake.patienceFrames', DEFAULTS.patienceFrames),
      cooldownMs: readNumber(read, 'voice.wake.cooldownMs', DEFAULTS.cooldownMs),
    },
    vadThreshold,
    capture: {
      device: readString(read, 'voice.wake.inputDevice', DEFAULTS.inputDevice),
      backend: readEnum<AudioCaptureBackend>(
        read,
        'voice.wake.captureCommand',
        ['auto', 'pw-record', 'parecord', 'arecord', 'ffmpeg', 'sox'],
        DEFAULTS.captureCommand,
      ),
      noiseSuppression,
      frameSamples: WAKE_CHUNK_SAMPLES,
    },
    activationSound: {
      kind: activationSoundKind === 'custom' && capabilities.canPlayLocalFile !== true
        ? 'chime'
        : activationSoundKind,
      path: activationSoundPath,
    },
    indicator: readEnum(read, 'voice.wake.indicator', ['off', 'statusline', 'banner'] as const, DEFAULTS.indicator),
    preRollMs: readNumber(read, 'voice.wake.preRollMs', DEFAULTS.preRollMs),
    captureMaxSeconds: readNumber(read, 'voice.wake.captureMaxSeconds', DEFAULTS.captureMaxSeconds),
    silenceStopMs: readNumber(read, 'voice.wake.silenceStopMs', DEFAULTS.silenceStopMs),
    autoSubmit: readBoolean(read, 'voice.wake.autoSubmit', DEFAULTS.autoSubmit),
    retainAudio: retainAudio === 'session-temp' && capabilities.canRetainAudio !== true ? 'none' : retainAudio,
    customModelDir: readString(read, 'voice.wake.customModelDir', DEFAULTS.customModelDir),
    supervisor: {
      maxRestarts: readNumber(read, 'voice.wake.maxRestarts', DEFAULTS.maxRestarts),
      restartBackoffMs: readNumber(read, 'voice.wake.restartBackoffMs', DEFAULTS.restartBackoffMs),
      crashWindowSeconds: readNumber(read, 'voice.wake.crashWindowSeconds', DEFAULTS.crashWindowSeconds),
    },
    browserBackend: readEnum(read, 'voice.wake.browserBackend', ['wasm', 'webgpu'] as const, DEFAULTS.browserBackend),
    blockers,
    limitations,
  };
}
