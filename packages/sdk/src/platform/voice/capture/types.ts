/**
 * types.ts — the audio-capture boundary, shared by every voice consumer.
 *
 * Capture is a CAPABILITY, not a wake-word detail. Two consumers sit on it and
 * they must share one device path:
 *
 *  - voice input (push-to-talk): the user starts capture, speaks, stops, and the
 *    audio goes to speech-to-text.
 *  - wake-word detection: capture runs continuously, the detector scores every
 *    frame, and a confirmed wake hands the utterance that FOLLOWS to the same
 *    speech-to-text path.
 *
 * The second is the reason they cannot be separate stacks. A wake is not the end
 * of a capture session, it is the start of one, and re-opening the device at
 * that moment would drop the beginning of the sentence and race the OS for a
 * device that is already open. So a surface opens ONE stream and both consumers
 * read frames from it.
 *
 * WHAT THE SDK OWNS AND WHAT IT DOES NOT
 *
 * The frame contract, the framing arithmetic, the utterance policy (silence,
 * ceilings, pre-roll) and the recorder argv are here, because they are identical
 * on every surface and getting them subtly wrong is silent: audio that is a
 * container header out of alignment, or 62.5 fps against a 100 fps model, still
 * "works" and simply never detects.
 *
 * Opening the device is NOT here. It is per-surface by nature — a recorder
 * subprocess on a host, `getUserMedia` in a browser tab — so a host passes an
 * {@link AudioCaptureOpener} in, exactly as it passes the wake engine an
 * inference session. Nothing in this module imports `node:` anything, so a
 * browser bundle can carry all of it.
 */

/** Sample rate every consumer here works at, matching the wake front end. */
export const CAPTURE_SAMPLE_RATE = 16_000;

/** Channel count. Mono: the classifier and every STT engine here take one channel. */
export const CAPTURE_CHANNELS = 1;

/**
 * Which recorder feeds a host capture stream, mirroring `voice.wake.captureCommand`.
 * `auto` probes in {@link RECORDER_PROBE_ORDER}. A browser surface ignores this.
 */
export type AudioCaptureBackend = 'auto' | 'pw-record' | 'parecord' | 'arecord' | 'ffmpeg' | 'sox';

/**
 * Noise suppression applied before detection, mirroring
 * `voice.wake.noiseSuppression`. `speex` is SpeexDSP's preprocessor, carried in
 * this package as a WebAssembly module and applied by
 * `createNoiseSuppressingOpener` — see ./noise-suppression.ts.
 */
export type AudioCaptureNoiseSuppression = 'none' | 'speex';

/** What a surface wants opened. Mirrors the `voice.wake.*` capture rows. */
export interface AudioCaptureRequest {
  /**
   * Samples per frame handed to {@link AudioCaptureHandlers.onFrame}. The wake
   * engine requires exactly its `chunkSamples` (1280 = 80 ms); voice input is
   * indifferent and uses the same value so one stream can serve both.
   */
  readonly frameSamples: number;
  /** Device identifier, or empty for the operating system default source. */
  readonly device: string;
  /** Recorder to use on a host surface. Ignored by a browser surface. */
  readonly backend: AudioCaptureBackend;
  /**
   * Noise suppression to apply. `speex` is refused when the runtime cannot run
   * the filter, never skipped.
   */
  readonly noiseSuppression: AudioCaptureNoiseSuppression;
}

/**
 * Why capture could not run, or stopped without being asked to. Returned and
 * reported rather than swallowed: a microphone that silently fails to open is
 * indistinguishable to a user from a detector that does not work.
 */
export type AudioCaptureFailureReason =
  /** No recorder from the probe order is installed on this host. */
  | 'no-recorder'
  /** The user or the OS refused microphone access. */
  | 'permission-denied'
  /** The named device does not exist, or is held by something else. */
  | 'device-unavailable'
  /** A browser tab on a plain-http origin: `getUserMedia` does not exist there. */
  | 'insecure-origin'
  /**
   * `speex` was asked for and the suppression stage could not run: a runtime with
   * no WebAssembly, or an opener being driven directly with no filter in front of
   * it. Also reported when a running stage fails mid-stream, because
   * half-filtered audio is not something to continue with quietly.
   */
  | 'noise-suppression-unavailable'
  /** The surface has no capture mechanism at all. */
  | 'unsupported'
  /** The stream ended on its own — recorder exited, or the track was revoked. */
  | 'stream-ended';

/** A capture failure carrying a machine-readable reason beside its message. */
export class AudioCaptureError extends Error {
  readonly reason: AudioCaptureFailureReason;

  constructor(reason: AudioCaptureFailureReason, message: string) {
    super(message);
    this.name = 'AudioCaptureError';
    this.reason = reason;
  }
}

/** Why a capture stream ended. */
export type AudioCaptureStopReason = 'requested' | 'stream-ended' | 'failed';

/** Callbacks a capture stream drives. Frames arrive on a fixed cadence; nothing throws. */
export interface AudioCaptureHandlers {
  /**
   * One frame of exactly `frameSamples` samples, 16 kHz mono, carrying int16
   * MAGNITUDES as floats (-32768..32767) rather than normalised -1..1 values.
   * That is the scale openWakeWord trained the shipped classifier against, and
   * feeding it normalised audio produces scores that never reach any threshold.
   */
  onFrame(frame: Float32Array): void;
  /** The stream ended. `error` is present when the reason is `failed`. */
  onStopped(reason: AudioCaptureStopReason, error?: AudioCaptureError): void;
}

/** A live capture stream. */
export interface AudioCaptureStream {
  /**
   * What actually opened, for an honest indicator — `auto` resolving to
   * `parecord` must be visible as `parecord`, not as `auto`.
   */
  readonly label: string;
  /**
   * True when this stream can target {@link AudioCaptureRequest.device}. `sox`
   * cannot, so a surface can say the setting is being ignored instead of
   * leaving the user to wonder why their device choice did nothing.
   */
  readonly deviceSelectable: boolean;
  /** Stop capturing and release the device. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Opens a capture stream. Supplied by the host: a recorder subprocess on a
 * terminal or daemon surface, `getUserMedia` in a browser tab.
 *
 * Rejects with an {@link AudioCaptureError} rather than a bare Error, so a
 * surface can render the specific honest state (no recorder installed, the user
 * said no, plain-http origin) instead of one generic failure.
 */
export type AudioCaptureOpener = (
  request: AudioCaptureRequest,
  handlers: AudioCaptureHandlers,
) => Promise<AudioCaptureStream>;

/** A structured warning sink, so isomorphic code reports without importing a logger. */
export type AudioCaptureWarn = (message: string, meta?: Readonly<Record<string, unknown>>) => void;
