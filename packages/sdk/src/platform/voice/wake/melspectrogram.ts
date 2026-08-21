/**
 * melspectrogram.ts, the wake-word front end's first stage, computed in code.
 *
 * The pipeline behind the pinned classifier is
 *
 *     audio -> melspectrogram -> speech-embedding backbone -> classifier
 *
 * and openWakeWord distributes the melspectrogram stage as a downloadable model
 * file. It does not need to be one: the stage is a fixed DSP graph, a short-time
 * Fourier transform, a mel filterbank, and a decibel conversion, with **no
 * learned parameters at all**. Computing it here removes a runtime download, a
 * checksum to manage, and an inference session from the hot loop.
 *
 * WHY THESE EXACT CONSTANTS
 *
 * The classifier was trained against openWakeWord's front end. If this stage
 * drifts, every measured recall and false-accept number in
 * `docs/wake-word-model.md` silently stops describing the running detector. So
 * the constants below were not chosen, and were not taken from any library's
 * defaults or from any reference implementation's prose: they were **recovered
 * numerically from openWakeWord's own `melspectrogram.onnx` weights**, which is
 * a `torchlibrosa` export whose graph is
 *
 *     Conv(real basis) / Conv(imag basis) -> real^2 + imag^2 -> MatMul(melW)
 *       -> clip(1e-10, inf) -> log -> *10 -> /ln(10) -> -0
 *       -> clip(min = globalMax - 80)
 *
 * Fitting each stage against those initializers gives, to float32 precision:
 *
 *   - window        periodic Hann of length 400, zero-padded and CENTRED in the
 *                   512-point frame (56 zeros each side). Recovered by reading
 *                   row k=0 of `0.stft.conv_real.weight`, which is the window
 *                   itself because cos(0) = 1. Max abs deviation 2.8e-8.
 *   - Fourier basis conv_real[k][n] = w[n]*cos(2*pi*k*n/512),
 *                   conv_imag[k][n] = -w[n]*sin(2*pi*k*n/512), not time-reversed.
 *                   Max abs deviation 5.6e-8 over all 257x512 taps.
 *   - hop           160 samples, from the Conv `strides` attribute.
 *   - padding       none. The Conv carries `pads=[0,0]`, so this is
 *                   `center=False` framing, NOT librosa's centred default.
 *   - filterbank    32 mel bands, Slaney mel scale, Slaney area normalisation,
 *                   fmin 60 Hz, fmax 3800 Hz. Max abs deviation from the pinned
 *                   `1.melW` matrix 8.1e-10 against a peak weight of 1.4e-2.
 *   - decibels      power (not magnitude) spectrogram, amin 1e-10, ref 1.0,
 *                   top_db 80, and the top_db floor uses the maximum over the
 *                   WHOLE call's output, reproduced in {@link melFrames}.
 *
 * Those deviations are the parity evidence for the DSP constants themselves;
 * end-to-end score parity against the real front end is asserted by
 * `test/wake-word-front-end-parity.test.ts` against committed reference frames.
 *
 * Everything here is plain arithmetic on typed arrays, so it runs unchanged in
 * a daemon child process and in a browser.
 */

/** Sample rate the whole wake pipeline assumes, in Hz. */
export const WAKE_SAMPLE_RATE = 16_000;
/** FFT size, in samples. */
export const WAKE_MEL_N_FFT = 512;
/** Hop between consecutive frames, in samples (10 ms at 16 kHz). */
export const WAKE_MEL_HOP = 160;
/** Non-zero window length, in samples (25 ms at 16 kHz). */
export const WAKE_MEL_WIN_LENGTH = 400;
/** Number of mel bands the embedding backbone expects. */
export const WAKE_MEL_BINS = 32;
/** Lowest mel filter edge, in Hz. */
export const WAKE_MEL_FMIN = 60;
/** Highest mel filter edge, in Hz. */
export const WAKE_MEL_FMAX = 3800;
/** Power floor before the log, matching librosa's `amin`. */
export const WAKE_MEL_AMIN = 1e-10;
/** Dynamic-range floor below the per-call peak, matching librosa's `top_db`. */
export const WAKE_MEL_TOP_DB = 80;
/** Number of one-sided FFT bins: 512/2 + 1. */
export const WAKE_MEL_FFT_BINS = WAKE_MEL_N_FFT / 2 + 1;

/**
 * Minimum samples needed to produce one frame. Framing is `center=False`, so a
 * frame needs a full window and nothing is padded.
 */
export const WAKE_MEL_MIN_SAMPLES = WAKE_MEL_N_FFT;

/**
 * How many frames {@link melFrames} produces for an input of `sampleCount`
 * samples. Zero when the input is shorter than one frame.
 */
