/**
 * voice-vad-gate.test.ts — `voice.wake.vadThreshold`, proven on real signal.
 *
 * The row shipped refusing: it named a stage with no model behind it. There is a
 * model now — ours, a speech/non-speech head over the SAME pinned embedding the
 * wake classifier consumes — so the claim to prove is that non-speech frames are
 * WITHHELD from the classifier while speech frames reach it.
 *
 * The probabilities here are not invented. `test/fixtures/wake-vad.json` carries
 * the head's output for every frame of one held-out noise recording and one
 * held-out speech recording, run through the SDK's own melspectrogram and the
 * pinned embedding session by the training harness (kept beside the artifacts;
 * see docs/wake-word-model.md). The SDK has no inference runtime of its own — the
 * host supplies one — so this is the same shape the wake-word tests already use
 * for the classifier: the real model's real output, replayed.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/wake-vad.json' with { type: 'json' };
import { WakeWordEngine } from '../packages/sdk/src/platform/voice/wake/engine.js';
import { WakeDetector } from '../packages/sdk/src/platform/voice/wake/detector.js';
import { resolveWakeRuntimeSettings } from '../packages/sdk/src/platform/voice/wake/settings.js';
import { WAKE_CHUNK_SAMPLES, WAKE_EMBED_DIM } from '../packages/sdk/src/platform/voice/wake/feature-pipeline.js';
import {
  resolveWakeVadThreshold,
  WAKE_VAD_MODEL,
} from '../packages/sdk/src/platform/voice/provisioning/wake-word-manifest.js';
import { voiceWakeConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-voice-wake.js';
import type { WakeInferenceSession, WakeTensor } from '../packages/sdk/src/platform/voice/wake/types.js';

const RECOMMENDED = WAKE_VAD_MODEL.recommendedThreshold;

function passRate(values: readonly number[], threshold: number): number {
  return values.filter((value) => value >= threshold).length / values.length;
}

// ── the pin and the measurements agree with the recorded model ───────────────

describe('the speech gate is pinned, measured, and its numbers match the artifact', () => {
  test('the fixture was recorded from the pinned artifact', () => {
    expect(fixture.onnxSha256).toBe(WAKE_VAD_MODEL.onnx.sha256);
    expect(fixture.vadVersion).toBe(WAKE_VAD_MODEL.version);
    expect(fixture.frontEnd).toContain('speech-embedding-1.0.0');
    expect(WAKE_VAD_MODEL.license).toBe('Apache-2.0');
    // The NOTICE is pinned like any other asset, so it cannot be swapped silently.
    expect(WAKE_VAD_MODEL.notice.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(WAKE_VAD_MODEL.onnx.bytes).toBeGreaterThan(0);
    expect(WAKE_VAD_MODEL.tflite.bytes).toBeGreaterThan(0);
  });

  test('the manifest threshold table is the measured one, not a rounded guess', () => {
    expect(WAKE_VAD_MODEL.measurements.evalFrames).toBe(fixture.heldOutFrames);
    expect(WAKE_VAD_MODEL.measurements.evalSpeechFrames).toBe(fixture.heldOutSpeechFrames);
    for (const row of fixture.thresholdTable) {
      const pinned = WAKE_VAD_MODEL.thresholds.find((entry) => entry.threshold === row.threshold);
      expect(pinned).toBeDefined();
      expect(pinned?.speechPassRate).toBeCloseTo(row.speechPassRate, 3);
      expect(pinned?.noiseGateRate).toBeCloseTo(row.noiseGateRate, 3);
    }
    // The twins decide identically — a tflite host and an onnx host gate the same
    // frames, which is the only reason shipping both is safe.
    expect(WAKE_VAD_MODEL.measurements.twinDecisionFlips).toBe(0);
    expect(WAKE_VAD_MODEL.measurements.maxAbsTwinDeviation).toBeLessThan(1e-5);
  });

  test('a configured threshold resolves to the measured row at or below it', () => {
    expect(resolveWakeVadThreshold(0.3)?.threshold).toBe(0.3);
    expect(resolveWakeVadThreshold(0.35)?.threshold).toBe(0.3);
    expect(resolveWakeVadThreshold(0.01)?.threshold).toBe(0.05);
    expect(resolveWakeVadThreshold(1)?.threshold).toBe(0.9);
  });

  test('on real audio the gate closes on noise and opens on speech', () => {
    // This is the measurement the row exists for, on frames from recordings the
    // head never trained on.
    const noise = passRate(fixture.traces.noise, RECOMMENDED);
    const speech = passRate(fixture.traces.speech, RECOMMENDED);
    expect(fixture.traces.noise.length).toBeGreaterThan(100);
    expect(fixture.traces.speech.length).toBeGreaterThan(100);
    // Recorded: 0.0% of the noise recording's frames pass, 95.8% of the speech
    // recording's do.
    expect(noise).toBeLessThan(0.02);
    expect(speech).toBeGreaterThan(0.9);
    // And the aggregate over the whole held-out set, from the manifest.
    const row = resolveWakeVadThreshold(RECOMMENDED);
    expect(row?.speechPassRate).toBeGreaterThan(0.95);
    expect(row?.noiseGateRate).toBeGreaterThan(0.95);
  });
});

// ── the engine: withheld frames run no classifier inference ─────────────────

/** A VAD session that replays recorded probabilities, in order, and counts calls. */
function replayGate(probabilities: readonly number[]): WakeInferenceSession & { calls: number } {
  const session = {
    calls: 0,
    inputNames: [WAKE_VAD_MODEL.inputName],
    outputNames: [WAKE_VAD_MODEL.outputName],
    run: async (feeds: Readonly<Record<string, WakeTensor>>) => {
      const input = feeds[WAKE_VAD_MODEL.inputName];
      // The gate is handed ONE embedding frame, not the classifier's 16-frame window.
      expect(input?.dims).toEqual([1, WAKE_EMBED_DIM]);
      expect(input?.data.length).toBe(WAKE_EMBED_DIM);
      const value = probabilities[session.calls % probabilities.length] ?? 0;
      session.calls += 1;
      return { [WAKE_VAD_MODEL.outputName]: { data: Float32Array.from([value]), dims: [1, 1] } };
    },
  };
  return session;
}

