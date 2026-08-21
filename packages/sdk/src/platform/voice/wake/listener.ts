/**
 * listener.ts, the wake-word runtime: a device, the engine, and what a wake does.
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
import {
  VoiceInputRecorder,
  isSilenceFloorPinned,
  resolveSilenceFloorRms,
  type CapturedUtterance,
} from '../capture/voice-input.js';
// Type-only: diagnostics.ts writes files, and this module must stay runnable in
// a browser tab. The listener HANDS an entry to a recorder the host supplies; it
// never opens the store itself.
import type { VoiceDiagnosticEntry } from '../diagnostics.js';
import { WAKE_SAMPLE_RATE } from './melspectrogram.js';
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
import { recorderBackendFromLabel } from '../capture/recorder-command.js';
import {
  FIRST_FRAME_TIMEOUT_MS,
  FRAMES_FLOWING_STALE_MS,
  START_TIMEOUT_MS,
} from './capture-watchdogs.js';
import {
  resolveAudioInputBinding,
  type AudioInputBinding,
  type AudioInputDeviceEnumerator,
} from '../capture/device-binding.js';
import type { WakeWordEngine } from './engine.js';
import { WakeSupervisor } from './supervisor.js';
import type { WakeRuntimeSettings } from './settings.js';
import type { WakeDetection } from './types.js';

// The listener's public contract lives in listener-types.ts (split for the
// line cap); re-exported here so every consumer keeps its import path.
import type {
  WakeListenerHandlers,
  WakeListenerOptions,
  WakeListenerPhase,
  WakeListenerState,
  WakeStartOutcome,
  WakeStartRefusal,
  WakeTriggered,
} from './listener-types.js';
export type {
  WakeListenerHandlers,
  WakeListenerOptions,
  WakeListenerPhase,
  WakeListenerState,
  WakeStartOutcome,
  WakeStartRefusal,
  WakeTriggered,
} from './listener-types.js';

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

/**
 * How often a fallback looks for the pinned device again.
 *
 * A Bluetooth headset comes back seconds after it is switched on, and the check
 * is one device listing, so half a minute is responsive without polling the
 * audio stack in a loop. Only armed while capture is on the fallback.
 */
