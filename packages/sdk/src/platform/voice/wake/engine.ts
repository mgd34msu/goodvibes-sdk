/**
 * engine.ts — the wake-word detector, front end plus classifiers plus rules.
 *
 * Feeds audio through the shared front end once per frame and every configured
 * classifier over the resulting features, then hands each model's score to its
 * own {@link WakeDetector}. Running N models costs N small classifier
 * inferences per frame and exactly ONE melspectrogram and ONE embedding pass —
 * the expensive stages are shared, which is why a second wake word is cheap.
 *
 * MEASURED COST. The pipeline budget is ~3.53 ms per 80 ms frame on the
 * reference machine, i.e. about 4% of real time, with the embedding backbone
 * dominating and the in-code melspectrogram in the microseconds. The loop
 * therefore has to beat real time by more than an order of magnitude before it
 * is at risk, which is the headroom that makes a WASM backend the right choice
 * in both a daemon child process and a browser tab.
 *
 * No audio capture, no timers, no I/O: the host pushes frames in and gets
 * detections out, so the same engine object serves a recorder subprocess and a
 * `getUserMedia` stream.
 *
 * THE WARNING SINK IS INJECTED FOR THE SAME REASON THE SESSION IS
 *
 * This file used to import the platform logger, which writes files and therefore
 * imports `node:fs` — enough to make the whole engine unbundleable for the browser
 * tab it claims to run in. So a host passes {@link WakeEngineOptions.warn} in
 * alongside the inference session it already supplies. A host that passes none
 * gets no warnings, which is why every shipped host passes one.
 */
import { summarizeError } from '../../utils/error-display.js';
import { WakeDetector, WAKE_DETECTOR_DEFAULTS, type WakeFrameOutcome } from './detector.js';
import {
  WakeFeaturePipeline,
  WAKE_CHUNK_SAMPLES,
  WAKE_CLASSIFIER_FRAMES,
  WAKE_EMBED_DIM,
} from './feature-pipeline.js';
import type {
  WakeDetection,
  WakeDetectorTuning,
  WakeInferenceSession,
  WakeModelHandle,
} from './types.js';

/**
 * The speech gate `voice.wake.vadThreshold` turns on.
 *
 * The head runs over the SAME embedding the classifiers consume, so gating costs
 * one tiny inference per frame and no extra front-end pass. A host supplies the
 * session exactly as it supplies the classifiers'.
 */
export interface WakeVadGate {
  readonly session: WakeInferenceSession;
  /**
   * Speech probability a frame must reach to be scored, from
   * `voice.wake.vadThreshold`. See `WAKE_VAD_MODEL.thresholds` for what a value
   * does; `recommendedThreshold` is the measured operating point.
   */
  readonly threshold: number;
}

/** What the speech gate did with one frame. */
export interface WakeVadOutcome {
  /** Speech probability for this frame, or null when the gate could not run. */
  readonly probability: number | null;
  /** True when the frame was withheld from the classifiers. */
  readonly gated: boolean;
  /**
   * True when the gate itself failed on this frame. The frame is then passed
   * THROUGH to the classifiers and the failure is reported: a gate that cannot
   * run must not turn the wake word off, because gating everything is
   * indistinguishable to a user from a microphone that stopped working.
   */
  readonly failed: boolean;
}