export function melFrameCount(sampleCount: number): number {
  if (sampleCount < WAKE_MEL_N_FFT) return 0;
  return Math.floor((sampleCount - WAKE_MEL_N_FFT) / WAKE_MEL_HOP) + 1;
}

/**
 * Periodic Hann window of {@link WAKE_MEL_WIN_LENGTH} taps, zero-padded and
 * centred inside an {@link WAKE_MEL_N_FFT}-point frame.
 *
 * Periodic (divisor `L`), not symmetric (divisor `L-1`), the two differ by
 * 6.0e-3 here, which is 7 million times the residual against the pinned
 * weights, so the distinction is not cosmetic.
 */
function buildWindow(): Float64Array {
  const window = new Float64Array(WAKE_MEL_N_FFT);
  const pad = (WAKE_MEL_N_FFT - WAKE_MEL_WIN_LENGTH) >> 1;
  for (let n = 0; n < WAKE_MEL_WIN_LENGTH; n += 1) {
    window[pad + n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WAKE_MEL_WIN_LENGTH);
  }
  return window;
}

/** Slaney (auditory-toolbox) hertz-to-mel: linear below 1 kHz, log above. */
function hzToMel(hz: number): number {
  const linearStep = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / linearStep;
  const logStep = Math.log(6.4) / 27;
  if (hz < minLogHz) return hz / linearStep;
  return minLogMel + Math.log(hz / minLogHz) / logStep;
}

/** Inverse of {@link hzToMel}. */
function melToHz(mel: number): number {
  const linearStep = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / linearStep;
  const logStep = Math.log(6.4) / 27;
  if (mel < minLogMel) return linearStep * mel;
  return minLogHz * Math.exp(logStep * (mel - minLogMel));
}

/**
 * The 257x32 triangular mel filterbank, laid out row-major as
 * `[fftBin * WAKE_MEL_BINS + melBand]` so it multiplies the power spectrum on
 * the right exactly as the pinned graph's `MatMul` does.
 *
 * Slaney area normalisation (`* 2 / (right - left)`) is applied; without it
 * every weight is wrong by the width of its own triangle.
 */
function buildMelFilterbank(): Float64Array {
  const edges = new Float64Array(WAKE_MEL_BINS + 2);
  const minMel = hzToMel(WAKE_MEL_FMIN);
  const maxMel = hzToMel(WAKE_MEL_FMAX);
  for (let i = 0; i < edges.length; i += 1) {
    edges[i] = melToHz(minMel + ((maxMel - minMel) * i) / (WAKE_MEL_BINS + 1));
  }
  const bank = new Float64Array(WAKE_MEL_FFT_BINS * WAKE_MEL_BINS);
  for (let band = 0; band < WAKE_MEL_BINS; band += 1) {
    const left = edges[band] as number;
    const centre = edges[band + 1] as number;
    const right = edges[band + 2] as number;
    const area = 2 / (right - left);
    for (let bin = 0; bin < WAKE_MEL_FFT_BINS; bin += 1) {
      const hz = (WAKE_SAMPLE_RATE * bin) / WAKE_MEL_N_FFT;
      const rising = (hz - left) / (centre - left);
      const falling = (right - hz) / (right - centre);
      const weight = Math.max(0, Math.min(rising, falling));
      bank[bin * WAKE_MEL_BINS + band] = weight * area;
    }
  }
  return bank;
}

/** Bit-reversal permutation for an in-place radix-2 FFT of size `n`. */
function buildBitReversal(n: number): Uint16Array {
  const table = new Uint16Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i += 1) {
    let reversed = 0;
    for (let b = 0; b < bits; b += 1) reversed |= ((i >> b) & 1) << (bits - 1 - b);
    table[i] = reversed;
  }
  return table;
}

const WINDOW = buildWindow();
const MEL_BANK = buildMelFilterbank();
const BIT_REVERSAL = buildBitReversal(WAKE_MEL_N_FFT);
const TWIDDLE_COS = new Float64Array(WAKE_MEL_N_FFT / 2);
const TWIDDLE_SIN = new Float64Array(WAKE_MEL_N_FFT / 2);
for (let i = 0; i < WAKE_MEL_N_FFT / 2; i += 1) {
  TWIDDLE_COS[i] = Math.cos((-2 * Math.PI * i) / WAKE_MEL_N_FFT);
  TWIDDLE_SIN[i] = Math.sin((-2 * Math.PI * i) / WAKE_MEL_N_FFT);
}

/**
 * The pinned filterbank, exposed so a parity test can compare it against
 * openWakeWord's `1.melW` initializer directly rather than only end-to-end.
 * Row-major `[fftBin * 32 + melBand]`.
 */
export function melFilterbank(): Float64Array {
  return MEL_BANK.slice();
}

