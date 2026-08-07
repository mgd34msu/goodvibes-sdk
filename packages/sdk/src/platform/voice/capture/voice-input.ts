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
 * SILENCE IS A LEVEL, AND THE LEVEL IS MEASURED
 *
 * {@link VOICE_INPUT_SILENCE_RMS} is on the int16 magnitude scale the frames
 * carry, not a normalised fraction, so it can be read against the same units as
 * everything else in the capture path. It is deliberately low: cutting a
 * sentence short is far worse than holding the microphone open for the extra
 * second the ceiling would end anyway.
 *
 * A FIXED level is only correct for a room quieter than the level. In a room
 * whose steady noise sits ABOVE it — a fan, a compressor, traffic — no frame is
 * ever silent, `silenceStopMs` never accumulates, and every capture rides to the
 * ceiling no matter when the speaker stopped. So the floor is measured from the
 * room instead: {@link resolveSilenceFloorRms} sets it from the pre-wake audio
 * the listener already holds, and the constant becomes the fallback for when
 * there is no sample to measure. The derivation is written out on that function.
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

/**
 * Analysis frame for the ambient measurement, in milliseconds.
 *
 * Short on purpose. The window being measured contains SPEECH — it is the audio
 * that just triggered the wake — and the estimate below works by finding the
 * quiet frames inside it. 20 ms is short enough to land wholly inside a stop
 * closure or an inter-word gap; at 80 ms (the detector's frame) every frame of a
 * spoken phrase carries some speech energy and there is no quiet frame to find.
 */
export const VOICE_INPUT_AMBIENT_FRAME_MS = 20;

/**
 * Fewest analysis frames that can produce an estimate — 160 ms of audio.
 *
 * Below this the low percentile is one or two frames and is no longer a
 * statistic, so no estimate is reported and the caller falls back to the fixed
 * constant rather than adapting to a number it cannot stand behind.
 */
export const VOICE_INPUT_AMBIENT_MIN_FRAMES = 8;

/**
 * Which order statistic of the frame levels is taken as the noise floor.
 *
 * This is minimum statistics: over a window long enough to contain a pause, the
 * LOW end of the level distribution tracks the noise floor, because the noise is
 * present in every frame and the speech is not. The plain minimum is the
 * textbook form but rides on a single frame; the 20th percentile keeps that
 * behaviour while surviving one anomalously quiet frame.
 *
 * The estimator is biased LOW — the quietest frames of a spoken phrase sit at or
 * slightly below the true floor — and low is the safe direction here: an
 * underestimate reproduces today's behaviour (capture rides to the ceiling)
 * while an overestimate would put the floor above speech, which would mean never
 * hearing the speaker at all. The margin below is what pays that bias back.
 */
export const VOICE_INPUT_AMBIENT_PERCENTILE = 0.2;

/**
 * How far above measured ambient the floor is placed, as a linear ratio. 4 is
 * +12 dB.
 *
 * Two things have to fit between the noise floor and the floor we set. A steady
 * noise is only steady in the mean: its own 20 ms frame levels scatter by
 * several dB, so a floor sitting a dB or two over the mean would still see
 * "loud" frames and never accumulate silence. And the estimate itself is biased
 * low, as above. +12 dB clears both. It also stays well clear of speech, which
 * the fixed constant's own note puts about two orders of magnitude (40 dB) over
 * a quiet room — leaving roughly 28 dB of headroom under the speaker.
 */
export const VOICE_INPUT_ADAPTIVE_MARGIN = 4;

/**
 * The highest the adaptive floor may go, on the int16 magnitude scale.
 *
 * 8x the fixed constant — +18 dB over it, about -27 dBFS. A room noisy enough to
 * push the floor past this cannot be separated into speech and silence by LEVEL
 * alone: the next thing above -27 dBFS is the speaker. Clamping here means such
 * a room keeps the pre-existing behaviour (silence never accumulates, the
 * ceiling ends the capture), which is a far better failure than a floor set over
 * the speaker's own level, where nothing is ever heard as speech at all.
 */
export const VOICE_INPUT_ADAPTIVE_FLOOR_MAX = VOICE_INPUT_SILENCE_RMS * 8;

/**
 * Measure the room's noise floor from a window of audio, on the int16 magnitude
 * scale. Returns null when the window is too short to measure.
 *
 * The window it is given is the wake detection's pre-roll, which is mostly the
 * wake phrase itself. That is fine, and is the reason for the order statistic
 * rather than a mean: see {@link VOICE_INPUT_AMBIENT_PERCENTILE}. A mean over
 * this window would measure the SPEAKER, not the room.
 */
