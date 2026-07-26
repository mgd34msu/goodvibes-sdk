/**
 * The wake-word front end is computed in code instead of downloaded, and the
 * published classifier was TRAINED against openWakeWord's front end. So the
 * only thing standing between a refactor and a silently degraded detector is
 * this file: if the in-code melspectrogram stops reproducing the reference
 * graph's output, every recall and false-accept figure in
 * docs/wake-word-model.md stops describing the running detector.
 *
 * The reference values in test/fixtures/wake-word-front-end.json are MEASURED,
 * not chosen — produced by running openWakeWord's own melspectrogram.onnx,
 * openWakeWord's embedding_model.onnx and the published hey_goodvibes 1.0.0
 * classifier over these exact inputs.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/wake-word-front-end.json' with { type: 'json' };
import {
  melFrames,
  melFrameCount,
  melFilterbank,
  analysisWindow,
  applyEmbeddingScaling,
  WAKE_MEL_BINS,
  WAKE_MEL_N_FFT,
  WAKE_MEL_HOP,
  WAKE_MEL_WIN_LENGTH,
  WAKE_MEL_FMIN,
  WAKE_MEL_FMAX,
  WAKE_MEL_FFT_BINS,
} from '../packages/sdk/src/platform/voice/wake/melspectrogram.js';
import { WAKE_WORD_FRONT_END } from '../packages/sdk/src/platform/voice/provisioning/wake-word-manifest.js';

/**
 * Regenerates the deterministic synthetic input the fixture's reference frames
 * were measured on. Must stay bit-identical to make-fixtures.mjs.
 */
function syntheticPcm(n: number): Float32Array {
  const out = new Float32Array(n);
  let state = 12345 >>> 0;
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = (state / 0xffffffff) * 2 - 1;
    const tone = Math.sin((2 * Math.PI * 440 * i) / 16000) + 0.5 * Math.sin((2 * Math.PI * 1970 * i) / 16000);
    out[i] = Math.round((0.35 * noise + 0.45 * tone) * 8000);
  }
  return out;
}

function maxAbsDiff(actual: Float32Array, expected: readonly number[]): number {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i += 1) {
    worst = Math.max(worst, Math.abs((actual[i] as number) - (expected[i] as number)));
  }
  return worst;
}

/**
 * The fixture rounds reference values to 5 decimal places, so ~1e-5 of the
 * budget is quantisation. The measured divergence on 4.7M real mel values is
 * 4.292e-5 dB; 5e-4 leaves an order of magnitude of headroom while still
 * failing loudly on any real change to the DSP.
 */
const MEL_TOLERANCE_DB = 5e-4;

