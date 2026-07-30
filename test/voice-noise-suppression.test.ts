/**
 * voice-noise-suppression.test.ts — `voice.wake.noiseSuppression: "speex"`, proven
 * on signal rather than on a smoke call.
 *
 * The row shipped with a value that refused, because nothing applied the filter it
 * named. The claim now is that it filters, so the test that matters is a
 * MEASUREMENT: a tone buried in white noise goes through the real WebAssembly
 * module and the noise floor has to come down by a stated number of dB while the
 * tone survives. A test that only asserted "process() returned something" would
 * pass just as happily against a filter that copies its input.
 *
 * The rest of the file is about the other half of honesty: `none` has to be the
 * byte path that shipped (the same frame objects, untouched), the stage has to
 * reach every consumer downstream of the device (the engine, the utterance
 * recorded after a wake, push-to-talk voice input), and a filter that cannot run
 * has to stop capture rather than quietly pass audio through.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  SPEEXDSP_PREPROCESS,
  SPEEX_BLOCK_SAMPLES,
  createNoiseSuppressingOpener,
  createRecorderCaptureOpener,
  createSpeexNoiseSuppression,
  floatSamplesToPcm16,
  frameRms,
  noiseSuppressionSupport,
  PushToTalkSession,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureRequest,
  type AudioCaptureStream,
  type CaptureChildProcess,
  type NoiseSuppressionStage,
} from '../packages/sdk/src/platform/voice/capture/index.js';
import {
  SPEEXDSP_WASM_BASE64,
  SPEEXDSP_WASM_BYTES,
  SPEEXDSP_WASM_SHA256,
} from '../packages/sdk/src/platform/voice/capture/vendor/speexdsp-wasm.js';
import { base64ToBytes } from '../packages/sdk/src/platform/voice/capture/frames.js';
import { WakeWordEngine } from '../packages/sdk/src/platform/voice/wake/engine.js';
import { WakeListener } from '../packages/sdk/src/platform/voice/wake/listener.js';
import { resolveWakeRuntimeSettings } from '../packages/sdk/src/platform/voice/wake/settings.js';
import { WAKE_CHUNK_SAMPLES, WAKE_EMBED_DIM } from '../packages/sdk/src/platform/voice/wake/feature-pipeline.js';
import { voiceWakeConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-voice-wake.js';
import type { CapturedUtterance } from '../packages/sdk/src/platform/voice/capture/voice-input.js';
import type { WakeInferenceSession } from '../packages/sdk/src/platform/voice/wake/types.js';

const RATE = 16_000;
const REPO_ROOT = new URL('..', import.meta.url).pathname;

// ── the signal the measurement runs on ───────────────────────────────────────

/**
 * A 1 kHz tone gated half a second on, half a second off, under white noise at a
 * fixed seed. The gate is what makes the measurement possible: the tone-off
 * windows ARE the noise floor, so the same recording gives a before/after on the
 * floor and on the tone without needing two takes.
 */
function toneInNoise(seconds: number): {
  readonly clean: Float32Array;
  readonly noisy: Float32Array;
  readonly gate: Uint8Array;
} {
  const count = RATE * seconds;
  const clean = new Float32Array(count);
  const noisy = new Float32Array(count);
  const gate = new Uint8Array(count);
  let state = 0x9e3779b9 >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let i = 0; i < count; i += 1) {
    const on = Math.floor(i / (RATE / 2)) % 2 === 1;
    const tone = on ? 6000 * Math.sin((2 * Math.PI * 1000 * i) / RATE) : 0;
    clean[i] = tone;
    noisy[i] = tone + 900 * (random() * 2 - 1);
    gate[i] = on ? 1 : 0;
  }
  return { clean, noisy, gate };
}

/**
 * Samples far enough from a gate edge to measure. The suppressor overlap-adds a
 * window twice its block length, so tone energy crosses an edge by design;
 * measuring inside that guard band would score the crossing as noise floor.
 */
const GUARD_SAMPLES = 960;

function guarded(gate: Uint8Array, index: number): boolean {
  const from = Math.max(0, index - GUARD_SAMPLES);
  const to = Math.min(gate.length - 1, index + GUARD_SAMPLES);
  for (let i = from; i <= to; i += 1) if (gate[i] !== gate[index]) return true;
  return false;
}