export function estimateAmbientRms(
  ambient: Float32Array,
  sampleRate: number = CAPTURE_SAMPLE_RATE,
): number | null {
  const frameSamples = Math.max(1, Math.round((VOICE_INPUT_AMBIENT_FRAME_MS / 1000) * sampleRate));
  const frameCount = Math.floor(ambient.length / frameSamples);
  if (frameCount < VOICE_INPUT_AMBIENT_MIN_FRAMES) return null;
  const levels: number[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    levels.push(frameRms(ambient.subarray(i * frameSamples, (i + 1) * frameSamples)));
  }
  levels.sort((a, b) => a - b);
  const index = Math.floor((levels.length - 1) * VOICE_INPUT_AMBIENT_PERCENTILE);
  return levels[index] ?? null;
}

/**
 * Decide the silence floor for one utterance. The single place the rule lives.
 *
 * In order:
 *  1. An explicit `voice.wake.silenceFloorRms` above 0 wins outright — someone
 *     who set a level meant that level, and is not asking to be second-guessed.
 *  2. Otherwise measure the room from `ambient` and place the floor
 *     {@link VOICE_INPUT_ADAPTIVE_MARGIN} above it, clamped into
 *     [{@link VOICE_INPUT_SILENCE_RMS}, {@link VOICE_INPUT_ADAPTIVE_FLOOR_MAX}].
 *     The LOWER clamp is what keeps a genuinely quiet room behaving exactly as
 *     it does today: measuring near-silence can only ever hold the floor at the
 *     constant, never drop it below and start clipping sentences.
 *  3. With no sample, or too short a one, the constant stands unchanged.
 */
export function resolveSilenceFloorRms(options: {
  /** `voice.wake.silenceFloorRms`. 0 or unset means adapt. */
  readonly override?: number | undefined;
  /** Pre-wake audio to measure the room from. */
  readonly ambient?: Float32Array | undefined;
  readonly sampleRate?: number | undefined;
}): number {
  const { override } = options;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const { ambient } = options;
  if (ambient === undefined || ambient.length === 0) return VOICE_INPUT_SILENCE_RMS;
  const measured = estimateAmbientRms(ambient, options.sampleRate);
  if (measured === null || !Number.isFinite(measured)) return VOICE_INPUT_SILENCE_RMS;
  return Math.min(
    VOICE_INPUT_ADAPTIVE_FLOOR_MAX,
    Math.max(VOICE_INPUT_SILENCE_RMS, measured * VOICE_INPUT_ADAPTIVE_MARGIN),
  );
}

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
  /**
   * Hard ceiling in seconds, from `voice.wake.captureMaxSeconds`. 0 removes the
   * ceiling entirely, leaving silence-stop (post-wake) or the key release
   * (push-to-talk) as the only thing that ends the utterance.
   */
  readonly captureMaxSeconds: number;
  /**
   * Silence in milliseconds that ends the utterance, from
   * `voice.wake.silenceStopMs`. 0 disables silence-stop, which is what
   * push-to-talk uses.
   */
  readonly silenceStopMs: number;
  /** Sample rate of the frames pushed in. Defaults to the capture rate. */
  readonly sampleRate?: number | undefined;
  /**
   * The silence floor for this utterance, on the int16 magnitude scale, already
   * decided by {@link resolveSilenceFloorRms}. Unset falls back to the fixed
   * {@link VOICE_INPUT_SILENCE_RMS}, which is what a caller with no ambient
   * sample to measure gets anyway.
   */
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
  /**
   * The ceiling in samples, or Infinity when `captureMaxSeconds` is 0.
   *
   * Resolved ONCE here rather than multiplied out per frame, because 0 seconds
   * is 0 samples and `samples >= 0` is true on the very first frame — a literal
   * reading of "no ceiling" that would end every utterance immediately. Infinity
   * is the honest spelling of no ceiling and compares correctly forever; the
   * count itself is a double, so a capture long enough to lose precision would
   * have to run for centuries.
   */
  readonly #maxSamples: number;
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
    this.#maxSamples = policy.captureMaxSeconds > 0
      ? policy.captureMaxSeconds * this.#sampleRate
      : Number.POSITIVE_INFINITY;
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
    if (this.#samples >= this.#maxSamples) return 'max-duration';
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