describe('wake-word front end reproduces openWakeWord', () => {
  test('the DSP constants are the ones recovered from the reference graph', () => {
    // Recovered numerically from melspectrogram.onnx's own initializers, not
    // taken from a library's defaults. A change to any of these is a change to
    // what the published classifier is being fed.
    expect(WAKE_MEL_N_FFT).toBe(512);
    expect(WAKE_MEL_HOP).toBe(160);
    expect(WAKE_MEL_WIN_LENGTH).toBe(400);
    expect(WAKE_MEL_BINS).toBe(32);
    expect(WAKE_MEL_FMIN).toBe(60);
    expect(WAKE_MEL_FMAX).toBe(3800);
    expect(WAKE_MEL_FFT_BINS).toBe(257);
  });

  test('the analysis window is a periodic Hann of 400 taps centred in 512', () => {
    const window = analysisWindow();
    expect(window.length).toBe(512);
    const pad = (512 - 400) / 2;
    // Zero outside the 400-tap support, peaking at 1.0 in the middle.
    expect(window[0]).toBe(0);
    expect(window[pad - 1]).toBe(0);
    expect(window[511]).toBe(0);
    expect(window[pad + 200] as number).toBeCloseTo(1, 12);
    // Periodic (divisor L), not symmetric (divisor L-1): the two differ by
    // 6.0e-3, seven million times the residual against the reference weights.
    for (let n = 0; n < 400; n += 1) {
      expect(window[pad + n] as number).toBeCloseTo(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 400), 12);
    }
  });

  test('the mel filterbank is Slaney-scaled, Slaney-normalised, 60 Hz to 3800 Hz', () => {
    const bank = melFilterbank();
    expect(bank.length).toBe(257 * 32);
    // Reference `1.melW` peaks at 1.423e-2 and has 229 non-zero weights; both
    // are consequences of the scale, range and area normalisation together.
    let nonZero = 0;
    let peak = 0;
    for (const weight of bank) {
      if (weight !== 0) nonZero += 1;
      peak = Math.max(peak, weight);
    }
    expect(nonZero).toBe(229);
    expect(peak).toBeCloseTo(1.4234e-2, 6);
  });

  test('framing is center=False — no padding, 8 frames per 80 ms chunk with context', () => {
    expect(melFrameCount(511)).toBe(0);
    expect(melFrameCount(512)).toBe(1);
    // The streaming recipe: 1280 new samples plus 3 hops of context yields
    // exactly 8 frames, i.e. 100 fps. Dropping the context gives 5 (62.5 fps)
    // and time-warps every phrase relative to what the model was trained on.
    expect(melFrameCount(1280 + 480)).toBe(8);
    expect(melFrameCount(1280)).toBe(5);
  });

  test('synthetic signal matches the reference graph frame for frame', () => {
    const pcm = syntheticPcm(fixture.synthetic.samples);
    const frames = melFrames(pcm);
    expect(frames.length / WAKE_MEL_BINS).toBe(melFrameCount(fixture.synthetic.samples));
    expect(maxAbsDiff(frames, fixture.synthetic.melDb)).toBeLessThan(MEL_TOLERANCE_DB);
  });

  test('real speech matches the reference graph frame for frame', () => {
    const pcm = Float32Array.from(fixture.speech.pcm);
    expect(maxAbsDiff(melFrames(pcm), fixture.speech.melDb)).toBeLessThan(MEL_TOLERANCE_DB);
  });

  test('the embedding rescaling is x/10 + 2, applied in place', () => {
    // openWakeWord's own transform bringing the melspectrogram into line with
    // the original TensorFlow speech_embedding front end. The embedding model
    // was trained on the rescaled values, so it is part of the front end.
    const frames = Float32Array.from([-40, 0, 10, 55]);
    const returned = applyEmbeddingScaling(frames);
    expect(returned).toBe(frames);
    expect(Array.from(frames)).toEqual([-2, 2, 3, 7.5]);
  });

  test('the manifest records the measured divergence rather than a claim', () => {
    // These are the numbers this file exists to defend; they are quoted in
    // docs and in provisioning surfaces, so they must not drift silently.
    expect(WAKE_WORD_FRONT_END.melspectrogram.computedInCode).toBe(true);
    expect(WAKE_WORD_FRONT_END.melspectrogram.maxAbsDeviationDb).toBeLessThan(MEL_TOLERANCE_DB);
    expect(WAKE_WORD_FRONT_END.melspectrogram.valuesCompared).toBeGreaterThan(1_000_000);
    // The embedding stage is Google's own weights, bit-exact against the copy
    // the classifier was trained with.
    expect(WAKE_WORD_FRONT_END.embedding.maxAbsDeviation).toBe(0);
    expect(WAKE_WORD_FRONT_END.embedding.license).toBe('Apache-2.0');
    expect(WAKE_WORD_FRONT_END.embedding.inputDims).toEqual([1, 76, 32, 1]);
    expect(WAKE_WORD_FRONT_END.embedding.outputDim).toBe(96);
    // The number that actually matters: no detection decision changed.
    expect(WAKE_WORD_FRONT_END.endToEnd.decisionFlipsAtRecommendedThreshold).toBe(0);
    expect(WAKE_WORD_FRONT_END.endToEnd.framesCompared).toBeGreaterThan(1000);
  });

  test('audio scale is part of the contract, not a detail', () => {
    // Raw int16 magnitudes, NOT normalised to [-1, 1]. Feeding normalised audio
    // shifts every value by a constant ~90.3 dB and the classifier's scores stop
    // meaning anything, so a regression here must fail rather than look plausible.
    const raw = syntheticPcm(1760);
    const normalised = Float32Array.from(raw, (v) => v / 32768);
    const rawFrames = melFrames(raw);
    const normalisedFrames = melFrames(normalised);
    const shift = (rawFrames[0] as number) - (normalisedFrames[0] as number);
    expect(shift).toBeGreaterThan(85);
    expect(shift).toBeLessThan(95);
  });
});
