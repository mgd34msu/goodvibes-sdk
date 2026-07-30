/**
 * detector.ts — turning a stream of per-frame scores into wake events.
 *
 * The classifier emits a score every 80 ms. Acting on each one directly is what
 * makes a wake word feel unreliable in both directions: a single noisy frame
 * fires it, and one spoken phrase fires it three times as it crosses the
 * rolling window. Two rules fix that, and this module is only those two rules
 * plus their bookkeeping:
 *
 *  - **patience** — a run of `patienceFrames` consecutive frames must all clear
 *    the threshold before the wake is confirmed. At the default of 2 that is
 *    about 160 ms of agreement for one extra frame of latency.
 *  - **cooldown** — after a confirmed wake, `cooldownMs` of further detections
 *    are dropped, so one utterance cannot fire twice.
 *
 * Kept separate from the engine and free of any I/O so the behaviour is
 * testable by feeding it score sequences, with time injected rather than read.
 */
import type { WakeDetectorTuning } from './types.js';

/** What a frame did to the detector. */
export type WakeFrameOutcome =
  /** Below threshold; any run in progress was broken. */
  | { readonly kind: 'idle' }
  /** Above threshold, but the run has not yet reached `patienceFrames`. */
  | { readonly kind: 'building'; readonly frames: number; readonly needed: number }
  /** Above threshold and confirmed. */
  | { readonly kind: 'fired'; readonly frames: number; readonly score: number; readonly peakScore: number }
  /** Above threshold but suppressed because a wake fired recently. */
  | { readonly kind: 'cooldown'; readonly remainingMs: number };

/** Defaults matching the shipped `voice.wake.*` rows. */
export const WAKE_DETECTOR_DEFAULTS: WakeDetectorTuning = {
  threshold: 0.9,
  patienceFrames: 2,
  cooldownMs: 2000,
};

/**
 * Per-model patience/cooldown state machine.
 *
 * One instance per model — two models running concurrently have independent
 * runs and independent cooldowns, so a wake on one does not mask the other.
 */
export class WakeDetector {
  readonly #tuning: WakeDetectorTuning;
  #runFrames = 0;
  #runPeak = 0;
  #cooldownUntil = 0;

  constructor(tuning: Partial<WakeDetectorTuning> = {}) {
    const merged: WakeDetectorTuning = { ...WAKE_DETECTOR_DEFAULTS, ...tuning };
    if (merged.patienceFrames < 1) {
      throw new Error(`[wake] patienceFrames must be at least 1, got ${merged.patienceFrames}`);
    }
    if (merged.threshold < 0 || merged.threshold > 1) {
      throw new Error(`[wake] threshold must be within [0, 1], got ${merged.threshold}`);
    }
    this.#tuning = merged;
  }

  /** The tuning in force, after defaults were merged in. */
  get tuning(): WakeDetectorTuning {
    return this.#tuning;
  }

  /** Milliseconds of cooldown left at `now`, or 0 when not in cooldown. */
  cooldownRemaining(now: number): number {
    return Math.max(0, this.#cooldownUntil - now);
  }

  /**
   * Clear all state. Used when the stream restarts, so a run that was building
   * when a process died does not resume against unrelated audio.
   */
  reset(): void {
    this.#runFrames = 0;
    this.#runPeak = 0;
    this.#cooldownUntil = 0;
  }

  /**
   * End any run in progress without scoring a frame, leaving the cooldown alone.
   *
   * What the speech gate calls when it withholds a frame: patience counts
   * CONSECUTIVE scored frames, so a gap of screened-out non-speech must break a
   * run rather than let it resume across the gap. Distinct from
   * {@link WakeDetector.reset}, which also clears the cooldown and would let one
   * utterance fire twice.
   */
  breakRun(): void {
    this.#runFrames = 0;
    this.#runPeak = 0;
  }

  /**
   * Offer one frame's score. `now` is injected rather than read from the clock
   * so cooldown behaviour is deterministic under test.
   */
  push(score: number, now: number): WakeFrameOutcome {
    if (score < this.#tuning.threshold) {
      this.#runFrames = 0;
      this.#runPeak = 0;
      return { kind: 'idle' };
    }
    const remaining = this.cooldownRemaining(now);
    if (remaining > 0) {
      // Suppressed, and the run is discarded: when the cooldown lapses the
      // phrase must be spoken again rather than completing a stale run.
      this.#runFrames = 0;
      this.#runPeak = 0;
      return { kind: 'cooldown', remainingMs: remaining };
    }
    this.#runFrames += 1;
    this.#runPeak = Math.max(this.#runPeak, score);
    if (this.#runFrames < this.#tuning.patienceFrames) {
      return { kind: 'building', frames: this.#runFrames, needed: this.#tuning.patienceFrames };
    }
    const outcome: WakeFrameOutcome = {
      kind: 'fired',
      frames: this.#runFrames,
      score,
      peakScore: this.#runPeak,
    };
    this.#runFrames = 0;
    this.#runPeak = 0;
    this.#cooldownUntil = now + this.#tuning.cooldownMs;
    return outcome;
  }
}
