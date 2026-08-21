/**
 * listener-types.ts, the wake listener's public contract, split from
 * listener.ts so the runtime file stays under the line cap. Pure declarations:
 * nothing here executes, and listener.ts re-exports every name so consumers
 * keep their import path.
 */
import type { CapturedUtterance } from '../capture/voice-input.js';
import type { VoiceDiagnosticEntry } from '../diagnostics.js';
import type { NoiseSuppressionFactory } from '../capture/noise-suppression.js';
import type {
  AudioCaptureError,
  AudioCaptureOpener,
  AudioCaptureWarn,
} from '../capture/types.js';
import type {
  AudioInputBinding,
  AudioInputDeviceEnumerator,
} from '../capture/device-binding.js';
import type { WakeWordEngine } from './engine.js';
import type { WakeRuntimeSettings } from './settings.js';
import type { WakeDetection } from './types.js';

/** What the listener is doing, for an indicator that must never be stale. */
export type WakeListenerPhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'capturing-utterance'
  | 'restarting'
  | 'latched'
  | 'stopped';

/** A snapshot for a status surface. */
export interface WakeListenerState {
  readonly phase: WakeListenerPhase;
  /** What opened the device, e.g. `parecord`; null while nothing is open. */
  readonly deviceLabel: string | null;
  /** Why the supervisor gave up, or null while it has not. */
  readonly latchReason: string | null;
  /** Restarts issued since this listener started. */
  readonly restarts: number;
  /** Models being scored. Empty when `voice.wake.models` is empty. */
  readonly modelIds: readonly string[];
  /** When the last wake confirmed, or null. */
  readonly lastWakeAt: number | null;
  /** The most recent capture failure's message, or null. */
  readonly lastError: string | null;
  /**
   * What `voice.wake.inputDevice` actually resolved to, and why.
   *
   * A status surface must show this rather than the configured value: a pin
   * naming a device that is not connected reads as "listening on my headset"
   * while the headset is in a drawer. Null before the first resolve.
   */
  readonly deviceBinding: AudioInputBinding | null;
  /**
   * A capture stream is OPEN. Not the same as listening: a stream can open and
   * deliver nothing at all.
   */
  readonly captureOpen: boolean;
  /**
   * Frames have actually arrived recently. THE ONLY basis on which anything may
   * claim to be listening.
   *
   * A surface showed "listening for the wake phrase" through an entire boot on a
   * machine with zero capture streams, no recorder process, and not one line in
   * the log, because the indicator was driven by the listener's INTENT (it had
   * reached `starting`) rather than by audio. Intent is not evidence.
   */
  readonly framesFlowing: boolean;
  /** Frames delivered since this listener started. */
  readonly framesSeen: number;
  /** When the last frame arrived, or null if none ever has. */
  readonly lastFrameAt: number | null;
}

/** Why the listener would not start. */
export type WakeStartRefusal =
  /** `voice.wake.enabled` is off. */
  | 'disabled'
  /** `voice.wake.surfaces.<surface>` is off for this surface. */
  | 'surface-disabled'
  /** A row blocks it; `detail` carries the written reason. */
  | 'blocked'
  /** Capture could not be opened; `detail` carries the reason. */
  | 'capture-unavailable'
  /**
   * This host has no microphone, no input sources, or only output monitors.
   * Distinct from `capture-unavailable` because nothing is broken and nothing
   * will fix itself: showing a listening indicator here would be a lie.
   */
  | 'no-microphone'
  /** Already running. */
  | 'already-running';

/** The result of asking the listener to start. */
export type WakeStartOutcome =
  | { readonly started: true; readonly deviceLabel: string }
  | { readonly started: false; readonly refusal: WakeStartRefusal; readonly detail: string };

/** A confirmed wake, with the feedback the surface owes the user. */
export interface WakeTriggered {
  readonly detection: WakeDetection;
  /** The sound to play now, already resolved against surface capability. */
  readonly activationSound: WakeRuntimeSettings['activationSound'];
}

