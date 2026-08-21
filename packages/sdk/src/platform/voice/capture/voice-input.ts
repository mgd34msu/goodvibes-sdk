/**
 * voice-input.ts, turning captured frames into ONE utterance to transcribe.
 *
 * The same policy serves both ways an utterance starts, which is the whole point
 * of having it once:
 *
 *  - **push-to-talk**: the user starts, speaks, and stops. Only the ceiling
 *    applies (`voice.wake.captureMaxSeconds`), a person holding the key is not
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
 * whose steady noise sits ABOVE it, a fan, a compressor, traffic, no frame is
 * ever silent, `silenceStopMs` never accumulates, and every capture rides to the
 * ceiling no matter when the speaker stopped. So the floor is measured from the
 * room instead: {@link resolveSilenceFloorRms} sets it from the pre-wake audio
 * the listener already holds, and the constant becomes the fallback for when
 * there is no sample to measure. The derivation is written out on that function.
 *
 * ONE MEASUREMENT IS NOT ENOUGH, AND ONE LOUD FRAME IS NOT SPEECH
 *
 * A floor measured once, before the utterance, assumes the scale does not move
 * while the utterance runs. On a bluetooth headset it moves: automatic gain
 * control ramps the input up once the speaker stops, and the room the pre-roll
 * measured comes back louder than the floor derived from it. Every frame reads
 * as speech from then on and the capture rides the ceiling again, the same
 * defect the measurement was added to fix, arriving from the other direction.
 * So the floor also FOLLOWS: {@link VoiceInputRecorder} keeps a windowed minimum
 * of the recent frame levels and raises the floor with it, bounded under the
 * speech it is hearing at the same time so it can never rise over the speaker.
 *
 * And a close-worn microphone hears things that are loud without being speech,
 * a breath, a lip tick, a chair. Each is one or two frames. Treating every loud
 * frame as speech means each one resets the trailing-silence count to zero, so a
 * tick every half second holds the microphone open indefinitely with nobody
 * talking. Silence is therefore ended by a loud RUN of at least
 * `voice.wake.speechRetriggerMs`, and a shorter run counts toward silence rather
 * than against it.
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
 * Short on purpose. The window being measured contains SPEECH, it is the audio
 * that just triggered the wake, and the estimate below works by finding the
 * quiet frames inside it. 20 ms is short enough to land wholly inside a stop
 * closure or an inter-word gap; at 80 ms (the detector's frame) every frame of a
 * spoken phrase carries some speech energy and there is no quiet frame to find.
 */
export const VOICE_INPUT_AMBIENT_FRAME_MS = 20;

/**
 * Fewest analysis frames that can produce an estimate, 160 ms of audio.
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
 * The estimator is biased LOW, the quietest frames of a spoken phrase sit at or
 * slightly below the true floor, and low is the safe direction here: an
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
 * a quiet room, leaving roughly 28 dB of headroom under the speaker.
 */
export const VOICE_INPUT_ADAPTIVE_MARGIN = 4;

/**
 * The highest the adaptive floor may go, on the int16 magnitude scale.
 *
 * 8x the fixed constant, +18 dB over it, about -27 dBFS. A room noisy enough to
 * push the floor past this cannot be separated into speech and silence by LEVEL
 * alone: the next thing above -27 dBFS is the speaker. Clamping here means such
 * a room keeps the pre-existing behaviour (silence never accumulates, the
 * ceiling ends the capture), which is a far better failure than a floor set over
 * the speaker's own level, where nothing is ever heard as speech at all.
 */
export const VOICE_INPUT_ADAPTIVE_FLOOR_MAX = VOICE_INPUT_SILENCE_RMS * 8;

/**
 * How far back the rolling ambient estimate looks, in milliseconds.
 *
 * The estimate is a windowed MINIMUM, so the window has to be long enough to
 * contain at least one quiet moment or it reads the speaker instead of the room.
 * 1.5 s covers a stop closure or an inter-word gap several times over, and is
 * still short enough to have forgotten a gain change about a second after it
 * happens. It sits just above the default `voice.wake.silenceStopMs` on purpose:
 * the window that decides a stop is then measured against audio from the same
 * pause, not from the room as it was before the speaker started.
 */
