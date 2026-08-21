/**
 * feature-pipeline.ts, audio in, classifier features out.
 *
 * The two stages ahead of the wake classifier, run as a stream:
 *
 *     16 kHz mono -> melspectrogram (in code, melspectrogram.ts)
 *                 -> speech-embedding backbone (one inference per 80 ms frame)
 *                 -> a rolling 16 x 96 feature window
 *
 * BUFFERING IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION CHOICE
 *
 * The published classifier was trained against openWakeWord's streaming
 * buffers, so this reproduces them exactly rather than doing the equivalent-
 * looking thing:
 *
 *  - Each 1280-sample (80 ms) chunk is turned into mel frames by running the
 *    front end over the trailing `chunk + 480` samples, not over the chunk
 *    alone. 480 = 3 hops of context; without it the framing produces 5 frames
 *    per chunk instead of 8 and the whole pipeline runs at 62.5 fps against a
 *    model trained at 100 fps.
 *  - The mel buffer starts as ones((76, 32)), not zeros. That priming is
 *    visible in the first ~16 frames of output, which is why callers discard
 *    them when measuring.
 *  - The mel values are rescaled `x / 10 + 2` before the embedding model, which
 *    is the transform openWakeWord applies to match the original TensorFlow
 *    `speech_embedding` front end.
 *
 * The engine keeps a raw-audio tail as well, so a detection can hand back
 * pre-roll audio from before it fired.
 */
import {
  applyEmbeddingScaling,
  melFrameCount,
  melFrames,
  createMelScratch,
  WAKE_MEL_BINS,
  WAKE_MEL_HOP,
  WAKE_SAMPLE_RATE,
  type MelScratch,
} from './melspectrogram.js';
import type { WakeInferenceSession, WakeTensor } from './types.js';

/** Samples per detector frame: 80 ms at 16 kHz. */
export const WAKE_CHUNK_SAMPLES = 1280;
/** Milliseconds of audio per detector frame. */
export const WAKE_CHUNK_MS = (WAKE_CHUNK_SAMPLES / WAKE_SAMPLE_RATE) * 1000;
/** Mel frames the embedding backbone consumes per inference. */
export const WAKE_EMBED_WINDOW_FRAMES = 76;
/** Dimensions the embedding backbone emits per inference. */
export const WAKE_EMBED_DIM = 96;
/** Embedding frames the classifier consumes. */
export const WAKE_CLASSIFIER_FRAMES = 16;
/**
 * Extra trailing samples handed to the front end with each chunk, so framing
 * yields exactly `chunk / hop` new mel frames. Three hops.
 */
export const WAKE_MEL_CONTEXT_SAMPLES = WAKE_MEL_HOP * 3;
/** Upper bound on retained mel frames, matching openWakeWord's 10 * 97. */
const MEL_BUFFER_MAX_FRAMES = 970;
/** Upper bound on retained embedding frames. */
const FEATURE_BUFFER_MAX_FRAMES = 120;

/** How much raw audio the pipeline keeps for pre-roll, in seconds. */
export const WAKE_RAW_TAIL_SECONDS = 4;

export interface FeaturePipelineOptions {
  /** The speech-embedding backbone session. */
  readonly embedding: WakeInferenceSession;
  /** Chunk size in samples. Must be a whole number of 160-sample hops. */
  readonly chunkSamples?: number | undefined;
}

/**
 * Streaming front end. One instance per audio stream; not safe to share across
 * concurrent streams because every buffer in it is stateful.
 */
export class WakeFeaturePipeline {
  readonly #embedding: WakeInferenceSession;
  readonly #chunkSamples: number;
  readonly #melPerChunk: number;
  readonly #scratch: MelScratch;
  readonly #rawTail: Float32Array;
  #rawFilled = 0;
  #melBuffer: Float32Array;
  #melFrameCount: number;
  #features: Float32Array;
  #featureFrames = 0;

  constructor(options: FeaturePipelineOptions) {
    this.#embedding = options.embedding;
    this.#chunkSamples = options.chunkSamples ?? WAKE_CHUNK_SAMPLES;
    if (this.#chunkSamples % WAKE_MEL_HOP !== 0) {
      throw new Error(
        `[wake] chunkSamples must be a multiple of the ${WAKE_MEL_HOP}-sample hop, got ${this.#chunkSamples}`,
      );
    }
    this.#melPerChunk = this.#chunkSamples / WAKE_MEL_HOP;
    this.#scratch = createMelScratch();
    this.#rawTail = new Float32Array(WAKE_SAMPLE_RATE * WAKE_RAW_TAIL_SECONDS);
    this.#melBuffer = new Float32Array(MEL_BUFFER_MAX_FRAMES * WAKE_MEL_BINS);
    this.#melFrameCount = 0;
    this.#features = new Float32Array(FEATURE_BUFFER_MAX_FRAMES * WAKE_EMBED_DIM);
    this.reset();
  }

  /** Samples this pipeline expects per {@link pushChunk} call. */
  get chunkSamples(): number {
    return this.#chunkSamples;
  }

  /** True once enough frames have accumulated to produce classifier features. */
  get ready(): boolean {
    return this.#featureFrames >= WAKE_CLASSIFIER_FRAMES;
  }