/**
 * The pinned analysis window, exposed for the same reason as
 * {@link melFilterbank}: it is checkable against row 0 of the reference graph's
 * real convolution weights.
 */
export function analysisWindow(): Float64Array {
  return WINDOW.slice();
}

/**
 * Scratch buffers for one melspectrogram call. Reused across calls so the
 * streaming loop allocates nothing per frame.
 */
interface MelScratch {
  readonly re: Float64Array;
  readonly im: Float64Array;
  readonly power: Float64Array;
}

function makeScratch(): MelScratch {
  return {
    re: new Float64Array(WAKE_MEL_N_FFT),
    im: new Float64Array(WAKE_MEL_N_FFT),
    power: new Float64Array(WAKE_MEL_FFT_BINS),
  };
}

const SHARED_SCRATCH = makeScratch();

/**
 * In-place iterative radix-2 Cooley-Tukey FFT over `re`/`im`, both of length
 * {@link WAKE_MEL_N_FFT}.
 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = WAKE_MEL_N_FFT;
  for (let i = 0; i < n; i += 1) {
    const j = BIT_REVERSAL[i] as number;
    if (j > i) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const twiddle = k * step;
        const wr = TWIDDLE_COS[twiddle] as number;
        const wi = TWIDDLE_SIN[twiddle] as number;
        const a = start + k;
        const b = a + half;
        const xr = re[b] as number;
        const xi = im[b] as number;
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
}

/**
 * Compute the log-mel spectrogram of `samples`, returning `frames * 32` values
 * row-major (frame-major).
 *
 * `samples` are raw int16 magnitudes as floats, the same scaling openWakeWord
 * feeds its front end, i.e. NOT normalised to [-1, 1]. Feeding normalised audio
 * shifts every value by a constant 90.3 dB and the classifier's scores become
 * meaningless, so the scale is part of the contract, not a detail.
 *
 * The decibel floor is `peak - 80` where `peak` is the maximum over everything
 * this call produced. That makes the result depend on the call's framing, which
 * is why the streaming pipeline always hands over a fixed-size window rather
 * than whatever audio happens to be buffered.
 */
export function melFrames(samples: Float32Array | Float64Array, scratch: MelScratch = SHARED_SCRATCH): Float32Array {
  const frames = melFrameCount(samples.length);
  if (frames === 0) return new Float32Array(0);
  const out = new Float32Array(frames * WAKE_MEL_BINS);
  const { re, im, power } = scratch;
  let peakDb = -Infinity;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * WAKE_MEL_HOP;
    for (let n = 0; n < WAKE_MEL_N_FFT; n += 1) {
      re[n] = (samples[offset + n] as number) * (WINDOW[n] as number);
      im[n] = 0;
    }
    fft(re, im);
    for (let bin = 0; bin < WAKE_MEL_FFT_BINS; bin += 1) {
      const r = re[bin] as number;
      const i = im[bin] as number;
      power[bin] = r * r + i * i;
    }
    const base = frame * WAKE_MEL_BINS;
    for (let band = 0; band < WAKE_MEL_BINS; band += 1) {
      let acc = 0;
      for (let bin = 0; bin < WAKE_MEL_FFT_BINS; bin += 1) {
        const weight = MEL_BANK[bin * WAKE_MEL_BINS + band] as number;
        if (weight !== 0) acc += (power[bin] as number) * weight;
      }
      // The reference graph's tail: clip(amin, inf) -> log -> *10 -> /ln(10),
      // which is exactly 10*log10(x), then `- 0` for ref = 1.0.
      const clamped = acc < WAKE_MEL_AMIN ? WAKE_MEL_AMIN : acc;
      const db = 10 * Math.log10(clamped);
      out[base + band] = db;
      if (db > peakDb) peakDb = db;
    }
  }

  const floor = peakDb - WAKE_MEL_TOP_DB;
  for (let i = 0; i < out.length; i += 1) {
    if ((out[i] as number) < floor) out[i] = floor;
  }
  return out;
}

/**
 * openWakeWord's own rescaling of the melspectrogram before the embedding
 * backbone: `value / 10 + 2`. Its source comments this as bringing the ONNX
 * melspectrogram in line with the original TensorFlow implementation from
 * `tfhub google/speech_embedding/1`. The embedding model was trained on the
 * rescaled values, so this is part of the front end and not a preference.
 *
 * Applied in place; returns the same array for chaining.
 */
export function applyEmbeddingScaling(frames: Float32Array): Float32Array {
  for (let i = 0; i < frames.length; i += 1) frames[i] = (frames[i] as number) / 10 + 2;
  return frames;
}

/** Allocate a private scratch set, for a caller running several streams at once. */
export function createMelScratch(): MelScratch {
  return makeScratch();
}

export type { MelScratch };