export const VOICE_INPUT_ROLLING_WINDOW_MS = 1500;

/**
 * The floor is never raised above this fraction of the speech level tracked over
 * the same capture, 3 is about 9.5 dB of clearance under the speaker.
 *
 * This is the guard that makes raising the floor DURING a capture safe at all. A
 * floor that walks up with the room and is not held under something has exactly
 * one catastrophic failure: it passes the speaker's own level, every frame reads
 * as silence, and the utterance ends the instant it begins. Bounding it against
 * the loudest thing this capture has heard means the failure cannot happen,
 * whatever else is true, there is always most of a factor of three between the
 * floor and the voice it has to stay under.
 */
export const VOICE_INPUT_SPEECH_FLOOR_RATIO = 3;

/**
 * Half-life of the tracked speech level, in milliseconds.
 *
 * Deliberately long, comparable to a whole capture rather than to a pause. The
 * tracker is a running maximum that decays, and the decay is only there so a
 * speaker who genuinely gets quieter across a long dictation is not measured
 * against how loud they were at the start.
 *
 * A FAST decay breaks the guard in the exact case it exists for. Once the tracked
 * level falls to the risen noise floor, the noise becomes the "speech" the guard
 * is protecting, the cap collapses to a third of the noise, and the floor is
 * pinned below the thing it was supposed to rise over. Eight seconds keeps the
 * loudest speech of this utterance in force for the length of the default
 * ceiling, which is the span any one stop decision is made in.
 */
export const VOICE_INPUT_SPEECH_LEVEL_HALF_LIFE_MS = 8000;

/**
 * The highest the ROLLING floor may go, on the int16 magnitude scale. 32x the
 * fixed constant, four times {@link VOICE_INPUT_ADAPTIVE_FLOOR_MAX}.
 *
 * The 8x cap on the one-shot path is a statement about a MEASUREMENT: that floor
 * comes from the pre-roll and nothing else, and a pre-roll reading that high is
 * likelier to be a bad measurement than a genuinely loud room, so it is refused
 * and the old behaviour stands.
 *
 * The rolling path is not one reading. It is re-derived every frame and held
 * under {@link VOICE_INPUT_SPEECH_FLOOR_RATIO} of the speech heard alongside it,
 * so the danger the 8x cap approximates, a floor set over the speaker, is
 * checked directly instead. Applying 8x here would break the case this path
 * exists for: automatic gain control moves ambient AND speech up together, so a
 * ceiling fixed at 1440 pins the floor under a raised noise floor while the
 * speaker sits far above both. 32x remains only as a bound on runaway input.
 */
export const VOICE_INPUT_ROLLING_FLOOR_MAX = VOICE_INPUT_SILENCE_RMS * 32;

/**
 * Default `voice.wake.speechRetriggerMs`: how long a run of loud frames must
 * last before it counts as speech resuming.
 *
 * 150 ms is under the shortest syllable anyone ends a sentence on and over the
 * longest breath, lip tick or chair creak a close-worn microphone picks up.
 * Below it, a run counts toward silence rather than resetting it; at or above
 * it, the speaker is talking again and the trailing-silence count starts over.
 * 0 restores the pre-existing rule where every loud frame resets.
 */
export const VOICE_INPUT_SPEECH_RETRIGGER_MS = 150;

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
 * Whether `voice.wake.silenceFloorRms` names a level, as opposed to being unset
 * or 0. The single predicate behind BOTH consequences of setting that row: the
 * value wins over the measurement, and the floor is then frozen for the whole
 * utterance rather than following the room. A pinned value is pinned.
 */
export function isSilenceFloorPinned(override: number | undefined): override is number {
  return typeof override === 'number' && Number.isFinite(override) && override > 0;
}

