/**
 * listener.ts — the wake-word runtime: a device, the engine, and what a wake does.
 *
 * The engine scores frames and the capture layer produces them. Everything
 * between those two facts is policy that would otherwise be written once per
 * surface, subtly differently:
 *
 *  - **a wake opens a capture session, it does not end one.** On detection the
 *    listener keeps the SAME stream open and switches it to recording the
 *    utterance that follows, seeded with the pre-roll the detection carried, and
 *    ends it on silence or at the ceiling. Re-opening the device at the moment of
 *    a wake would drop the start of the sentence and race whatever still holds
 *    the microphone.
 *  - **scoring pauses while the utterance is recorded**, and the engine is reset
 *    afterwards. Without the reset, the command just spoken sits in the front
 *    end's rolling window and is scored again as the next phrase arrives.
 *  - **a stream that dies is a restart decision, not an error to log.** The
 *    supervisor already owns that policy; the listener is what actually calls it,
 *    waits the backoff, and stops for good when it latches.
 *  - **disabled means the device is never opened.** `start()` on an inactive
 *    configuration returns a reason and does not touch the capture opener at all,
 *    which is the difference between a microphone permission prompt a user
 *    understands and one they do not.
 *
 * Clock and timers are injected; capture and the engine come from the host. No
 * `node:` imports, so a browser tab runs this unchanged.
 */
import { VoiceInputRecorder, type CapturedUtterance } from '../capture/voice-input.js';
import {
  createNoiseSuppressingOpener,
  type NoiseSuppressionFactory,
} from '../capture/noise-suppression.js';
import {
  AudioCaptureError,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureStream,
  type AudioCaptureWarn,
} from '../capture/types.js';
import type { WakeWordEngine } from './engine.js';
import { WakeSupervisor } from './supervisor.js';
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
}

export interface WakeListenerOptions {
  readonly settings: WakeRuntimeSettings;
  /**
   * Opens the device. The listener wraps it so `voice.wake.noiseSuppression` is
   * applied here rather than per surface — see
   * {@link createNoiseSuppressingOpener}. A host therefore passes the same
   * unfiltered opener it always did.
   */
  readonly openCapture: AudioCaptureOpener;
  /**
   * Builds the suppression stage. Defaults to the embedded speexdsp filter;
   * injected so a test can drive the wiring deterministically.
   */
  readonly createNoiseSuppression?: NoiseSuppressionFactory | undefined;
  /**
   * Builds the engine, models loaded. Called on every start INCLUDING a restart,
   * because a restart exists to recover from a runtime that died — reusing the
   * session that just failed would restart nothing.
   */
  readonly createEngine: () => Promise<WakeWordEngine>;
  readonly handlers?: WakeListenerHandlers | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimeout?: ((handler: () => void, ms: number) => unknown) | undefined;
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
  readonly warn?: AudioCaptureWarn | undefined;
}

/**
 * Frames allowed to queue while inference is behind before frames are dropped.
 * The engine costs ~3.5 ms per 80 ms frame, so a backlog of four means something
 * is genuinely wrong (a host under heavy load, a stalled runtime). Dropping and
 * saying so beats growing a queue that turns into latency and then memory.
 */
const MAX_QUEUED_FRAMES = 4;

/**
 * How often a run of dropped frames is summarised while it continues. The first
 * drop of a burst is always reported at once; this only bounds the repeats.
 */
const DROPPED_FRAME_REPORT_INTERVAL_MS = 30_000;

/** Runs wake detection over one capture stream, per resolved settings. */
export class WakeListener {
  readonly #options: WakeListenerOptions;
  readonly #settings: WakeRuntimeSettings;
  /** The host's opener with the suppression stage in front of it. */
  readonly #openCapture: AudioCaptureOpener;
  readonly #supervisor: WakeSupervisor;
  readonly #now: () => number;
  readonly #setTimer: (handler: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #phase: WakeListenerPhase = 'idle';
  #stream: AudioCaptureStream | null = null;
  #engine: WakeWordEngine | null = null;
  #recorder: VoiceInputRecorder | null = null;
  #recordingFor: WakeDetection | null = null;
  #queued = 0;
  #chain: Promise<void> = Promise.resolve();
  #restartTimer: unknown = null;
  #lastWakeAt: number | null = null;
  #lastError: string | null = null;
  #stopping = false;
  /** Frames dropped since the last line was written about them. */
  #droppedSinceReport = 0;
  /** When the current run of drops began, for the summary's window. */
  #dropBurstStartedAt: number | null = null;
  /** When a drop was last reported, so repeats stay on an interval. */
  #lastDropReportAt = 0;

