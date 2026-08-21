/**
 * Detection behaviour, driven by REAL per-frame scores.
 *
 * The score traces in the fixture came out of the full reference pipeline, the
 * published hey_goodvibes 1.0.0 classifier over a held-out positive clip and a
 * held-out prose clip, so "fires on a positive, does not fire on a negative"
 * is checked against what the shipped model actually produces, not against
 * numbers invented to make a threshold look reasonable.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/wake-word-front-end.json' with { type: 'json' };
import { WakeDetector, WAKE_DETECTOR_DEFAULTS } from '../packages/sdk/src/platform/voice/wake/detector.js';
import { WakeWordEngine } from '../packages/sdk/src/platform/voice/wake/engine.js';
import { WAKE_CHUNK_SAMPLES, WAKE_CLASSIFIER_FRAMES, WAKE_EMBED_DIM } from '../packages/sdk/src/platform/voice/wake/feature-pipeline.js';
import type { WakeInferenceSession, WakeTensor } from '../packages/sdk/src/platform/voice/wake/types.js';
import { resolveWakeWordModel } from '../packages/sdk/src/platform/voice/provisioning/wake-word-manifest.js';

const POSITIVE = fixture.scoreTraces.positive.scores;
const NEGATIVE = fixture.scoreTraces.negative.scores;

/** An embedding backbone stand-in: shape-correct, content irrelevant here. */
function stubEmbedding(): WakeInferenceSession {
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: async () => ({ embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] } }),
  };
}

/** A classifier stand-in replaying a measured score trace, one score per call. */
function replayClassifier(scores: readonly number[]): WakeInferenceSession & { calls: number } {
  const session = {
    calls: 0,
    inputNames: ['input'],
    outputNames: ['score'],
    run: async (feeds: Readonly<Record<string, WakeTensor>>) => {
      const input = feeds['input'];
      // Guard the contract the real classifier depends on: a flat 16 x 96 window.
      expect(input?.dims).toEqual([1, WAKE_CLASSIFIER_FRAMES, WAKE_EMBED_DIM]);
      const value = scores[session.calls] ?? 0;
      session.calls += 1;
      return { score: { data: Float32Array.from([value]), dims: [1, 1] } };
    },
  };
  return session;
}

async function runTrace(scores: readonly number[], threshold: number) {
  const classifier = replayClassifier(scores);
  let clock = 0;
  const engine = new WakeWordEngine({
    embedding: stubEmbedding(),
    models: [{ id: 'hey_goodvibes', session: classifier }],
    tuning: { threshold },
    preRollMs: 500,
    now: () => clock,
  });
  const silence = new Float32Array(WAKE_CHUNK_SAMPLES);
  const detections = [];
  // The pipeline scores for the first time on the 16th frame, the one that
  // completes the window, so `scores.length + 15` frames replay the trace exactly.
  for (let i = 0; i < scores.length + WAKE_CLASSIFIER_FRAMES - 1; i += 1) {
    clock += 80;
    const result = await engine.pushFrame(silence);
    detections.push(...result.detections);
  }
  return { detections, classifierCalls: classifier.calls };
}