function windowRms(samples: Float32Array, gate: Uint8Array, want: number, from: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < samples.length; i += 1) {
    if (gate[i] !== want || guarded(gate, i)) continue;
    sum += (samples[i] ?? 0) ** 2;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

const dB = (value: number): number => 20 * Math.log10(value);

/** Normalised correlation with the clean tone, over the tone-on windows. */
function toneCorrelation(clean: Float32Array, actual: Float32Array, gate: Uint8Array, from: number): number {
  let dot = 0;
  let cleanEnergy = 0;
  let actualEnergy = 0;
  for (let i = from; i < clean.length; i += 1) {
    if (gate[i] !== 1 || guarded(gate, i)) continue;
    dot += (clean[i] ?? 0) * (actual[i] ?? 0);
    cleanEnergy += (clean[i] ?? 0) ** 2;
    actualEnergy += (actual[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(cleanEnergy * actualEnergy);
}

// ── the artifact ─────────────────────────────────────────────────────────────

describe('the embedded speexdsp module is the artifact it says it is', () => {
  test('the base64 decodes to the recorded byte count and sha256', () => {
    const bytes = base64ToBytes(SPEEXDSP_WASM_BASE64);
    expect(bytes.length).toBe(SPEEXDSP_WASM_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SPEEXDSP_WASM_SHA256);
    expect(SPEEXDSP_PREPROCESS.moduleSha256).toBe(SPEEXDSP_WASM_SHA256);
  });

  test('the license is BSD-3-Clause and its NOTICE is carried where the manifest says', () => {
    expect(SPEEXDSP_PREPROCESS.license).toBe('BSD-3-Clause');
    expect(SPEEXDSP_PREPROCESS.version).toBe('1.2.1');
    for (const relativePath of [SPEEXDSP_PREPROCESS.noticePath, SPEEXDSP_PREPROCESS.licensePath]) {
      expect(existsSync(`${REPO_ROOT}${relativePath}`)).toBe(true);
    }
    const notice = readFileSync(`${REPO_ROOT}${SPEEXDSP_PREPROCESS.noticePath}`, 'utf8');
    // BSD-3 requires the copyright notice, the conditions and the disclaimer to
    // travel with a binary redistribution — which the base64 above is.
    expect(notice).toContain('Xiph.org Foundation');
    expect(notice).toContain('Redistributions in binary form must reproduce the above copyright');
    expect(notice).toContain('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS');
    expect(notice).toContain(SPEEXDSP_PREPROCESS.upstreamSha256);
    // Nothing NonCommercial or ShareAlike may have entered through the toolchain.
    expect(notice).not.toContain('NonCommercial');
  });

  test('this runtime can run it, and says why in either direction', () => {
    const support = noiseSuppressionSupport();
    expect(support.supported).toBe(true);
    expect(support.reason).toContain('WebAssembly');
  });
});

// ── the measurement ──────────────────────────────────────────────────────────

describe('speex actually suppresses noise, by a measured amount', () => {
  test('the noise floor drops and the tone survives', async () => {
    const { clean, noisy, gate } = toneInNoise(6);
    const stage = await createSpeexNoiseSuppression({ frameSamples: WAKE_CHUNK_SAMPLES });
    expect(stage.blockSamples).toBe(SPEEX_BLOCK_SAMPLES);
    // Read back from the running filter, not restated from a constant here.
    expect(stage.suppressionDb).toBe(SPEEXDSP_PREPROCESS.defaultSuppressionDb);

    const filtered = new Float32Array(noisy.length);
    for (let offset = 0; offset + WAKE_CHUNK_SAMPLES <= noisy.length; offset += WAKE_CHUNK_SAMPLES) {
      filtered.set(stage.process(noisy.subarray(offset, offset + WAKE_CHUNK_SAMPLES)), offset);
    }
    stage.close();

    // Skip the first two seconds: the suppressor is estimating a noise floor it
    // has not heard yet, and scoring its warm-up would flatter it.
    const from = RATE * 2;
    const inputFloor = windowRms(noisy, gate, 0, from);
    const outputFloor = windowRms(filtered, gate, 0, from);
    const inputSignal = windowRms(noisy, gate, 1, from);
    const outputSignal = windowRms(filtered, gate, 1, from);
    const inputSnr = dB(inputSignal) - dB(inputFloor);
    const outputSnr = dB(outputSignal) - dB(outputFloor);
    const floorReduction = dB(inputFloor) - dB(outputFloor);

    // Measured on the reference machine: floor down 13.20 dB, SNR up 12.83 dB,
    // tone correlation 0.9990. The bars are set below those so a rebuild of the
    // module on another toolchain does not fail on the last decimal, while a
    // filter that stopped filtering fails immediately.
    expect(floorReduction).toBeGreaterThan(8);
    expect(outputSnr - inputSnr).toBeGreaterThan(6);
    expect(toneCorrelation(clean, filtered, gate, from)).toBeGreaterThan(0.95);
  });

  test('a frame that is not whole blocks is refused, never part-filtered', async () => {
    const stage = await createSpeexNoiseSuppression({ frameSamples: WAKE_CHUNK_SAMPLES });
    expect(() => stage.process(new Float32Array(SPEEX_BLOCK_SAMPLES + 1))).toThrow(/whole 320-sample blocks/);
    stage.close();
    expect(() => stage.process(new Float32Array(SPEEX_BLOCK_SAMPLES))).toThrow(/closed/);
  });

  test('the filter does not touch the caller\'s frame, because consumers retain it', async () => {
    const stage = await createSpeexNoiseSuppression({ frameSamples: SPEEX_BLOCK_SAMPLES });
    const frame = new Float32Array(SPEEX_BLOCK_SAMPLES).fill(4000);
    const filtered = stage.process(frame);
    expect(filtered).not.toBe(frame);
    expect([...frame].every((sample) => sample === 4000)).toBe(true);
    stage.close();
  });
});

// ── the wiring ───────────────────────────────────────────────────────────────

/** A recorder subprocess that emits exactly what a test hands it. */
function fakeProcess(): CaptureChildProcess & {
  emit(bytes: Uint8Array): void;
  close(code: number | null): void;
} {
  const data: Array<(chunk: Uint8Array) => void> = [];
  const closed: Array<(code: number | null, signal: string | null) => void> = [];
  return {
    stdout: { on: (_event: 'data', listener: (chunk: Uint8Array) => void) => data.push(listener) },
    stderr: { on: () => undefined },
    on(event: 'error' | 'close', listener: never) {
      if (event === 'close') closed.push(listener as unknown as (c: number | null, s: string | null) => void);
      return this;
    },
    kill: () => true,
    emit: (bytes) => { for (const listener of data) listener(bytes); },
    close: (code) => { for (const listener of closed) listener(code, null); },
  };
}

/** A stage with an obvious, checkable transform: every sample halved. */
function halvingStage(created: { count: number }): NoiseSuppressionStage {
  created.count += 1;
  return {
    label: 'halving-test-stage',
    blockSamples: 1,
    suppressionDb: -6,
    process: (frame) => Float32Array.from(frame, (sample) => sample / 2),
    close: () => {},
  };
}

const RECORDER_REQUEST: AudioCaptureRequest = {
  frameSamples: WAKE_CHUNK_SAMPLES,
  device: '',
  backend: 'parecord',
  noiseSuppression: 'none',
};

function recorderOpener(child: CaptureChildProcess): AudioCaptureOpener {
  return createRecorderCaptureOpener({ spawn: () => child, isInstalled: () => true, platform: 'linux' });
}

describe('the stage sits between the device and every consumer', () => {
  test('"none" is the byte path that shipped: the same frames, the same objects', async () => {
    // Object identity, not just equal values: with suppression off the wrapper must
    // not stand between the opener and the consumer at all.
    const requests: AudioCaptureRequest[] = [];
    const inbound: { deliver: ((frame: Float32Array) => void) | null } = { deliver: null };
    const created = { count: 0 };
    const inner: AudioCaptureOpener = async (request, handlers) => {
      requests.push(request);
      inbound.deliver = handlers.onFrame;
      return { label: 'inner', deviceSelectable: true, stop: async () => {} } satisfies AudioCaptureStream;
    };
    const seen: Float32Array[] = [];
    const opener = createNoiseSuppressingOpener(inner, { create: async () => halvingStage(created) });
    const handlers: AudioCaptureHandlers = { onFrame: (frame) => seen.push(frame), onStopped: () => {} };
    const stream = await opener(RECORDER_REQUEST, handlers);
    expect(stream.label).toBe('inner');
    const frame = new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000);
    inbound.deliver?.(frame);
    expect(seen[0]).toBe(frame);
    expect(created.count).toBe(0);
    expect(requests[0]).toBe(RECORDER_REQUEST);
  });

  test('"speex" filters the frames a consumer sees, and asks the inner opener for raw audio', async () => {
    const requests: AudioCaptureRequest[] = [];
    const created = { count: 0 };
    const child = fakeProcess();
    const inner: AudioCaptureOpener = async (request, handlers) => {
      requests.push(request);
      return recorderOpener(child)(request, handlers);
    };
    const seen: Float32Array[] = [];
    const opener = createNoiseSuppressingOpener(inner, { create: async () => halvingStage(created) });
    await opener(
      { ...RECORDER_REQUEST, noiseSuppression: 'speex' },
      { onFrame: (frame) => seen.push(frame), onStopped: () => {} },
    );
    child.emit(floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000)));
    expect(created.count).toBe(1);
    expect(seen[0]?.[0]).toBe(1500);
    // The inner opener is asked for unfiltered audio, which is exactly what it
    // produces — and is what makes wrapping an already-wrapped opener harmless.
    expect(requests[0]?.noiseSuppression).toBe('none');
  });

  test('wrapping a wrapped opener filters once, not twice', async () => {
    const created = { count: 0 };
    const child = fakeProcess();
    const once = createNoiseSuppressingOpener(recorderOpener(child), { create: async () => halvingStage(created) });
    const twice = createNoiseSuppressingOpener(once, { create: async () => halvingStage(created) });
    const seen: Float32Array[] = [];
    await twice(
      { ...RECORDER_REQUEST, noiseSuppression: 'speex' },
      { onFrame: (frame) => seen.push(frame), onStopped: () => {} },
    );
    child.emit(floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000)));
    expect(created.count).toBe(1);
    expect(seen[0]?.[0]).toBe(1500);
  });

  test('a filter that cannot start refuses the stream instead of opening one', async () => {
    let spawns = 0;
    const opener = createNoiseSuppressingOpener(
      createRecorderCaptureOpener({
        spawn: () => { spawns += 1; return fakeProcess(); },
        isInstalled: () => true,
      }),
      { create: async () => { throw new Error('no WebAssembly here'); } },
    );
    const attempt = opener(
      { ...RECORDER_REQUEST, noiseSuppression: 'speex' },
      { onFrame: () => {}, onStopped: () => {} },
    );
    await expect(attempt).rejects.toThrow(/could not be started: no WebAssembly here/);
    await expect(attempt).rejects.toThrow(/Refusing rather than capturing unfiltered audio/);
    // And the device was never opened: the refusal happens before the recorder.
    expect(spawns).toBe(0);
  });

  test('a stage that fails mid-stream stops capture rather than passing frames on', async () => {
    const child = fakeProcess();
    const stops: Array<{ reason: string; reasonCode: string | undefined }> = [];
    const seen: Float32Array[] = [];
    let calls = 0;
    const opener = createNoiseSuppressingOpener(recorderOpener(child), {
      create: async () => ({
        label: 'fails-on-the-second-frame',
        blockSamples: 1,
        suppressionDb: -15,
        process: (frame) => {
          calls += 1;
          if (calls > 1) throw new Error('the speexdsp filter refused a block');
          return frame;
        },
        close: () => {},
      }),
    });
    await opener(
      { ...RECORDER_REQUEST, noiseSuppression: 'speex' },
      {
        onFrame: (frame) => seen.push(frame),
        onStopped: (reason, error) => stops.push({ reason, reasonCode: error?.reason }),
      },
    );
    const frame = floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000));
    child.emit(frame);
    child.emit(frame);
    child.emit(frame);
    expect(seen).toHaveLength(1);
    expect(stops).toEqual([{ reason: 'failed', reasonCode: 'noise-suppression-unavailable' }]);
  });
});

