/**
 * push-to-talk.ts — the voice-input session both surfaces drive.
 *
 * This is the OTHER consumer of the capture primitive, and the one that has been
 * missing outright on the terminal: whisper is provisioned there and transcribes
 * on request, but nothing ever handed it audio, because nothing captured any.
 *
 * The state machine is small and identical on both surfaces, which is exactly why
 * it belongs here rather than in each of them: start (asking for the device is
 * its own visible phase, because a permission prompt takes real time), record,
 * stop, transcribe, done — with a device release on every path out, including the
 * failing ones. A microphone left open after a failed transcription is the bug
 * users notice and never report precisely.
 *
 * Transcription itself is injected. On both surfaces the audio goes to the
 * daemon's `voice.stt` verb rather than to a local library, so the SDK holds the
 * policy and the surface holds the call.
 */
import {
  createNoiseSuppressingOpener,
  type NoiseSuppressionFactory,
} from './noise-suppression.js';
import {
  AudioCaptureError,
  type AudioCaptureBackend,
  type AudioCaptureNoiseSuppression,
  type AudioCaptureOpener,
  type AudioCaptureStream,
} from './types.js';
import { VoiceInputRecorder, type CapturedUtterance, type VoiceInputStopReason } from './voice-input.js';

/** Where a voice-input session is. Mirrors what a surface renders. */
export type PushToTalkPhase = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error';

export interface PushToTalkOptions {
  /**
   * Opens the device. Wrapped here so `voice.wake.noiseSuppression` reaches voice
   * input as well as wake detection — the row is shared, so the filter must be —
   * see {@link createNoiseSuppressingOpener}. A host passes its plain opener.
   */
  readonly openCapture: AudioCaptureOpener;
  /**
   * Builds the suppression stage. Defaults to the embedded speexdsp filter;
   * injected so a test can drive the wiring deterministically.
   */
  readonly createNoiseSuppression?: NoiseSuppressionFactory | undefined;
  /** Device, backend and suppression, from the shared `voice.wake.*` capture rows. */
  readonly capture: {
    readonly device: string;
    readonly backend: AudioCaptureBackend;
    readonly noiseSuppression: AudioCaptureNoiseSuppression;
    readonly frameSamples: number;
  };
  /**
   * Hard ceiling, from `voice.wake.captureMaxSeconds`. It applies to held-key
   * capture too: a key event that never arrives (a lost focus, a dropped
   * terminal) must not hold the microphone open indefinitely.
   */
  readonly captureMaxSeconds: number;
  /**
   * Silence that ends capture on its own. 0 — the push-to-talk default — leaves
   * stopping to the user, because someone holding a key through a pause has not
   * finished talking.
   */
  readonly silenceStopMs?: number | undefined;
  readonly onPhaseChange?: ((phase: PushToTalkPhase) => void) | undefined;
  /** Capture ended itself (ceiling or silence) rather than being stopped. */
  readonly onAutoStop?: ((utterance: CapturedUtterance) => void) | undefined;
  readonly onError?: ((error: AudioCaptureError) => void) | undefined;
}

/**
 * One press-to-talk capture. Reusable: `start` again after a `stop` or a failure.
 */
export class PushToTalkSession {
  readonly #options: PushToTalkOptions;
  /** The host's opener with the suppression stage in front of it. */
  readonly #openCapture: AudioCaptureOpener;
  #phase: PushToTalkPhase = 'idle';
  #stream: AudioCaptureStream | null = null;
  #recorder: VoiceInputRecorder | null = null;

  constructor(options: PushToTalkOptions) {
    this.#options = options;
    this.#openCapture = createNoiseSuppressingOpener(options.openCapture, {
      ...(options.createNoiseSuppression !== undefined ? { create: options.createNoiseSuppression } : {}),
    });
  }

  get phase(): PushToTalkPhase {
    return this.#phase;
  }

  /** What opened the device, for an indicator; null when nothing is open. */
  get deviceLabel(): string | null {
    return this.#stream?.label ?? null;
  }

  /** Milliseconds captured so far. */
  get durationMs(): number {
    return this.#recorder?.durationMs ?? 0;
  }

  /**
   * Open the device and start recording. Rejects with an
   * {@link AudioCaptureError} so a surface can render the specific reason — no
   * recorder installed, permission refused, plain-http origin.
   */
  async start(): Promise<void> {
    if (this.#stream !== null) return;
    this.#setPhase('requesting');
    const recorder = new VoiceInputRecorder({
      captureMaxSeconds: this.#options.captureMaxSeconds,
      silenceStopMs: this.#options.silenceStopMs ?? 0,
    });
    try {
      const stream = await this.#openCapture(
        {
          frameSamples: this.#options.capture.frameSamples,
          device: this.#options.capture.device,
          backend: this.#options.capture.backend,
          noiseSuppression: this.#options.capture.noiseSuppression,
        },
        {
          onFrame: (frame) => {
            const stop = this.#recorder?.push(frame);
            if (stop !== null && stop !== undefined) void this.#endWith(stop);
          },
          onStopped: (reason, error) => {
            if (reason === 'requested') return;
            this.#fail(error ?? new AudioCaptureError('stream-ended', 'the capture stream ended'));
          },
        },
      );
      this.#recorder = recorder;
      this.#stream = stream;
      this.#setPhase('recording');
    } catch (error) {
      this.#recorder = null;
      const captureError = error instanceof AudioCaptureError
        ? error
        : new AudioCaptureError('unsupported', error instanceof Error ? error.message : String(error));
      this.#setPhase('error');
      this.#options.onError?.(captureError);
      throw captureError;
    }
  }

  /**
   * Stop recording, release the device, and return what was captured. Returns
   * null when nothing was recording, so a released key with no press behind it is
   * a no-op rather than an error.
   */
  async stop(): Promise<CapturedUtterance | null> {
    if (this.#stream === null || this.#recorder === null) return null;
    return this.#endWith('requested');
  }

  /** Abandon the capture and release the device, keeping nothing. */
  async cancel(): Promise<void> {
    const stream = this.#stream;
    this.#stream = null;
    this.#recorder = null;
    if (stream !== null) await stream.stop();
    this.#setPhase('idle');
  }

  async #endWith(reason: VoiceInputStopReason): Promise<CapturedUtterance> {
    const recorder = this.#recorder;
    const stream = this.#stream;
    this.#recorder = null;
    this.#stream = null;
    this.#setPhase('stopping');
    if (stream !== null) await stream.stop();
    const utterance = (recorder ?? new VoiceInputRecorder({
      captureMaxSeconds: this.#options.captureMaxSeconds,
      silenceStopMs: 0,
    })).finish(reason);
    this.#setPhase('idle');
    // An auto-stop has nobody awaiting the return value, so it is announced.
    if (reason !== 'requested') this.#options.onAutoStop?.(utterance);
    return utterance;
  }

  #fail(error: AudioCaptureError): void {
    this.#recorder = null;
    this.#stream = null;
    this.#setPhase('error');
    this.#options.onError?.(error);
  }

  #setPhase(phase: PushToTalkPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#options.onPhaseChange?.(phase);
  }
}