describe('wake-word detection on measured score traces', () => {
  test('the shipped default threshold is 0.9, not openWakeWord\'s 0.5', () => {
    // Deliberate, and an override of the value originally accepted for this row:
    // 0.5 fires on 34.5% of never-trained minimal pairs at 99.2% recall, 0.9 on
    // 24.7% at 96.8%. The model manifest and the detector default must agree.
    expect(WAKE_DETECTOR_DEFAULTS.threshold).toBe(0.9);
    expect(resolveWakeWordModel()?.recommendedThreshold).toBe(0.9);
    expect(WAKE_DETECTOR_DEFAULTS.patienceFrames).toBe(2);
    expect(WAKE_DETECTOR_DEFAULTS.cooldownMs).toBe(2000);
  });

  test('the fixture traces are what they claim to be', () => {
    expect(POSITIVE.length).toBeGreaterThan(20);
    expect(NEGATIVE.length).toBeGreaterThan(20);
    expect(Math.max(...POSITIVE)).toBeGreaterThan(0.9);
    expect(Math.max(...NEGATIVE)).toBeLessThan(0.9);
  });

  test('fires on a known positive clip', async () => {
    const { detections, classifierCalls } = await runTrace(POSITIVE, 0.9);
    expect(classifierCalls).toBe(POSITIVE.length);
    expect(detections.length).toBeGreaterThan(0);
    const first = detections[0];
    expect(first?.modelId).toBe('hey_goodvibes');
    expect(first?.peakScore).toBeGreaterThanOrEqual(0.9);
    expect(first?.frames).toBe(2);
  });

  test('does not fire on a known negative clip', async () => {
    const { detections, classifierCalls } = await runTrace(NEGATIVE, 0.9);
    expect(classifierCalls).toBe(NEGATIVE.length);
    expect(detections).toEqual([]);
  });

  test('the negative clip would still not fire at the upstream 0.5 default', async () => {
    // Recorded so a future threshold change is judged against real audio: this
    // particular prose clip peaks at ~0.25, well under either threshold.
    const { detections } = await runTrace(NEGATIVE, 0.5);
    expect(detections).toEqual([]);
  });

  test('a detection carries pre-roll audio from before it fired', async () => {
    const classifier = replayClassifier(POSITIVE);
    let clock = 0;
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      tuning: { threshold: 0.9 },
      preRollMs: 500,
      now: () => clock,
    });
    const tone = Float32Array.from({ length: WAKE_CHUNK_SAMPLES }, (_, i) => Math.sin(i / 8) * 4000);
    let detection;
    for (let i = 0; i < POSITIVE.length + WAKE_CLASSIFIER_FRAMES && detection === undefined; i += 1) {
      clock += 80;
      detection = (await engine.pushFrame(tone)).detections[0];
    }
    expect(detection).toBeDefined();
    // 500 ms at 16 kHz.
    expect(detection?.preRoll.length).toBe(8000);
    expect(detection?.preRoll.some((v) => v !== 0)).toBe(true);
  });
});

describe('patience and cooldown', () => {
  test('patience requires consecutive frames, and a gap restarts the run', () => {
    const detector = new WakeDetector({ threshold: 0.9, patienceFrames: 3, cooldownMs: 0 });
    expect(detector.push(0.95, 0).kind).toBe('building');
    expect(detector.push(0.99, 80).kind).toBe('building');
    // One frame below threshold breaks the run entirely.
    expect(detector.push(0.2, 160).kind).toBe('idle');
    expect(detector.push(0.95, 240).kind).toBe('building');
    expect(detector.push(0.95, 320).kind).toBe('building');
    const fired = detector.push(0.97, 400);
    expect(fired.kind).toBe('fired');
    if (fired.kind === 'fired') {
      expect(fired.frames).toBe(3);
      expect(fired.peakScore).toBeCloseTo(0.97, 6);
    }
  });

  test('cooldown suppresses a second fire from the same utterance', () => {
    const detector = new WakeDetector({ threshold: 0.9, patienceFrames: 1, cooldownMs: 2000 });
    expect(detector.push(0.95, 1000).kind).toBe('fired');
    const suppressed = detector.push(0.99, 1080);
    expect(suppressed.kind).toBe('cooldown');
    if (suppressed.kind === 'cooldown') expect(suppressed.remainingMs).toBe(1920);
    // Still suppressed one millisecond before the cooldown lapses...
    expect(detector.push(0.99, 2999).kind).toBe('cooldown');
    // ...and free again once it has.
    expect(detector.push(0.99, 3000).kind).toBe('fired');
  });

  test('a run building during cooldown is discarded, not resumed', () => {
    // Otherwise a phrase spoken during cooldown completes the instant the
    // cooldown lapses, firing on audio that already passed.
    const detector = new WakeDetector({ threshold: 0.9, patienceFrames: 2, cooldownMs: 1000 });
    expect(detector.push(0.95, 0).kind).toBe('building');
    expect(detector.push(0.95, 80).kind).toBe('fired');
    expect(detector.push(0.95, 160).kind).toBe('cooldown');
    // Fired at t=80, so the 1000 ms cooldown runs to t=1080.
    expect(detector.push(0.95, 1079).kind).toBe('cooldown');
    expect(detector.push(0.95, 1080).kind).toBe('building');
    expect(detector.push(0.95, 1160).kind).toBe('fired');
  });

  test('reset clears both the run and the cooldown', () => {
    const detector = new WakeDetector({ threshold: 0.9, patienceFrames: 2, cooldownMs: 5000 });
    detector.push(0.95, 0);
    detector.push(0.95, 80);
    expect(detector.cooldownRemaining(80)).toBe(5000);
    detector.reset();
    expect(detector.cooldownRemaining(80)).toBe(0);
    expect(detector.push(0.95, 160).kind).toBe('building');
  });

  test('rejects tuning that cannot mean anything', () => {
    expect(() => new WakeDetector({ patienceFrames: 0 })).toThrow(/patienceFrames/);
    expect(() => new WakeDetector({ threshold: 1.5 })).toThrow(/threshold/);
  });
});