function stubEmbedding(): WakeInferenceSession {
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: async () => ({
      embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] },
    }),
  };
}

/** A classifier that always fires, and counts how often it was asked to. */
function countingClassifier(score = 1): WakeInferenceSession & { calls: number } {
  const session = {
    calls: 0,
    inputNames: ['onnx::Flatten_0'],
    outputNames: ['output'],
    run: async () => {
      session.calls += 1;
      return { output: { data: Float32Array.from([score]), dims: [1, 1] } };
    },
  };
  return session;
}

const FRAME = new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000);

async function drive(engine: WakeWordEngine, frames: number): Promise<Array<Awaited<ReturnType<WakeWordEngine['pushFrame']>>>> {
  const results: Array<Awaited<ReturnType<WakeWordEngine['pushFrame']>>> = [];
  for (let i = 0; i < frames; i += 1) results.push(await engine.pushFrame(FRAME));
  return results;
}

describe('a withheld frame reaches no classifier', () => {
  test('the noise recording gates every frame, and the classifier is never run', async () => {
    const classifier = countingClassifier();
    const gate = replayGate(fixture.traces.noise);
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      vad: { session: gate, threshold: RECOMMENDED },
      tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 0 },
    });
    const results = await drive(engine, 60);
    // The first 15 frames fill the front end and produce no features at all, so
    // the gate is not consulted for them either.
    const scored = results.filter((result) => result.vad !== null);
    expect(scored.length).toBeGreaterThan(40);
    expect(scored.every((result) => result.vad?.gated === true)).toBe(true);
    expect(scored.every((result) => result.detections.length === 0)).toBe(true);
    expect(gate.calls).toBe(scored.length);
    // The point of the stage: the 2.4 MB classifier was never asked to run.
    expect(classifier.calls).toBe(0);
  });

  test('the speech recording passes frames through, and a wake fires', async () => {
    const classifier = countingClassifier();
    const gate = replayGate(fixture.traces.speech);
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      vad: { session: gate, threshold: RECOMMENDED },
      tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 0 },
    });
    const results = await drive(engine, 60);
    const scored = results.filter((result) => result.vad !== null);
    const passed = scored.filter((result) => result.vad?.gated === false);
    expect(passed.length / scored.length).toBeGreaterThan(0.9);
    expect(classifier.calls).toBe(passed.length);
    expect(results.some((result) => result.detections.length > 0)).toBe(true);
  });

  test('threshold 0 is no gate at all: the session is never consulted', async () => {
    const classifier = countingClassifier(0);
    const gate = replayGate([0]);
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      // The shipped default. A gate that cost an inference per frame while
      // configured off would be the row quietly doing something.
      vad: { session: gate, threshold: 0 },
    });
    const results = await drive(engine, 30);
    expect(gate.calls).toBe(0);
    expect(results.every((result) => result.vad === null)).toBe(true);
    expect(classifier.calls).toBeGreaterThan(0);
  });

  test('a gate that fails passes the frame through and says so', async () => {
    // Gating on failure would turn the wake word off silently, which is worse than
    // a frame reaching the classifier unscreened and being reported.
    const classifier = countingClassifier(0);
    const warnings: string[] = [];
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      vad: {
        session: {
          inputNames: ['embedding'],
          outputNames: ['speech_probability'],
          run: async () => { throw new Error('the runtime lost the session'); },
        },
        threshold: RECOMMENDED,
      },
      warn: (message) => warnings.push(message),
    });
    const results = await drive(engine, 30);
    const scored = results.filter((result) => result.vad !== null);
    expect(scored.length).toBeGreaterThan(10);
    expect(scored.every((result) => result.vad?.failed === true)).toBe(true);
    expect(scored.every((result) => result.vad?.gated === false)).toBe(true);
    expect(classifier.calls).toBe(scored.length);
    expect(warnings.some((message) => message.includes('not being screened'))).toBe(true);
  });

  test('a non-finite probability is a failure, not a gate decision', async () => {
    const classifier = countingClassifier(0);
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      vad: {
        session: {
          inputNames: ['embedding'],
          outputNames: ['speech_probability'],
          run: async () => ({ speech_probability: { data: Float32Array.from([Number.NaN]), dims: [1, 1] } }),
        },
        threshold: RECOMMENDED,
      },
    });
    const results = await drive(engine, 30);
    const scored = results.filter((result) => result.vad !== null);
    expect(scored.every((result) => result.vad?.failed === true && result.vad?.probability === null)).toBe(true);
    expect(classifier.calls).toBe(scored.length);
  });
});