const DEVICE_RECHECK_INTERVAL_MS = 30_000;

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
  /** What the device pin last resolved to, and why. */
  #deviceBinding: AudioInputBinding | null = null;
  /** Armed only while on a fallback, looking for the pin to return. */
  #deviceRecheckTimer: unknown = null;
  /** Bounds a start that neither succeeds nor fails, and an open stream that is silent. */
  #startTimer: unknown = null;
  #firstFrameTimer: unknown = null;
  /** Which recorder the current stream is, parsed from its label. */
  #openedBackend: Exclude<WakeRuntimeSettings['capture']['backend'], 'auto'> | null = null;
  #framesSeen = 0;
  #lastFrameAt: number | null = null;
  /**
   * Recorders that opened here and delivered no audio, so `auto` stops choosing
   * them. Never populated for a PINNED backend, substituting one behind the
   * user's back is what the pin prevents. Full reasoning: recorder-command.ts.
   */
  readonly #silentBackends = new Set<Exclude<WakeRuntimeSettings['capture']['backend'], 'auto'>>();

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
      deviceBinding: this.#deviceBinding,
      captureOpen: this.#stream !== null,
      framesFlowing: this.#framesFlowing(),
      framesSeen: this.#framesSeen,
      lastFrameAt: this.#lastFrameAt,
    };
  }

  /** Audio arrived recently enough to still be true. */
  #framesFlowing(): boolean {
    if (this.#stream === null || this.#lastFrameAt === null) return false;
    return this.#now() - this.#lastFrameAt <= FRAMES_FLOWING_STALE_MS;
  }

  /** The resolved input binding, for a status surface. Null before the first start. */
  deviceBinding(): AudioInputBinding | null {
    return this.#deviceBinding;
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
    this.#disarmDeviceRecheck();
    this.#clearStartWatchdog();
    this.#clearFirstFrameWatchdog();
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
    this.#framesSeen = 0;
    this.#lastFrameAt = null;
    this.#armStartWatchdog();

    // THE PIN IS CHECKED BEFORE THE ENGINE IS BUILT. A host with no microphone
    // gets an honest answer without paying for a model load, and a pin naming a
    // device that is not connected is turned into a fallback here rather than
    // handed to a recorder that will sit there producing nothing.
    const binding = await this.#resolveDeviceBinding();
    if (!binding.usable) {
      this.#setPhase('idle');
      this.#lastError = binding.message;
      return { started: false, refusal: 'no-microphone', detail: binding.message };
    }

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
          // The RESOLVED device, not the configured one. This is the whole fix:
          // an absent pin becomes the OS default here instead of becoming silence.
          device: binding.device,
          backend: this.#settings.capture.backend,
          ...(this.#silentBackends.size > 0 ? { excludeBackends: [...this.#silentBackends] } : {}),
          noiseSuppression: this.#settings.capture.noiseSuppression,
        },
        handlers,
      );
      this.#clearStartWatchdog();
      this.#engine = engine;
      this.#stream = stream;
      this.#openedBackend = recorderBackendFromLabel(stream.label);
      this.#supervisor.noteStarted();
      this.#setPhase('listening');
      // Open is not listening. Nothing may claim to hear anything until audio
      // actually arrives, and a stream that never delivers is a failure.
      this.#armFirstFrameWatchdog();
      // Running on a fallback: keep looking for the pinned device so it can come
      // back on its own. Nothing is armed when the pin is present or unset.
      this.#armDeviceRecheck();
      return { started: true, deviceLabel: stream.label };
    } catch (error) {
      this.#clearStartWatchdog();
      const captureError = error instanceof AudioCaptureError
        ? error
        : new AudioCaptureError('unsupported', error instanceof Error ? error.message : String(error));
      this.#lastError = captureError.message;
      this.#setPhase('idle');
      // Reported, not just returned: a boot-time start reaches nobody's return
      // value, so a failure that only travelled that way was invisible.
      this.#options.warn?.('wake capture could not start', {
        reason: captureError.reason,
        detail: captureError.message,
        device: binding.device.length > 0 ? binding.device : 'system default',
      });
      this.#options.handlers?.onFailure?.(captureError, false, `wake capture could not start: ${captureError.message}`);
      return { started: false, refusal: 'capture-unavailable', detail: captureError.message };
    }
  }

  /**
   * Bound the start. A start that neither resolves nor rejects used to leave the
   * listener in `starting` forever with nothing written anywhere, and, because
   * surfaces drove their indicator off the phase, showing "listening".
   */
  #armStartWatchdog(): void {
    this.#clearStartWatchdog();
    const timeout = this.#options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#startTimer = this.#setTimer(() => {
      this.#startTimer = null;
      if (this.#stopping || this.#stream !== null || this.#phase !== 'starting') return;
      const detail = `wake capture did not finish starting within ${timeout} ms; nothing is listening`;
      this.#lastError = detail;
      this.#setPhase('idle');
      this.#options.warn?.('wake capture start stalled', { timeoutMs: timeout });
      this.#options.handlers?.onFailure?.(new AudioCaptureError('unsupported', detail), false, detail);
    }, timeout);
  }

  #clearStartWatchdog(): void {
    if (this.#startTimer === null) return;
    this.#clearTimer(this.#startTimer);
    this.#startTimer = null;
  }

  /**
   * Bound the silence after an open. A recorder pointed at a device it cannot
   * read starts cleanly and delivers nothing; treating that as a capture
   * failure is what turns it into a restart and a line the user can see.
   */
  #armFirstFrameWatchdog(): void {
    this.#clearFirstFrameWatchdog();
    const timeout = this.#options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.#firstFrameTimer = this.#setTimer(() => {
      this.#firstFrameTimer = null;
      if (this.#stopping || this.#stream === null || this.#framesSeen > 0) return;
      const using = this.#deviceBinding?.device;
      const backend = this.#openedBackend;
      // Only `auto` may move on. A pinned backend keeps failing honestly.
      if (backend !== null && this.#settings.capture.backend === 'auto') this.#silentBackends.add(backend);
      const detail = `the capture stream opened on ${using && using.length > 0 ? using : 'the system default input'} `
        + `but delivered no audio within ${timeout} ms`
        + (backend !== null && this.#settings.capture.backend === 'auto'
          ? `; ${backend} cannot capture on this host, so it will not be chosen again`
          : '');
      this.#options.warn?.('wake capture opened but no audio arrived', {
        timeoutMs: timeout,
        backend: backend ?? 'unknown',
      });
      // Routed through the normal stream-failure path so the supervisor retries
      // and the surface is told, exactly as for a recorder that exited.
      this.#onStreamStopped('failed', new AudioCaptureError('device-unavailable', detail));
    }, timeout);
  }

  #clearFirstFrameWatchdog(): void {
    if (this.#firstFrameTimer === null) return;
    this.#clearTimer(this.#firstFrameTimer);
    this.#firstFrameTimer = null;
  }

  /**
   * Resolve the device pin, announcing it when the answer CHANGED.
   *
   * Announced on change rather than on every resolve: the re-check runs on a
   * timer, and repeating "still not connected" every thirty seconds is the log
   * spam this codebase has already been bitten by. A rollover in either
   * direction is one line.
   */
  async #resolveDeviceBinding(): Promise<AudioInputBinding> {
    const binding = await resolveAudioInputBinding(
      this.#settings.capture.device,
      this.#options.enumerateInputDevices,
    );
    const previous = this.#deviceBinding;
    this.#deviceBinding = binding;
    const changed = previous === null
      || previous.state !== binding.state
      || previous.device !== binding.device;
    if (changed) {
      // Anything other than a plainly working device is worth the user's
      // attention, and worth a diagnostic line on the host.
      if (binding.state !== 'pinned' && binding.state !== 'default') {
        this.#options.warn?.('wake input device binding', {
          state: binding.state,
          pinned: binding.pinned,
          using: binding.device.length > 0 ? binding.device : 'system default',
        });
      }
      this.#options.handlers?.onDeviceBinding?.(binding);
    }
    return binding;
  }

  /** Start looking for the pinned device, but only while running on a fallback. */
  #armDeviceRecheck(): void {
    this.#disarmDeviceRecheck();
    if (this.#deviceBinding?.state !== 'fallback') return;
    const interval = this.#options.deviceRecheckMs ?? DEVICE_RECHECK_INTERVAL_MS;
    this.#deviceRecheckTimer = this.#setTimer(() => {
      this.#deviceRecheckTimer = null;
      void this.#recheckDevice();
    }, interval);
  }

  #disarmDeviceRecheck(): void {
    if (this.#deviceRecheckTimer === null) return;
    this.#clearTimer(this.#deviceRecheckTimer);
    this.#deviceRecheckTimer = null;
  }

  /**
   * Look for the pinned device again and move capture back to it if it returned.
   *
   * Rebinding reopens the stream, which is a real interruption, so it happens
   * ONLY when the pin has genuinely come back, never while it is still absent,
   * and never in the middle of recording the utterance after a wake, which
   * would truncate the sentence the user is in the middle of saying.
   */
  async #recheckDevice(): Promise<void> {
    if (this.#stopping || this.#stream === null) return;
    if (this.#recorder !== null) {
      // Mid-utterance: try again on the next tick rather than cutting them off.
      this.#armDeviceRecheck();
      return;
    }
    const before = this.#deviceBinding;
    const binding = await this.#resolveDeviceBinding();
    if (this.#stopping || this.#stream === null) return;
    if (binding.state === 'fallback' || binding.device === (before?.device ?? '')) {
      this.#armDeviceRecheck();
      return;
    }
    // The pin is back (or the host lost its microphone entirely). Reopen on the
    // newly resolved device; #open re-resolves and re-announces.
    const stream = this.#stream;
    this.#stream = null;
    this.#engine = null;
    await stream.stop();
    const outcome = await this.#open();
    if (!outcome.started) {
      this.#options.warn?.('wake could not reopen capture after a device change', {
        detail: outcome.detail,
      });
    }
  }

  #onFrame(frame: Float32Array): void {
    // Audio arrived. This is the ONLY evidence that capture works, and it is
    // recorded before anything else so a status surface can be honest even
    // while an utterance is being recorded.
    this.#framesSeen += 1;
    this.#lastFrameAt = this.#now();
    if (this.#firstFrameTimer !== null) this.#clearFirstFrameWatchdog();
    // While the utterance after a wake is being recorded, frames belong to it and
    // nothing is scored, the phrase just spoken must not be scored again.
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
      // wrote 324 identical lines and grew the activity log to 10 MB, and
      // because the log line ran per frame, the logging itself competed with
      // the scoring that was already behind. The condition is inherently bursty:
      // every frame in a busy stretch trips it, and the 324th line says exactly
      // what the 1st did.
      //
      // So: the FIRST drop in a burst is reported immediately (that is the
      // signal), and the rest are counted and summarised once the burst ends or
      // the interval elapses. Nothing is hidden, the count is the whole story.
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
    // The pre-roll is the only audio from before the user started talking that
    // anything here holds, so it is what the room gets measured from. It is
    // mostly the wake phrase itself; resolveSilenceFloorRms is built for that and
    // reads the quiet frames inside it rather than its average level.
    const recorder = new VoiceInputRecorder({
      captureMaxSeconds: this.#settings.captureMaxSeconds,
      silenceStopMs: this.#settings.silenceStopMs,
      silenceRms: resolveSilenceFloorRms({
        override: this.#settings.silenceFloorRms,
        ambient: detection.preRoll,
        sampleRate: WAKE_SAMPLE_RATE,
      }),
      // A pinned row pins the floor for the whole utterance: the same predicate
      // that made the value win over the measurement also stops the recorder
      // moving it afterwards.
      silenceFloorPinned: isSilenceFloorPinned(this.#settings.silenceFloorRms),
      speechRetriggerMs: this.#settings.speechRetriggerMs,
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
    this.#recordCaptureEnd(utterance);
    // The engine carries a rolling window of the audio it just heard, including
    // the command. Reset so the next phrase is scored on its own.
    this.#engine?.reset();
    if (this.#stream !== null) this.#setPhase('listening');
    this.#options.handlers?.onUtterance?.(utterance, detection);
  }

  /**
   * The receipt for one capture. Written from #completeRecording only, so a
   * capture produces exactly one entry however it ended, including the
   * stream-died path, which completes through the same call.
   *
   * `provider` is the recorder that captured it rather than a transcription
   * provider: nothing has been transcribed yet, and WHICH device produced the
   * audio is the fact that separates "this room is hard" from "this headset is".
   */
  #recordCaptureEnd(utterance: CapturedUtterance): void {
    const record = this.#options.recordDiagnostic;
    if (record === undefined) return;
    const e = utterance.endpointing;
    const round = (value: number): number => Math.round(value);
    record({
      at: new Date(this.#now()).toISOString(),
      operation: 'wake-capture-end',
      route: 'none',
      ok: true,
      provider: this.#stream?.label ?? this.#openedBackend ?? 'unknown',
      configSource: [
        `voice.wake.captureMaxSeconds=${this.#settings.captureMaxSeconds}`,
        `voice.wake.silenceStopMs=${this.#settings.silenceStopMs}`,
        `voice.wake.silenceFloorRms=${this.#settings.silenceFloorRms}`,
        `voice.wake.speechRetriggerMs=${this.#settings.speechRetriggerMs}`,
      ].join(' '),
      detail: [
        `stopped on ${e.stopReason} after ${round(e.durationMs)} ms`,
        `floor ${round(e.initialFloorRms)} -> ${round(e.finalFloorRms)}${e.floorPinned ? ' (pinned)' : ''}`,
        `ambient ${e.ambientRms === null ? 'unmeasured' : round(e.ambientRms)}`,
        `speech level ${round(e.speechLevelRms)}`,
        `trailing silence ${round(e.trailingSilenceMs)} ms`,
        `${e.absorbedBurstCount} short burst(s) absorbed`,
      ].join(', '),
    });
  }

  #discardRecording(): void {
    this.#recorder = null;
    this.#recordingFor = null;
  }

  #onStreamStopped(reason: 'requested' | 'stream-ended' | 'failed', error?: AudioCaptureError): void {
    if (this.#stopping || reason === 'requested') return;
    // A recording in flight when the device died is still worth transcribing,
    // the user spoke, and the audio up to the cut is what they said.
    if (this.#recorder !== null) this.#completeRecording('stream-ended');
    this.#stream = null;
    this.#engine = null;
    // The stream this was watching for is gone; the restart below re-resolves
    // the pin from scratch, which is where the device is re-validated after a
    // capture failure, a device that vanished mid-session becomes a fallback
    // on the next open rather than a restart loop against a dead target.
    this.#disarmDeviceRecheck();
    this.#clearFirstFrameWatchdog();
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