describe('running several models', () => {
  test('models score independently over one shared front-end pass', async () => {
    let embeddingCalls = 0;
    const embedding: WakeInferenceSession = {
      inputNames: ['input_1'],
      outputNames: ['embedding'],
      run: async () => {
        embeddingCalls += 1;
        return { embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] } };
      },
    };
    const hot = replayClassifier(Array.from({ length: 40 }, () => 0.99));
    const cold = replayClassifier(Array.from({ length: 40 }, () => 0.01));
    let clock = 0;
    const engine = new WakeWordEngine({
      embedding,
      models: [{ id: 'hot', session: hot }, { id: 'cold', session: cold }],
      tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 0 },
      now: () => clock,
    });
    const silence = new Float32Array(WAKE_CHUNK_SAMPLES);
    const fired: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      clock += 80;
      for (const detection of (await engine.pushFrame(silence)).detections) fired.push(detection.modelId);
    }
    expect(fired.every((id) => id === 'hot')).toBe(true);
    expect(fired.length).toBeGreaterThan(0);
    // The expensive stages ran once per frame regardless of model count, the
    // reason a second wake word is cheap.
    expect(embeddingCalls).toBe(20);
    expect(engine.modelIds).toEqual(['hot', 'cold']);
  });

  test('a model that throws is skipped, not fatal to the others', async () => {
    const broken: WakeInferenceSession = {
      inputNames: ['input'],
      outputNames: ['score'],
      run: async () => {
        throw new Error('corrupt custom model');
      },
    };
    const working = replayClassifier(Array.from({ length: 40 }, () => 0.99));
    let clock = 0;
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'broken', session: broken }, { id: 'pinned', session: working }],
      tuning: { threshold: 0.9, patienceFrames: 1, cooldownMs: 0 },
      now: () => clock,
    });
    const silence = new Float32Array(WAKE_CHUNK_SAMPLES);
    let detections: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      clock += 80;
      detections = detections.concat((await engine.pushFrame(silence)).detections.map((d) => d.modelId));
    }
    expect(detections).toContain('pinned');
    expect(detections).not.toContain('broken');
  });

  test('a per-model threshold overrides the engine tuning', async () => {
    const permissive = replayClassifier(Array.from({ length: 40 }, () => 0.6));
    let clock = 0;
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'lenient', session: permissive, threshold: 0.5 }],
      tuning: { threshold: 0.9, patienceFrames: 1, cooldownMs: 0 },
      now: () => clock,
    });
    const silence = new Float32Array(WAKE_CHUNK_SAMPLES);
    let count = 0;
    for (let i = 0; i < 20; i += 1) {
      clock += 80;
      count += (await engine.pushFrame(silence)).detections.length;
    }
    expect(count).toBeGreaterThan(0);
  });

  test('reset clears the pipeline so a restart cannot inherit half a phrase', async () => {
    const classifier = replayClassifier(Array.from({ length: 80 }, () => 0.99));
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'x', session: classifier }],
      tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 0 },
      now: () => 0,
    });
    const silence = new Float32Array(WAKE_CHUNK_SAMPLES);
    for (let i = 0; i < WAKE_CLASSIFIER_FRAMES; i += 1) await engine.pushFrame(silence);
    expect(engine.framesSeen).toBe(WAKE_CLASSIFIER_FRAMES);
    engine.reset();
    expect(engine.framesSeen).toBe(0);
    // Scoring only resumes after the window refills from scratch.
    expect((await engine.pushFrame(silence)).scores.size).toBe(0);
  });
});