describe('gating and the detector interact honestly', () => {
  test('a withheld frame breaks a run in progress but never clears a cooldown', () => {
    const detector = new WakeDetector({ threshold: 0.5, patienceFrames: 2, cooldownMs: 1000 });
    // One frame above threshold, then a gap, then another: patience counts
    // CONSECUTIVE scored frames, so the run must not complete across the gap.
    expect(detector.push(0.9, 0).kind).toBe('building');
    detector.breakRun();
    expect(detector.push(0.9, 80).kind).toBe('building');
    expect(detector.push(0.9, 160).kind).toBe('fired');
    // A wake just fired; breaking a run must not open the door to a second one.
    detector.breakRun();
    expect(detector.cooldownRemaining(200)).toBeGreaterThan(0);
    expect(detector.push(0.9, 240).kind).toBe('cooldown');
  });

  test('a gap of gated frames prevents a wake the un-gated run would have fired', async () => {
    const classifier = countingClassifier();
    // Alternating pass/withhold, so no two SCORED frames are ever consecutive.
    const gate = replayGate([0.99, 0.01]);
    const engine = new WakeWordEngine({
      embedding: stubEmbedding(),
      models: [{ id: 'hey_goodvibes', session: classifier }],
      vad: { session: gate, threshold: RECOMMENDED },
      tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 0 },
    });
    const results = await drive(engine, 60);
    expect(classifier.calls).toBeGreaterThan(10);
    expect(results.every((result) => result.detections.length === 0)).toBe(true);
  });
});

// ── the setting ─────────────────────────────────────────────────────────────

function wakeReader(overrides: Readonly<Record<string, unknown>> = {}): (key: string) => unknown {
  const wake = voiceWakeConfigDefaults.voice.wake as unknown as Record<string, unknown>;
  return (key: string) => {
    if (key in overrides) return overrides[key];
    const leaf = key.replace('voice.wake.', '');
    if (leaf.startsWith('surfaces.')) {
      return (wake['surfaces'] as Record<string, boolean>)[leaf.slice('surfaces.'.length)];
    }
    return wake[leaf];
  };
}

describe('the row says what it does, per surface', () => {
  test('a surface with the gate loaded runs at a threshold above 0', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.vadThreshold': RECOMMENDED }),
      'tui',
      { vadAvailable: true },
    );
    expect(resolved.active).toBe(true);
    expect(resolved.blockers).toEqual([]);
    expect(resolved.vadThreshold).toBe(RECOMMENDED);
  });

  test('a surface without it refuses, naming the pinned gate and its measured numbers', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.vadThreshold': RECOMMENDED }),
      'tui',
    );
    expect(resolved.active).toBe(false);
    expect(resolved.blockers[0]?.key).toBe('voice.wake.vadThreshold');
    expect(resolved.blockers[0]?.detail).toContain('goodvibes-vad');
    expect(resolved.blockers[0]?.detail).toContain('96.0% of speech frames');
  });

  test('the shipped default of 0 runs everywhere, gate or no gate', () => {
    const resolved = resolveWakeRuntimeSettings(wakeReader({ 'voice.wake.enabled': true }), 'tui');
    expect(resolved.vadThreshold).toBe(0);
    expect(resolved.active).toBe(true);
  });
});
