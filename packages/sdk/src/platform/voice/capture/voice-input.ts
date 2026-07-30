/**
 * voice-input.ts — turning captured frames into ONE utterance to transcribe.
 *
 * The same policy serves both ways an utterance starts, which is the whole point
 * of having it once:
 *
 *  - **push-to-talk**: the user starts, speaks, and stops. Only the ceiling
 *    applies (`voice.wake.captureMaxSeconds`) — a person holding the key is not
 *    asking to be cut off at a pause, so silence-stop is off for this case.
 *  - **after a wake**: nobody is going to press anything, so the utterance has
 *    to end itself. `voice.wake.silenceStopMs` ends it when the speaker stops,
 *    `voice.wake.captureMaxSeconds` is the backstop, and the pre-roll captured
 *    BEFORE the wake fired is prepended so "hey goodvibes, what's—" is not
 *    clipped at the front.
 *
 * SILENCE IS A LEVEL, AND THE LEVEL IS STATED
 *
 * {@link VOICE_INPUT_SILENCE_RMS} is on the int16 magnitude scale the frames
 * carry, not a normalised fraction, so it can be read against the same units as
 * everything else in the capture path. It is deliberately low: cutting a
 * sentence short is far worse than holding the microphone open for the extra
 * second the ceiling would end anyway.
 *
 * Pure and clock-injected: no timers, no device, no I/O. `push` is called with
 * frames and returns the reason to stop, or null to keep going.
 */
import { bytesToBase64, concatSamples, encodeWavPcm16, frameRms } from './frames.js';
import { CAPTURE_SAMPLE_RATE } from './types.js';

/**
 * RMS at or below which a frame counts as silence, on the int16 magnitude scale
 * (full scale 32768). 180 is roughly -45 dBFS: above a quiet room's noise floor
 * and well below speech, which sits two orders of magnitude higher.
 */
export const VOICE_INPUT_SILENCE_RMS = 180;

/** Why an utterance stopped. */
export type VoiceInputStopReason =
  /** The surface asked it to stop — a released key, an explicit cancel. */
  | 'requested'
  /** `silenceStopMs` of silence elapsed after speech. */
  | 'silence'
  /** `captureMaxSeconds` reached. */
  | 'max-duration'
  /** The capture stream ended underneath it. */
  | 'stream-ended';

export interface VoiceInputPolicy {
  /** Hard ceiling in seconds, from `voice.wake.captureMaxSeconds`. */
  readonly captureMaxSeconds: number;
  /**
   * Silence in milliseconds that ends the utterance, from
   * `voice.wake.silenceStopMs`. 0 disables silence-stop, which is what
   * push-to-talk uses.
   */
  readonly silenceStopMs: number;
  /** Sample rate of the frames pushed in. Defaults to the capture rate. */
  readonly sampleRate?: number | undefined;
  /** Silence floor override, on the int16 magnitude scale. */
  readonly silenceRms?: number | undefined;
}

/** A finished utterance, ready to become a speech-to-text request. */
export interface CapturedUtterance {
  /** Every sample kept, pre-roll first. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly durationMs: number;
  /** Milliseconds of the above that came from before the wake fired. */
  readonly preRollMs: number;
  readonly stopReason: VoiceInputStopReason;
  /** True when nothing above the silence floor was ever heard. */
  readonly silent: boolean;
}

/**
 * Accumulates frames into one utterance under the stop policy.
 *
 * One recorder per utterance; call {@link VoiceInputRecorder.finish} once. It
 * tracks time from the frames themselves rather than a clock, so a test can push
 * frames as fast as it likes and get exactly the same decisions a live stream
 * makes at real-time speed.
 */
export class VoiceInputRecorder {
  readonly #policy: VoiceInputPolicy;
  readonly #sampleRate: number;
  readonly #silenceRms: number;
  readonly #chunks: Float32Array[] = [];
  #samples = 0;
  #preRollSamples = 0;
  #trailingSilenceSamples = 0;
  #heardSpeech = false;
  #finished = false;

  constructor(policy: VoiceInputPolicy) {
    this.#policy = policy;
    this.#sampleRate = policy.sampleRate ?? CAPTURE_SAMPLE_RATE;
    this.#silenceRms = policy.silenceRms ?? VOICE_INPUT_SILENCE_RMS;
  }

  /** Milliseconds of audio held so far, pre-roll included. */
  get durationMs(): number {
    return (this.#samples / this.#sampleRate) * 1000;
  }

  /** True once a frame above the silence floor has been seen. */
  get heardSpeech(): boolean {
    return this.#heardSpeech;
  }

  /**
   * Seed the utterance with audio from before it started — the wake detection's
   * pre-roll. Must be called before any {@link push}, and does not count toward
   * the silence tracking: it is by definition the phrase that just triggered.
   */
  seedPreRoll(samples: Float32Array): void {
    if (this.#samples > 0) {
      throw new Error('[capture] pre-roll must be seeded before frames are pushed');
    }
    if (samples.length === 0) return;
    this.#chunks.push(samples.slice());
    this.#samples += samples.length;
    this.#preRollSamples = samples.length;
  }

  /**
   * Add one frame. Returns the reason the utterance should stop, or null to keep
   * capturing. The frame is always kept first — a frame that trips the ceiling is
   * part of the utterance, not discarded with it.
   */
  push(frame: Float32Array): VoiceInputStopReason | null {
    if (this.#finished) return null;
    this.#chunks.push(frame.slice());
    this.#samples += frame.length;
    if (frameRms(frame) > this.#silenceRms) {
      this.#heardSpeech = true;
      this.#trailingSilenceSamples = 0;
    } else {
      this.#trailingSilenceSamples += frame.length;
    }
    if (this.#samples >= this.#policy.captureMaxSeconds * this.#sampleRate) return 'max-duration';
    if (this.#policy.silenceStopMs > 0 && this.#heardSpeech) {
      const silenceMs = (this.#trailingSilenceSamples / this.#sampleRate) * 1000;
      if (silenceMs >= this.#policy.silenceStopMs) return 'silence';
    }
    return null;
  }

  /** Close the utterance out. Safe to call once; the recorder is spent after it. */
  finish(stopReason: VoiceInputStopReason): CapturedUtterance {
    this.#finished = true;
    const samples = concatSamples(this.#chunks);
    return {
      samples,
      sampleRate: this.#sampleRate,
      durationMs: (samples.length / this.#sampleRate) * 1000,
      preRollMs: (this.#preRollSamples / this.#sampleRate) * 1000,
      stopReason,
      silent: !this.#heardSpeech,
    };
  }
}

/** A speech-to-text request body, matching the `voice.stt` verb's audio artifact. */
export interface UtteranceAudioArtifact {
  readonly mimeType: string;
  readonly format: string;
  readonly dataBase64: string;
  readonly sampleRateHz: number;
  readonly durationMs: number;
}

/**
 * Encode an utterance as the audio artifact the `voice.stt` verb takes.
 *
 * WAV rather than a compressed container: a host-captured stream has no codec in
 * front of it, and the provisioned whisper build reads WAV directly. The base64
 * is produced without `Buffer` so the same call works in a browser tab.
 */
export function utteranceToAudioArtifact(utterance: CapturedUtterance): UtteranceAudioArtifact {
  const wav = encodeWavPcm16(utterance.samples, utterance.sampleRate);
  return {
    mimeType: 'audio/wav',
    format: 'wav',
    dataBase64: bytesToBase64(wav),
    sampleRateHz: utterance.sampleRate,
    durationMs: Math.round(utterance.durationMs),
  };
}