  constructor(options: WakeListenerOptions) {
    this.#options = options;
    this.#settings = options.settings;
    this.#openCapture = createNoiseSuppressingOpener(options.openCapture, {
      ...(options.createNoiseSuppression !== undefined ? { create: options.createNoiseSuppression } : {}),
      ...(options.warn !== undefined ? { warn: options.warn } : {}),
    });
    this.#supervisor = new WakeSupervisor(options.settings.supervisor);
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.#clearTimer = options.clearTimeout ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });
  }

  /** Current state. Cheap; safe to call from a render path. */
  state(): WakeListenerState {
    const supervisor = this.#supervisor.state(this.#now());
    return {
      phase: this.#phase,
      deviceLabel: this.#stream?.label ?? null,
      latchReason: supervisor.latchReason,
      restarts: supervisor.totalRestarts,
      modelIds: this.#engine?.modelIds ?? [],
      lastWakeAt: this.#lastWakeAt,
      lastError: this.#lastError,
    };
  }

  /**
   * Start listening, or explain why not.
   *
   * Refusals are checked BEFORE the capture opener is touched: a disabled feature
   * must not produce a microphone permission prompt.
   */
  async start(): Promise<WakeStartOutcome> {
    if (this.#stream !== null || this.#phase === 'starting') {
      return { started: false, refusal: 'already-running', detail: 'the wake-word listener is already running' };
    }
    if (!this.#settings.enabled) {
      return {
        started: false,
        refusal: 'disabled',
        detail: 'voice.wake.enabled is off, so no microphone is opened',
      };
    }
    if (!this.#settings.surfaceEnabled) {
      return {
        started: false,
        refusal: 'surface-disabled',
        detail: `voice.wake.surfaces.${this.#settings.surface} is off, so this surface does not listen`,
      };
    }
    const blocker = this.#settings.blockers[0];
    if (blocker !== undefined) {
      return { started: false, refusal: 'blocked', detail: `${blocker.key} ${blocker.detail}` };
    }
    if (this.#supervisor.latched) {
      return {
        started: false,
        refusal: 'blocked',
        detail: this.#supervisor.latchReason ?? 'the wake-word detector is latched off',
      };
    }
    return this.#open();
  }

  /** Stop listening and release the device. Idempotent. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== null) {
      this.#clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    const stream = this.#stream;
    this.#stream = null;
    this.#engine = null;
    this.#discardRecording();
    this.#supervisor.noteStopped();
    if (stream !== null) await stream.stop();
    this.#setPhase('stopped');
    this.#stopping = false;
  }

  /**
   * Clear a latched supervisor so the detector may run again. The deliberate act
   * the latch waits for is the user turning the feature off and on again.
   */
  clearLatch(): void {
    this.#supervisor.clearLatch();
    this.#lastError = null;
  }

  async #open(): Promise<WakeStartOutcome> {
    this.#setPhase('starting');
    let engine: WakeWordEngine;
    try {
      engine = await this.#options.createEngine();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#lastError = detail;
      this.#setPhase('idle');
      return { started: false, refusal: 'capture-unavailable', detail: `the wake models could not be loaded: ${detail}` };
    }
    const handlers: AudioCaptureHandlers = {
      onFrame: (frame) => { this.#onFrame(frame); },
      onStopped: (reason, error) => { this.#onStreamStopped(reason, error); },
    };
    try {
      const stream = await this.#openCapture(
        {
          frameSamples: engine.chunkSamples,
          device: this.#settings.capture.device,
          backend: this.#settings.capture.backend,
          noiseSuppression: this.#settings.capture.noiseSuppression,
        },
        handlers,
      );
      this.#engine = engine;
      this.#stream = stream;
      this.#supervisor.noteStarted();
      this.#setPhase('listening');
      return { started: true, deviceLabel: stream.label };
    } catch (error) {
      const captureError = error instanceof AudioCaptureError
        ? error
        : new AudioCaptureError('unsupported', error instanceof Error ? error.message : String(error));
      this.#lastError = captureError.message;
      this.#setPhase('idle');
      return { started: false, refusal: 'capture-unavailable', detail: captureError.message };
    }
  }

  #onFrame(frame: Float32Array): void {
    // While the utterance after a wake is being recorded, frames belong to it and
    // nothing is scored — the phrase just spoken must not be scored again.
    const recorder = this.#recorder;
    if (recorder !== null) {
      const stop = recorder.push(frame);
      if (stop !== null) this.#completeRecording(stop);
      return;
    }
    if (this.#engine === null) return;
    if (this.#queued >= MAX_QUEUED_FRAMES) {
      // DROPPING IS THE CHEAP PART; SAYING SO EVERY TIME WAS NOT.
      //
      // This warned per dropped frame. A host that fell behind for 23 minutes
      // wrote 324 identical lines and grew the activity log to 10 MB — and
      // because the log line ran per frame, the logging itself competed with
      // the scoring that was already behind. The condition is inherently bursty:
      // every frame in a busy stretch trips it, and the 324th line says exactly
      // what the 1st did.
      //
      // So: the FIRST drop in a burst is reported immediately (that is the
      // signal), and the rest are counted and summarised once the burst ends or
      // the interval elapses. Nothing is hidden — the count is the whole story.
      this.#noteDroppedFrame();
      return;
    }
    if (this.#droppedSinceReport > 0) this.#reportDroppedFrames();
    this.#queued += 1;
    this.#chain = this.#chain.then(async () => {
      const engine = this.#engine;
      if (engine === null) return;
      try {
        const result = await engine.pushFrame(frame);
        for (const detection of result.detections) this.#onDetection(detection);
      } catch (error) {
        this.#options.warn?.('wake frame scoring failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.#queued -= 1;
      }
    });
  }

  /**
   * Count one dropped frame, reporting the first of a burst immediately and the
   * rest at most once per interval. Doing no work here beyond arithmetic is the
   * point: the host is already behind, and the old per-frame log line spent the
   * time it was complaining about not having.
   */
  #noteDroppedFrame(): void {
    const at = this.#now();
    this.#droppedSinceReport += 1;
    if (this.#dropBurstStartedAt === null) {
      this.#dropBurstStartedAt = at;
      this.#lastDropReportAt = at;
      this.#options.warn?.('wake detection is behind real time; dropping frames until it catches up', {
        queued: this.#queued,
      });
      // The line above IS the report for this frame.
      this.#droppedSinceReport = 0;
      return;
    }
    if (at - this.#lastDropReportAt >= DROPPED_FRAME_REPORT_INTERVAL_MS) this.#reportDroppedFrames();
  }

  /** Write the counted summary for a run of drops, then reset the run. */
  #reportDroppedFrames(): void {
    const dropped = this.#droppedSinceReport;
    this.#droppedSinceReport = 0;
    if (dropped === 0) {
      this.#dropBurstStartedAt = null;
      return;
    }
    const at = this.#now();
    const startedAt = this.#dropBurstStartedAt ?? at;
    this.#lastDropReportAt = at;
    this.#dropBurstStartedAt = null;
    this.#options.warn?.('wake detection fell behind real time', {
      droppedFrames: dropped,
      overMs: at - startedAt,
      queued: this.#queued,
    });
  }

  #onDetection(detection: WakeDetection): void {
    // Cooldown and patience already applied by the detector; a detection here is
    // confirmed. Only the first one starts a recording.
    if (this.#recorder !== null) return;
    this.#lastWakeAt = detection.at;
    const recorder = new VoiceInputRecorder({
      captureMaxSeconds: this.#settings.captureMaxSeconds,
      silenceStopMs: this.#settings.silenceStopMs,
    });
    if (detection.preRoll.length > 0) recorder.seedPreRoll(detection.preRoll);
    this.#recorder = recorder;
    this.#recordingFor = detection;
    this.#setPhase('capturing-utterance');
    this.#options.handlers?.onWake?.({
      detection,
      activationSound: this.#settings.activationSound,
    });
  }

  #completeRecording(stopReason: 'requested' | 'silence' | 'max-duration' | 'stream-ended'): void {
    const recorder = this.#recorder;
    const detection = this.#recordingFor;
    this.#recorder = null;
    this.#recordingFor = null;
    if (recorder === null || detection === null) return;
    const utterance = recorder.finish(stopReason);
    // The engine carries a rolling window of the audio it just heard, including
    // the command. Reset so the next phrase is scored on its own.
    this.#engine?.reset();
    if (this.#stream !== null) this.#setPhase('listening');
    this.#options.handlers?.onUtterance?.(utterance, detection);
  }

  #discardRecording(): void {
    this.#recorder = null;
    this.#recordingFor = null;
  }

  #onStreamStopped(reason: 'requested' | 'stream-ended' | 'failed', error?: AudioCaptureError): void {
    if (this.#stopping || reason === 'requested') return;
    // A recording in flight when the device died is still worth transcribing —
    // the user spoke, and the audio up to the cut is what they said.
    if (this.#recorder !== null) this.#completeRecording('stream-ended');
    this.#stream = null;
    this.#engine = null;
    const captureError = error ?? new AudioCaptureError('stream-ended', 'the capture stream ended');
    this.#lastError = captureError.message;
    const decision = this.#supervisor.noteCrashed(this.#now());
    if (decision.kind === 'latched') {
      this.#setPhase('latched');
      this.#options.handlers?.onFailure?.(captureError, false, decision.reason);
      return;
    }
    this.#setPhase('restarting');
    this.#options.handlers?.onFailure?.(
      captureError,
      true,
      `restarting the wake-word detector in ${decision.delayMs} ms (attempt ${decision.attempt})`,
    );
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      if (this.#stopping) return;
      void this.#open();
    }, decision.delayMs);
  }

  #setPhase(phase: WakeListenerPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#options.handlers?.onStateChange?.(this.state());
  }
}