export interface WakeEngineOptions {
  /** The speech-embedding backbone, shared by every model. */
  readonly embedding: WakeInferenceSession;
  /** Classifiers to run. An empty list means the engine scores nothing. */
  readonly models: readonly WakeModelHandle[];
  /**
   * The speech gate. Omitted means every frame reaches the classifiers, which is
   * what `voice.wake.vadThreshold: 0` — the shipped default — asks for.
   */
  readonly vad?: WakeVadGate | undefined;
  /** Detector tuning; per-model thresholds still win. */
  readonly tuning?: Partial<WakeDetectorTuning> | undefined;
  /** Milliseconds of audio a detection carries from before it fired. */
  readonly preRollMs?: number | undefined;
  /** Injected clock, so cooldown behaviour is deterministic under test. */
  readonly now?: (() => number) | undefined;
  /** Samples per frame. Defaults to 1280 (80 ms at 16 kHz). */
  readonly chunkSamples?: number | undefined;
  /**
   * Where a model that misbehaves is reported. A classifier that fails to run is
   * skipped rather than taking the detector down, and this is the only trace of
   * that decision, so a host that wants to know supplies a sink.
   */
  readonly warn?: ((message: string, meta?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** Everything one frame produced. */
export interface WakeFrameResult {
  /** Per-model score for this frame; empty until the pipeline has filled. */
  readonly scores: ReadonlyMap<string, number>;
  /** Per-model outcome after patience and cooldown were applied. */
  readonly outcomes: ReadonlyMap<string, WakeFrameOutcome>;
  /** Models that confirmed a wake on this frame, in configuration order. */
  readonly detections: readonly WakeDetection[];
  /**
   * What the speech gate did, or null when no gate is running. A gated frame has
   * empty scores and outcomes — it was never handed to a classifier.
   */
  readonly vad: WakeVadOutcome | null;
}

const EMPTY_RESULT: WakeFrameResult = {
  scores: new Map(),
  outcomes: new Map(),
  detections: [],
  vad: null,
};

/** Frame-driven wake-word detector over a shared front end. */
export class WakeWordEngine {
  readonly #pipeline: WakeFeaturePipeline;
  readonly #models: readonly WakeModelHandle[];
  readonly #detectors: Map<string, WakeDetector>;
  readonly #vad: WakeVadGate | null;
  readonly #preRollMs: number;
  readonly #now: () => number;
  readonly #warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  #framesSeen = 0;

  constructor(options: WakeEngineOptions) {
    this.#pipeline = new WakeFeaturePipeline({
      embedding: options.embedding,
      chunkSamples: options.chunkSamples ?? WAKE_CHUNK_SAMPLES,
    });
    this.#models = [...options.models];
    // A gate configured at 0 is no gate: the row's own description says 0 means
    // the stage is off, so it must not cost an inference per frame either.
    this.#vad = options.vad !== undefined && options.vad.threshold > 0 ? options.vad : null;
    this.#preRollMs = options.preRollMs ?? 500;
    this.#now = options.now ?? (() => Date.now());
    this.#warn = options.warn ?? ((): void => {});
    this.#detectors = new Map();
    for (const model of this.#models) {
      // A per-model threshold wins over the engine tuning, so a custom model
      // can be run at its own operating point beside the pinned one.
      const tuning: Partial<WakeDetectorTuning> = {
        ...options.tuning,
        ...(model.threshold !== undefined ? { threshold: model.threshold } : {}),
      };
      this.#detectors.set(model.id, new WakeDetector(tuning));
    }
  }

  /** Samples the engine expects per {@link pushFrame} call. */
  get chunkSamples(): number {
    return this.#pipeline.chunkSamples;
  }

  /** Ids of the models being scored, in configuration order. */
  get modelIds(): readonly string[] {
    return this.#models.map((model) => model.id);
  }

  /** Frames pushed since the last reset. */
  get framesSeen(): number {
    return this.#framesSeen;
  }

  /**
   * Clear every buffer and every detector run. Called when the stream restarts:
   * a restarted detector must not inherit half a phrase, nor a cooldown, from
   * the run that died.
   */
  reset(): void {
    this.#pipeline.reset();
    for (const detector of this.#detectors.values()) detector.reset();
    this.#framesSeen = 0;
  }

  /**
   * Score one frame of 16 kHz mono audio (raw int16 magnitudes as floats).
   *
   * Returns empty results while the front end is still filling its 16-frame
   * feature window — about 1.3 seconds of audio — rather than emitting scores
   * computed against openWakeWord's synthetic buffer priming.
   */
  async pushFrame(samples: Float32Array): Promise<WakeFrameResult> {
    this.#framesSeen += 1;
    const features = await this.#pipeline.pushChunk(samples);
    if (features === null || this.#models.length === 0) return EMPTY_RESULT;
    const vad = this.#vad === null ? null : await this.#screen(features.data);
    if (vad !== null && vad.gated) {
      // A withheld frame breaks any run in progress — patience counts consecutive
      // SCORED frames, and a gap of non-speech is exactly what should end a run —
      // while cooldown is left alone, since no wake fired here.
      for (const detector of this.#detectors.values()) detector.breakRun();
      return { scores: new Map(), outcomes: new Map(), detections: [], vad };
    }
    const at = this.#now();
    const scores = new Map<string, number>();
    const outcomes = new Map<string, WakeFrameOutcome>();
    const detections: WakeDetection[] = [];
    for (const model of this.#models) {
      const score = await this.#score(model, features.data);
      if (score === null) continue;
      scores.set(model.id, score);
      const detector = this.#detectors.get(model.id);
      if (detector === undefined) continue;
      const outcome = detector.push(score, at);
      outcomes.set(model.id, outcome);
      if (outcome.kind !== 'fired') continue;
      detections.push({
        modelId: model.id,
        score: outcome.score,
        peakScore: outcome.peakScore,
        frames: outcome.frames,
        at,
        preRoll: this.#preRollMs > 0 ? this.#pipeline.recentAudio(this.#preRollMs) : new Float32Array(0),
      });
    }
    return { scores, outcomes, detections, vad };
  }

  /**
   * Run the speech gate over the newest embedding frame.
   *
   * The newest frame is the LAST 96 values of the classifier window — the window
   * is 16 frames of 96 in time order — so the gate reads what the front end just
   * produced rather than re-running anything.
   *
   * A gate that fails passes the frame through and says so. The alternative,
   * gating on failure, silently turns the wake word off.
   */
  async #screen(features: Float32Array): Promise<WakeVadOutcome> {
    const gate = this.#vad;
    if (gate === null) return { probability: null, gated: false, failed: false };
    const inputName = gate.session.inputNames[0];
    const outputName = gate.session.outputNames[0];
    if (inputName === undefined || outputName === undefined) {
      this.#warn('the speech gate exposes no input/output; frames are not being screened');
      return { probability: null, gated: false, failed: true };
    }
    const newest = features.subarray(features.length - WAKE_EMBED_DIM);
    try {
      const outputs = await gate.session.run({
        [inputName]: { data: newest, dims: [1, WAKE_EMBED_DIM] },
      });
      const value = outputs[outputName]?.data[0];
      if (value === undefined || !Number.isFinite(value)) {
        this.#warn('the speech gate produced no finite probability; frames are not being screened');
        return { probability: null, gated: false, failed: true };
      }
      return { probability: value, gated: value < gate.threshold, failed: false };
    } catch (error) {
      this.#warn('the speech gate failed to run; frames are not being screened', {
        error: summarizeError(error),
      });
      return { probability: null, gated: false, failed: true };
    }
  }

  /**
   * Run one classifier. A model that fails to run is logged and skipped rather
   * than taking the whole detector down — one bad custom model must not stop
   * the pinned one from working.
   */
  async #score(model: WakeModelHandle, features: Float32Array): Promise<number | null> {
    const inputName = model.session.inputNames[0];
    const outputName = model.session.outputNames[0];
    if (inputName === undefined || outputName === undefined) {
      this.#warn('wake model exposes no input/output', { modelId: model.id });
      return null;
    }
    try {
      const outputs = await model.session.run({
        [inputName]: {
          data: features,
          dims: [1, WAKE_CLASSIFIER_FRAMES, WAKE_EMBED_DIM],
        },
      });
      const value = outputs[outputName]?.data[0];
      if (value === undefined || !Number.isFinite(value)) {
        this.#warn('wake model produced no finite score', { modelId: model.id });
        return null;
      }
      return value;
    } catch (error) {
      this.#warn('wake model inference failed', { modelId: model.id, error: summarizeError(error) });
      return null;
    }
  }
}

export { WAKE_DETECTOR_DEFAULTS };