/**
 * Decide the silence floor for one utterance. The single place the rule lives.
 *
 * In order:
 *  1. An explicit `voice.wake.silenceFloorRms` above 0 wins outright, someone
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
  if (isSilenceFloorPinned(override)) return override;
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
  /** The surface asked it to stop, a released key, an explicit cancel. */
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
   *
   * This is the STARTING floor. Unless {@link silenceFloorPinned} says
   * otherwise the recorder may raise it during the capture, and never lowers it
   * below this value.
   */
  readonly silenceRms?: number | undefined;
  /**
   * True when {@link silenceRms} came from an explicit
   * `voice.wake.silenceFloorRms`. Freezes the floor for the whole utterance: no
   * rolling adjustment at all. Callers derive it from the same row with
   * {@link isSilenceFloorPinned} rather than deciding it separately.
   */
  readonly silenceFloorPinned?: boolean | undefined;
  /**
   * How long a run of loud frames must last to count as speech, from
   * `voice.wake.speechRetriggerMs`. Defaults to
   * {@link VOICE_INPUT_SPEECH_RETRIGGER_MS}; 0 restores the rule where every
   * loud frame arms the capture and resets trailing silence.
   */
  readonly speechRetriggerMs?: number | undefined;
}

/**
 * What the endpointing actually did, in the numbers it decided from.
 *
 * Every one of these is a question that was unanswerable after a capture that
 * behaved wrongly: the room was loud, or it was not; the floor moved, or it was
 * pinned; the capture ended on silence, or it never found any. A stop reason
 * alone says which branch ran, not why it was the one that ran.
 */
export interface VoiceInputEndpointing {
  /** The floor the utterance started with, before any rolling adjustment. */
  readonly initialFloorRms: number;
  /** The floor in force on the last frame. Equal to the initial one when pinned. */
  readonly finalFloorRms: number;
  /**
   * The rolling ambient estimate at the stop, the windowed minimum of recent
   * frame levels. Null when no frame was ever pushed.
   */
  readonly ambientRms: number | null;
  /** The tracked speech level at the stop, which is what bounded the floor. */
  readonly speechLevelRms: number;
  /** True when `voice.wake.silenceFloorRms` froze the floor. */
  readonly floorPinned: boolean;
  readonly stopReason: VoiceInputStopReason;
  readonly durationMs: number;
  /** Trailing silence accumulated at the stop, absorbed short bursts included. */
  readonly trailingSilenceMs: number;
  /** Loud runs shorter than the retrigger that were counted as silence. */
  readonly absorbedBurstCount: number;
  /** The retrigger length in force, in milliseconds. */
  readonly speechRetriggerMs: number;
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
  /** What the endpointing decided from, for the capture-end receipt. */
  readonly endpointing: VoiceInputEndpointing;
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
   * is 0 samples and `samples >= 0` is true on the very first frame, a literal
   * reading of "no ceiling" that would end every utterance immediately. Infinity
   * is the honest spelling of no ceiling and compares correctly forever; the
   * count itself is a double, so a capture long enough to lose precision would
   * have to run for centuries.
   */
  readonly #maxSamples: number;
  /** Floor frozen for the whole utterance, because someone set the row. */
  readonly #floorPinned: boolean;
  /** A loud run this long or longer is speech resuming, in samples. */
  readonly #retriggerSamples: number;
  readonly #rollingWindowSamples: number;
  readonly #chunks: Float32Array[] = [];
  /**
   * Sliding-window minimum of frame level, as a deque of (level, end position)
   * kept monotonically increasing: the front is the minimum over the window.
   *
   * Bounded by the window in frames, nineteen at the detector's 80 ms, about
   * seventy-five at 20 ms, so the operations at both ends are on a handful of
   * elements and the spelling that reads clearly is also the cheap one.
   */
  readonly #ambientWindow: Array<{ rms: number; endedAt: number }> = [];
  #samples = 0;
  #preRollSamples = 0;
  #trailingSilenceSamples = 0;
  /** Consecutive loud samples so far, reset by the first silent frame after them. */
  #loudRunSamples = 0;
  /** Loud runs shorter than the retrigger that were counted toward silence. */
  #absorbedBursts = 0;
  /** Running maximum of frame level, decayed. Bounds how high the floor may go. */
  #speechLevel = 0;
  #effectiveSilenceRms: number;
  #heardSpeech = false;
  #finished = false;