export interface WakeListenerHandlers {
  readonly onStateChange?: ((state: WakeListenerState) => void) | undefined;
  /** A wake confirmed. Play the sound and show the indicator now, not later. */
  readonly onWake?: ((event: WakeTriggered) => void) | undefined;
  /**
   * The utterance that followed a wake, ready for speech-to-text. The host owns
   * transcription (it may go through the daemon) and applies
   * `voice.wake.autoSubmit` to the text it gets back.
   */
  readonly onUtterance?: ((utterance: CapturedUtterance, detection: WakeDetection) => void) | undefined;
  /** Capture failed or ended. `restarting` false means the supervisor latched. */
  readonly onFailure?: ((error: AudioCaptureError, restarting: boolean, detail: string) => void) | undefined;
  /**
   * The input device binding resolved or CHANGED, the pinned device was
   * missing and capture fell back, or it came back and capture moved to it.
   * One line, shown to the user: a device rollover that happens silently is
   * indistinguishable from a detector that stopped working.
   */
  readonly onDeviceBinding?: ((binding: AudioInputBinding) => void) | undefined;
}

export interface WakeListenerOptions {
  readonly settings: WakeRuntimeSettings;
  /**
   * Opens the device. The listener wraps it so `voice.wake.noiseSuppression` is
   * applied here rather than per surface, see createNoiseSuppressingOpener in
   * capture/noise-suppression.ts. A host therefore passes the same unfiltered
   * opener it always did.
   */
  readonly openCapture: AudioCaptureOpener;
  /**
   * Builds the suppression stage. Defaults to the embedded speexdsp filter;
   * injected so a test can drive the wiring deterministically.
   */
  readonly createNoiseSuppression?: NoiseSuppressionFactory | undefined;
  /**
   * Builds the engine, models loaded. Called on every start INCLUDING a restart,
   * because a restart exists to recover from a runtime that died, reusing the
   * session that just failed would restart nothing.
   */
  readonly createEngine: () => Promise<WakeWordEngine>;
  readonly handlers?: WakeListenerHandlers | undefined;
  /**
   * Lists this host's input devices, so `voice.wake.inputDevice` can be checked
   * rather than believed. Omitted, the pin is used exactly as written and the
   * binding reports itself unverified, the behaviour every surface had before
   * this seam existed.
   */
  readonly enumerateInputDevices?: AudioInputDeviceEnumerator | undefined;
  /**
   * How often a fallback re-checks for the pinned device, ms. Only runs while
   * capture is on the fallback, so a host with its device present pays nothing.
   */
  readonly deviceRecheckMs?: number | undefined;
  /**
   * How long a start may take before it is reported as stalled, ms.
   *
   * There was no such bound. Opening builds an inference engine and a capture
   * stream, and an await that never settles left the listener in `starting`
   * forever, silently, because nothing reports a start that neither succeeds
   * nor fails. A stall is now a failure like any other.
   */
  readonly startTimeoutMs?: number | undefined;
  /**
   * How long an OPEN stream may deliver nothing before it is treated as failed,
   * ms. A recorder that starts against a device it cannot read exits 0 or sits
   * there producing no bytes; either way the audio never arrives and the only
   * honest reading is that capture is not working.
   */
  readonly firstFrameTimeoutMs?: number | undefined;
  /**
   * Where a capture-end receipt goes. One entry per completed capture, carrying
   * the numbers the endpointing actually decided from.
   *
   * A capture that ran to the ceiling and one that ended on silence are the same
   * event from outside: an utterance arrived. Which of them happened, and what
   * the floor was doing when it did, is the whole diagnosis of "it kept
   * listening after I stopped talking", and it was not written down anywhere.
   * Omitted, nothing is recorded and the listener behaves exactly as before.
   */
  readonly recordDiagnostic?: ((entry: VoiceDiagnosticEntry) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimeout?: ((handler: () => void, ms: number) => unknown) | undefined;
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  readonly warn?: AudioCaptureWarn | undefined;
}