  /**
   * Return to the cold-start state: mel buffer primed with ones, no features,
   * no raw tail. Called on construction and whenever a stream restarts, so a
   * restarted detector cannot inherit half a phrase from before the crash.
   */
  reset(): void {
    this.#rawFilled = 0;
    this.#rawTail.fill(0);
    this.#melBuffer.fill(0);
    this.#melBuffer.fill(1, 0, WAKE_EMBED_WINDOW_FRAMES * WAKE_MEL_BINS);
    this.#melFrameCount = WAKE_EMBED_WINDOW_FRAMES;
    this.#features.fill(0);
    this.#featureFrames = 0;
  }

  /**
   * Feed exactly {@link chunkSamples} samples of 16 kHz mono audio, as raw int16
   * magnitudes expressed as floats (NOT normalised to [-1, 1], see
   * melspectrogram.ts).
   *
   * Returns the trailing 16 x 96 feature window as a flat tensor, or null while
   * the pipeline is still filling. Callers must not retain the returned tensor's
   * data across calls; it is reused.
   */
  async pushChunk(samples: Float32Array): Promise<WakeTensor | null> {
    if (samples.length !== this.#chunkSamples) {
      throw new Error(`[wake] expected ${this.#chunkSamples} samples per chunk, got ${samples.length}`);
    }
    this.#appendRaw(samples);
    this.#appendMel();
    await this.#appendEmbedding();
    if (!this.ready) return null;
    const start = (this.#featureFrames - WAKE_CLASSIFIER_FRAMES) * WAKE_EMBED_DIM;
    return {
      data: this.#features.subarray(start, start + WAKE_CLASSIFIER_FRAMES * WAKE_EMBED_DIM),
      dims: [1, WAKE_CLASSIFIER_FRAMES, WAKE_EMBED_DIM],
    };
  }

  /**
   * The most recent `ms` milliseconds of raw audio, for a detection's pre-roll.
   * Returns whatever is available when less has been seen, never pads.
   */
  recentAudio(ms: number): Float32Array {
    const want = Math.min(
      Math.floor((ms / 1000) * WAKE_SAMPLE_RATE),
      this.#rawFilled,
      this.#rawTail.length,
    );
    if (want <= 0) return new Float32Array(0);
    return this.#rawTail.slice(this.#rawTail.length - want);
  }

  /** Shift `samples` into the fixed-size raw tail, dropping the oldest audio. */
  #appendRaw(samples: Float32Array): void {
    const tail = this.#rawTail;
    tail.copyWithin(0, samples.length);
    tail.set(samples, tail.length - samples.length);
    this.#rawFilled = Math.min(tail.length, this.#rawFilled + samples.length);
  }

  /**
   * Run the front end over the trailing `chunk + 480` samples and append the
   * resulting frames. When fewer than that have been seen the shorter tail is
   * used, which produces fewer frames, correct for the very start of a stream.
   */
  #appendMel(): void {
    const take = Math.min(this.#chunkSamples + WAKE_MEL_CONTEXT_SAMPLES, this.#rawFilled);
    const tail = this.#rawTail.subarray(this.#rawTail.length - take);
    if (melFrameCount(tail.length) === 0) return;
    const produced = applyEmbeddingScaling(melFrames(tail, this.#scratch));
    const newFrames = produced.length / WAKE_MEL_BINS;
    const keep = Math.min(newFrames, this.#melPerChunk);
    const source = produced.subarray(produced.length - keep * WAKE_MEL_BINS);
    if (this.#melFrameCount + keep > MEL_BUFFER_MAX_FRAMES) {
      const drop = this.#melFrameCount + keep - MEL_BUFFER_MAX_FRAMES;
      this.#melBuffer.copyWithin(0, drop * WAKE_MEL_BINS, this.#melFrameCount * WAKE_MEL_BINS);
      this.#melFrameCount -= drop;
    }
    this.#melBuffer.set(source, this.#melFrameCount * WAKE_MEL_BINS);
    this.#melFrameCount += keep;
  }

  /** Run the embedding backbone over the trailing 76 mel frames. */
  async #appendEmbedding(): Promise<void> {
    if (this.#melFrameCount < WAKE_EMBED_WINDOW_FRAMES) return;
    const start = (this.#melFrameCount - WAKE_EMBED_WINDOW_FRAMES) * WAKE_MEL_BINS;
    const window = this.#melBuffer.slice(start, start + WAKE_EMBED_WINDOW_FRAMES * WAKE_MEL_BINS);
    const inputName = this.#embedding.inputNames[0];
    if (inputName === undefined) throw new Error('[wake] embedding session exposes no inputs');
    const outputs = await this.#embedding.run({
      [inputName]: { data: window, dims: [1, WAKE_EMBED_WINDOW_FRAMES, WAKE_MEL_BINS, 1] },
    });
    const outputName = this.#embedding.outputNames[0];
    if (outputName === undefined) throw new Error('[wake] embedding session exposes no outputs');
    const produced = outputs[outputName];
    if (produced === undefined) throw new Error(`[wake] embedding session produced no "${outputName}" output`);
    if (produced.data.length < WAKE_EMBED_DIM) {
      throw new Error(`[wake] embedding produced ${produced.data.length} values, expected at least ${WAKE_EMBED_DIM}`);
    }
    if (this.#featureFrames >= FEATURE_BUFFER_MAX_FRAMES) {
      this.#features.copyWithin(0, WAKE_EMBED_DIM, this.#featureFrames * WAKE_EMBED_DIM);
      this.#featureFrames -= 1;
    }
    this.#features.set(
      produced.data.subarray(0, WAKE_EMBED_DIM),
      this.#featureFrames * WAKE_EMBED_DIM,
    );
    this.#featureFrames += 1;
  }
}