// ── both consumers, through the real classes ─────────────────────────────────

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

/** An engine that records every frame handed to it, over the real one. */
class RecordingEngine extends WakeWordEngine {
  readonly frames: Float32Array[] = [];

  override async pushFrame(samples: Float32Array): ReturnType<WakeWordEngine['pushFrame']> {
    this.frames.push(samples);
    return super.pushFrame(samples);
  }
}

function alwaysFires(): WakeInferenceSession {
  return {
    inputNames: ['input'],
    outputNames: ['output'],
    run: async () => ({ output: { data: Float32Array.from([1]), dims: [1, 1] } }),
  };
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

describe('both microphone consumers get the filtered audio', () => {
  test('the wake engine scores filtered frames, and so does the utterance after a wake', async () => {
    const settings = resolveWakeRuntimeSettings(
      wakeReader({
        'voice.wake.enabled': true,
        'voice.wake.noiseSuppression': 'speex',
        'voice.wake.captureMaxSeconds': 1,
      }),
      'tui',
      { canRetainAudio: true },
    );
    expect(settings.active).toBe(true);
    expect(settings.capture.noiseSuppression).toBe('speex');

    const child = fakeProcess();
    const created = { count: 0 };
    const utterances: CapturedUtterance[] = [];
    let engine: RecordingEngine | null = null;
    const listener = new WakeListener({
      settings,
      openCapture: recorderOpener(child),
      createNoiseSuppression: async () => halvingStage(created),
      createEngine: async () => {
        engine = new RecordingEngine({
          embedding: stubEmbedding(),
          models: [{ id: 'hey_goodvibes', session: alwaysFires() }],
          tuning: settings.tuning,
          preRollMs: settings.preRollMs,
        });
        return engine;
      },
      handlers: { onUtterance: (utterance) => utterances.push(utterance) },
    });
    const outcome = await listener.start();
    expect(outcome.started).toBe(true);
    expect(created.count).toBe(1);

    // Enough frames to fill the front end, fire, and then run the utterance to its
    // one-second ceiling.
    const frame = floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(3000));
    for (let i = 0; i < 60; i += 1) {
      child.emit(frame);
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    await listener.stop();

    const scored = engine as RecordingEngine | null;
    expect(scored).not.toBeNull();
    expect(scored?.frames.length).toBeGreaterThan(16);
    // Every frame the engine saw was halved. Nothing at 3000 reached it.
    for (const seen of scored?.frames ?? []) expect(seen[0]).toBe(1500);
    expect(utterances.length).toBeGreaterThan(0);
    const utterance = utterances[0];
    expect(utterance).toBeDefined();
    // Including the pre-roll, which comes from the engine's own rolling window and
    // is therefore filtered audio too.
    expect(utterance?.preRollMs).toBeGreaterThan(0);
    expect(Math.round(frameRms(utterance?.samples ?? new Float32Array(0)))).toBe(1500);
  });

  test('push-to-talk records filtered audio, because the row is shared', async () => {
    const child = fakeProcess();
    const created = { count: 0 };
    const session = new PushToTalkSession({
      openCapture: recorderOpener(child),
      createNoiseSuppression: async () => halvingStage(created),
      capture: { device: '', backend: 'parecord', noiseSuppression: 'speex', frameSamples: WAKE_CHUNK_SAMPLES },
      captureMaxSeconds: 10,
    });
    await session.start();
    expect(created.count).toBe(1);
    child.emit(floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(2400)));
    const utterance = await session.stop();
    expect(utterance).not.toBeNull();
    expect(Math.round(frameRms(utterance?.samples ?? new Float32Array(0)))).toBe(1200);
  });

  test('with "none" the same session records exactly what the device produced', async () => {
    const child = fakeProcess();
    const created = { count: 0 };
    const session = new PushToTalkSession({
      openCapture: recorderOpener(child),
      createNoiseSuppression: async () => halvingStage(created),
      capture: { device: '', backend: 'parecord', noiseSuppression: 'none', frameSamples: WAKE_CHUNK_SAMPLES },
      captureMaxSeconds: 10,
    });
    await session.start();
    expect(created.count).toBe(0);
    child.emit(floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(2400)));
    const utterance = await session.stop();
    expect(Math.round(frameRms(utterance?.samples ?? new Float32Array(0)))).toBe(2400);
  });
});