  constructor(policy: VoiceInputPolicy) {
    this.#policy = policy;
    this.#sampleRate = policy.sampleRate ?? CAPTURE_SAMPLE_RATE;
    this.#silenceRms = policy.silenceRms ?? VOICE_INPUT_SILENCE_RMS;
    this.#effectiveSilenceRms = this.#silenceRms;
    this.#floorPinned = policy.silenceFloorPinned === true;
    const retriggerMs = policy.speechRetriggerMs ?? VOICE_INPUT_SPEECH_RETRIGGER_MS;
    this.#retriggerSamples = Math.max(0, Math.round((retriggerMs / 1000) * this.#sampleRate));
    this.#rollingWindowSamples = Math.round((VOICE_INPUT_ROLLING_WINDOW_MS / 1000) * this.#sampleRate);
    this.#maxSamples = policy.captureMaxSeconds > 0
      ? policy.captureMaxSeconds * this.#sampleRate
      : Number.POSITIVE_INFINITY;
  }

  /** Milliseconds of audio held so far, pre-roll included. */
  get durationMs(): number {
    return (this.#samples / this.#sampleRate) * 1000;
  }

  /**
   * True once a run of loud frames at least `speechRetriggerMs` long has been
   * seen. Room ticks before the speaker starts must NOT arm this: arming is what
   * makes silence-stop live, and a capture armed by a chair creak ends
   * `silenceStopMs` later with nothing in it.
   */
  get heardSpeech(): boolean {
    return this.#heardSpeech;
  }

  /** The floor in force right now, after any rolling adjustment. */
  get effectiveSilenceRms(): number {
    return this.#effectiveSilenceRms;
  }

  /** Trailing silence accumulated so far, absorbed short bursts included. */
  get trailingSilenceMs(): number {
    return (this.#trailingSilenceSamples / this.#sampleRate) * 1000;
  }

  /** What the endpointing has decided from so far. Safe to read at any point. */
  get endpointing(): Omit<VoiceInputEndpointing, 'stopReason'> {
    return {
      initialFloorRms: this.#silenceRms,
      finalFloorRms: this.#effectiveSilenceRms,
      ambientRms: this.#ambientWindow[0]?.rms ?? null,
      speechLevelRms: this.#speechLevel,
      floorPinned: this.#floorPinned,
      durationMs: this.durationMs,
      trailingSilenceMs: this.trailingSilenceMs,
      absorbedBurstCount: this.#absorbedBursts,
      speechRetriggerMs: (this.#retriggerSamples / this.#sampleRate) * 1000,
    };
  }

  /**
   * Seed the utterance with audio from before it started, the wake detection's
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
   * capturing. The frame is always kept first, a frame that trips the ceiling is
   * part of the utterance, not discarded with it.
   */
  push(frame: Float32Array): VoiceInputStopReason | null {
    if (this.#finished) return null;
    this.#chunks.push(frame.slice());
    this.#samples += frame.length;
    const rms = frameRms(frame);
    // Both estimates take EVERY frame, including the loud ones. The ambient one
    // is a minimum, which speech cannot pull upward; the speech one is a maximum,
    // which the room cannot pull downward. Each is blind to the other's audio by
    // construction rather than by a classification that could be wrong.
    this.#trackAmbient(rms);
    this.#trackSpeechLevel(rms, frame.length);
    this.#effectiveSilenceRms = this.#resolveEffectiveFloor();
    if (rms > this.#effectiveSilenceRms) this.#onLoudFrame(frame.length);
    else this.#onSilentFrame(frame.length);
    if (this.#samples >= this.#maxSamples) return 'max-duration';
    if (this.#policy.silenceStopMs > 0 && this.#heardSpeech) {
      if (this.trailingSilenceMs >= this.#policy.silenceStopMs) return 'silence';
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
      endpointing: { ...this.endpointing, stopReason },
    };
  }

  /**
   * Fold one frame into the windowed minimum.
   *
   * A frame at or above one already in the deque can never be the minimum while
   * that one is still in the window, so it displaces them from the back on the
   * way in. The window is then trimmed from the front by AGE, and the last entry
   * is never trimmed: there is always an estimate once a frame has arrived.
   */
  #trackAmbient(rms: number): void {
    const window = this.#ambientWindow;
    while (window.length > 0 && (window[window.length - 1]?.rms ?? 0) >= rms) window.pop();
    window.push({ rms, endedAt: this.#samples });
    const cutoff = this.#samples - this.#rollingWindowSamples;
    while (window.length > 1 && (window[0]?.endedAt ?? 0) <= cutoff) window.shift();
  }

  /** Running maximum with a half-life, per {@link VOICE_INPUT_SPEECH_LEVEL_HALF_LIFE_MS}. */
  #trackSpeechLevel(rms: number, frameSamples: number): void {
    const elapsedMs = (frameSamples / this.#sampleRate) * 1000;
    const decay = 0.5 ** (elapsedMs / VOICE_INPUT_SPEECH_LEVEL_HALF_LIFE_MS);
    this.#speechLevel = Math.max(rms, this.#speechLevel * decay);
  }

  /**
   * The floor for this frame.
   *
   * Raised toward the room by the same margin the one-shot measurement uses, and
   * held under three bounds: the speech level, so it can never rise over the
   * speaker; {@link VOICE_INPUT_ROLLING_FLOOR_MAX}, so runaway input cannot walk
   * it anywhere; and the starting floor as a LOWER bound, so the rolling path can
   * only ever raise, never lower, lowering is what clips sentences, and nothing
   * measured mid-capture is worth that risk.
   */
  #resolveEffectiveFloor(): number {
    if (this.#floorPinned) return this.#silenceRms;
    const ambient = this.#ambientWindow[0];
    if (ambient === undefined) return this.#silenceRms;
    const speechCap = this.#speechLevel > 0
      ? this.#speechLevel / VOICE_INPUT_SPEECH_FLOOR_RATIO
      : Number.POSITIVE_INFINITY;
    const raised = Math.min(
      ambient.rms * VOICE_INPUT_ADAPTIVE_MARGIN,
      speechCap,
      VOICE_INPUT_ROLLING_FLOOR_MAX,
    );
    return Math.max(this.#silenceRms, raised);
  }

  /**
   * A frame above the floor. Only a run at least `speechRetriggerMs` long counts
   * as speech; while a shorter run is in progress the trailing silence is PAUSED
   * at what it had reached, not reset, the run may yet turn out to be a tick.
   */
  #onLoudFrame(frameSamples: number): void {
    this.#loudRunSamples += frameSamples;
    if (this.#loudRunSamples < this.#retriggerSamples) return;
    this.#heardSpeech = true;
    this.#trailingSilenceSamples = 0;
  }

  /**
   * A frame at or below the floor. It also ENDS any loud run in progress, and a
   * run that ended short of the retrigger was a breath or a tick: its duration is
   * added to the silence it interrupted, so a tick every half second no longer
   * holds the microphone open forever.
   */
  #onSilentFrame(frameSamples: number): void {
    if (this.#loudRunSamples > 0 && this.#loudRunSamples < this.#retriggerSamples) {
      this.#trailingSilenceSamples += this.#loudRunSamples;
      this.#absorbedBursts += 1;
    }
    this.#loudRunSamples = 0;
    this.#trailingSilenceSamples += frameSamples;
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
