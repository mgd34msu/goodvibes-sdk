/**
 * wake-word-listener.test.ts — the wake runtime, end to end, with no microphone.
 *
 * This is the chain that did not exist while the engine sat complete and unused:
 * recorder bytes -> frames -> the engine -> a confirmed detection -> the utterance
 * that FOLLOWS it -> the artifact speech-to-text takes. Every test here drives the
 * real {@link WakeListener} and the real {@link WakeWordEngine} over a fake
 * recorder subprocess, and the classifier replays the MEASURED score trace from
 * the shipped model rather than numbers chosen to make a threshold look good.
 *
 * The two assertions that matter most for a microphone:
 *  - a wake does not re-open the device, it switches the SAME stream to recording
 *    the command, seeded with the pre-roll from before the wake fired;
 *  - a disabled feature never opens a device at all — no spawn, no permission
 *    prompt — whether it is off globally or off for this surface.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/wake-word-front-end.json' with { type: 'json' };
import { WakeWordEngine } from '../packages/sdk/src/platform/voice/wake/engine.js';
import { WakeListener } from '../packages/sdk/src/platform/voice/wake/listener.js';
import { resolveWakeRuntimeSettings } from '../packages/sdk/src/platform/voice/wake/settings.js';
import { WAKE_CHUNK_SAMPLES, WAKE_CLASSIFIER_FRAMES, WAKE_EMBED_DIM } from '../packages/sdk/src/platform/voice/wake/feature-pipeline.js';
import { voiceWakeConfigDefaults } from '../packages/sdk/src/platform/config/schema-domain-voice-wake.js';
import {
  createRecorderCaptureOpener,
  floatSamplesToPcm16,
  utteranceToAudioArtifact,
  type AudioCaptureHandlers,
  type CapturedUtterance,
  type CaptureChildProcess,
} from '../packages/sdk/src/platform/voice/capture/index.js';
import type { WakeInferenceSession, WakeTensor } from '../packages/sdk/src/platform/voice/wake/types.js';

const POSITIVE: readonly number[] = fixture.scoreTraces.positive.scores;

/** Config source: the shipped defaults, with a per-test override layer on top. */
function reader(overrides: Readonly<Record<string, unknown>> = {}): (key: string) => unknown {
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

function stubEmbedding(): WakeInferenceSession {
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: async () => ({ embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] } }),
  };
}

/** Replays the measured trace, one score per classifier call. */
function replayClassifier(scores: readonly number[]): WakeInferenceSession & { calls: number } {
  const session = {
    calls: 0,
    inputNames: ['onnx::Flatten_0'],
    outputNames: ['output'],
    run: async (_feeds: Readonly<Record<string, WakeTensor>>) => {
      const value = scores[session.calls] ?? 0;
      session.calls += 1;
      return { output: { data: Float32Array.from([value]), dims: [1, 1] } };
    },
  };
  return session;
}

function fakeProcess(): CaptureChildProcess & {
  emit(bytes: Uint8Array): void;
  close(code: number | null): void;
  readonly signals: string[];
} {
  const data: Array<(chunk: Uint8Array) => void> = [];
  const closed: Array<(code: number | null, signal: string | null) => void> = [];
  const signals: string[] = [];
  return {
    signals,
    stdout: { on: (_e: 'data', l: (chunk: Uint8Array) => void) => data.push(l) },
    stderr: { on: () => undefined },
    on(event: 'error' | 'close', listener: never) {
      if (event === 'close') closed.push(listener as unknown as (c: number | null, s: string | null) => void);
      return this;
    },
    kill(signal?: string) { signals.push(signal ?? 'SIGTERM'); return true; },
    emit: (bytes) => { for (const l of data) l(bytes); },
    close: (code) => { for (const l of closed) l(code, null); },
  };
}

/** One frame of s16le bytes at a magnitude. */
function frameBytes(magnitude: number): Uint8Array {
  return floatSamplesToPcm16(new Float32Array(WAKE_CHUNK_SAMPLES).fill(magnitude));
}

/** Let the listener's inference chain settle between frames. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly listener: WakeListener;
  readonly child: ReturnType<typeof fakeProcess>;
  readonly spawns: number[];
  readonly wakes: number[];
  readonly utterances: CapturedUtterance[];
  readonly failures: Array<{ reason: string; restarting: boolean; detail: string }>;
  readonly engine: () => WakeWordEngine | null;
  readonly classifierCalls: () => number;
  readonly timers: Array<{ handler: () => void; ms: number }>;
}

function harness(
  overrides: Readonly<Record<string, unknown>> = {},
  options: { scores?: readonly number[]; children?: Array<ReturnType<typeof fakeProcess>> } = {},
): Harness {
  const settings = resolveWakeRuntimeSettings(reader(overrides), 'tui', {
    canRetainAudio: true,
    canPlayLocalFile: true,
  });
  const child = options.children?.[0] ?? fakeProcess();
  const children = options.children ?? [child];
  const spawns: number[] = [];
  const classifier = replayClassifier(options.scores ?? POSITIVE);
  let engine: WakeWordEngine | null = null;
  const wakes: number[] = [];
  const utterances: CapturedUtterance[] = [];
  const failures: Array<{ reason: string; restarting: boolean; detail: string }> = [];
  const timers: Array<{ handler: () => void; ms: number }> = [];
  const listener = new WakeListener({
    settings,
    openCapture: createRecorderCaptureOpener({
      spawn: () => {
        const next = children[spawns.length] ?? children[children.length - 1]!;
        spawns.push(spawns.length);
        return next;
      },
      isInstalled: () => true,
      platform: 'linux',
    }),
    createEngine: async () => {
      engine = new WakeWordEngine({
        embedding: stubEmbedding(),
        models: [{ id: 'hey_goodvibes', session: classifier }],
        tuning: settings.tuning,
        preRollMs: settings.preRollMs,
      });
      return engine;
    },
    handlers: {
      onWake: (event) => wakes.push(event.detection.at),
      onUtterance: (utterance) => utterances.push(utterance),
      onFailure: (error, restarting, detail) => failures.push({ reason: error.reason, restarting, detail }),
    },
    setTimeout: (handler, ms) => { timers.push({ handler, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  return {
    listener, child, spawns, wakes, utterances, failures, timers,
    engine: () => engine,
    classifierCalls: () => classifier.calls,
  };
}

describe('a disabled feature never opens a device', () => {
  test('voice.wake.enabled off: no spawn, no permission prompt, and a stated reason', async () => {
    const h = harness({ 'voice.wake.enabled': false });
    const outcome = await h.listener.start();
    expect(outcome.started).toBe(false);
    expect(outcome.started === false && outcome.refusal).toBe('disabled');
    expect(outcome.started === false && outcome.detail).toContain('no microphone is opened');
    expect(h.spawns).toHaveLength(0);
  });

  test('voice.wake.surfaces.tui off: enabled globally, still no device on this surface', async () => {
    const h = harness({ 'voice.wake.enabled': true, 'voice.wake.surfaces.tui': false });
    const outcome = await h.listener.start();
    expect(outcome.started === false && outcome.refusal).toBe('surface-disabled');
    expect(h.spawns).toHaveLength(0);
  });

  test('a blocking row refuses before capture: vadThreshold has no VAD model to run', async () => {
    const h = harness({ 'voice.wake.enabled': true, 'voice.wake.vadThreshold': 0.5 });
    const outcome = await h.listener.start();
    expect(outcome.started === false && outcome.refusal).toBe('blocked');
    expect(outcome.started === false && outcome.detail).toContain('voice.wake.vadThreshold');
    expect(h.spawns).toHaveLength(0);
  });

  test('the shipped defaults are off, so nothing listens until someone says so', async () => {
    const h = harness();
    expect((await h.listener.start()).started).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });
});

describe('recorder bytes reach the engine and a measured positive fires', () => {
  test('the whole chain: bytes -> frames -> detection -> the utterance after it', async () => {
    const h = harness({
      'voice.wake.enabled': true,
      'voice.wake.silenceStopMs': 400,
      'voice.wake.captureMaxSeconds': 3,
    });
    const outcome = await h.listener.start();
    expect(outcome.started).toBe(true);
    expect(h.spawns).toHaveLength(1);
    expect(h.listener.state().phase).toBe('listening');
    // `auto` probes in order, so the label names what actually opened, not "auto".
    expect(h.listener.state().deviceLabel).toBe('pw-record (auto)');

    // Feed the trace. The front end scores for the first time on the frame that
    // completes its 16-frame window, so the trace needs that many extra frames.
    for (let i = 0; i < POSITIVE.length + WAKE_CLASSIFIER_FRAMES; i += 1) {
      h.child.emit(frameBytes(1200));
      await settle();
      if (h.wakes.length > 0) break;
    }
    expect(h.wakes).toHaveLength(1);
    expect(h.classifierCalls()).toBeGreaterThan(0);
    // The device was NOT re-opened for the command: same stream, now recording.
    expect(h.spawns).toHaveLength(1);
    expect(h.listener.state().phase).toBe('capturing-utterance');

    // Speak, then stop: 5 loud frames then 5 silent ones trips the 400ms silence rule.
    for (let i = 0; i < 5; i += 1) { h.child.emit(frameBytes(6000)); await settle(); }
    for (let i = 0; i < 6 && h.utterances.length === 0; i += 1) { h.child.emit(frameBytes(0)); await settle(); }

    expect(h.utterances).toHaveLength(1);
    const utterance = h.utterances[0]!;
    expect(utterance.stopReason).toBe('silence');
    expect(utterance.silent).toBe(false);
    // Pre-roll from BEFORE the wake is prepended, per voice.wake.preRollMs.
    expect(utterance.preRollMs).toBeGreaterThan(0);
    expect(utterance.samples.length).toBeGreaterThan(5 * WAKE_CHUNK_SAMPLES);
    // And it is ready for the speech-to-text verb without further work.
    const artifact = utteranceToAudioArtifact(utterance);
    expect(artifact.format).toBe('wav');
    expect(artifact.dataBase64.length).toBeGreaterThan(100);
    // Listening resumes on the same stream once the command is captured.
    expect(h.listener.state().phase).toBe('listening');
    expect(h.listener.state().lastWakeAt).not.toBeNull();
  });

  test('scoring pauses while the command is being recorded, so the command is not scored as a wake', async () => {
    const h = harness({ 'voice.wake.enabled': true, 'voice.wake.captureMaxSeconds': 30, 'voice.wake.silenceStopMs': 0 });
    await h.listener.start();
    for (let i = 0; i < POSITIVE.length + WAKE_CLASSIFIER_FRAMES && h.wakes.length === 0; i += 1) {
      h.child.emit(frameBytes(1200));
      await settle();
    }
    expect(h.wakes).toHaveLength(1);
    const callsAtWake = h.classifierCalls();
    const framesAtWake = h.engine()?.framesSeen ?? 0;
    for (let i = 0; i < 10; i += 1) { h.child.emit(frameBytes(6000)); await settle(); }
    expect(h.classifierCalls()).toBe(callsAtWake);
    expect(h.engine()?.framesSeen).toBe(framesAtWake);
  });

  test('a trace that never crosses the threshold produces nothing', async () => {
    const flat = new Array<number>(60).fill(0.2);
    const h = harness({ 'voice.wake.enabled': true }, { scores: flat });
    await h.listener.start();
    for (let i = 0; i < flat.length + WAKE_CLASSIFIER_FRAMES; i += 1) {
      h.child.emit(frameBytes(1200));
      await settle();
    }
    expect(h.wakes).toHaveLength(0);
    expect(h.utterances).toHaveLength(0);
    expect(h.classifierCalls()).toBeGreaterThan(0);
  });
});

describe('a stream that dies is a restart decision, not a silent stop', () => {
  test('a recorder that exits is restarted after the configured backoff', async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const h = harness(
      { 'voice.wake.enabled': true, 'voice.wake.restartBackoffMs': 2000 },
      { children: [first, second] },
    );
    await h.listener.start();
    expect(h.spawns).toHaveLength(1);
    first.close(1);
    await settle();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]?.restarting).toBe(true);
    expect(h.listener.state().phase).toBe('restarting');
    // Linear backoff: attempt 1 waits one base delay.
    expect(h.timers.at(-1)?.ms).toBe(2000);
    h.timers.at(-1)?.handler();
    await settle();
    await settle();
    expect(h.spawns).toHaveLength(2);
    expect(h.listener.state().phase).toBe('listening');
  });

  test('exceeding maxRestarts inside the window latches off with a reason a user can read', async () => {
    const children = [fakeProcess(), fakeProcess(), fakeProcess()];
    const h = harness(
      { 'voice.wake.enabled': true, 'voice.wake.maxRestarts': 1, 'voice.wake.restartBackoffMs': 10 },
      { children },
    );
    await h.listener.start();
    children[0]!.close(1);
    await settle();
    expect(h.failures[0]?.restarting).toBe(true);
    h.timers.at(-1)?.handler();
    await settle();
    await settle();
    children[1]!.close(1);
    await settle();
    expect(h.failures).toHaveLength(2);
    expect(h.failures[1]?.restarting).toBe(false);
    expect(h.failures[1]?.detail).toContain('crashed');
    expect(h.listener.state().phase).toBe('latched');
    expect(h.listener.state().latchReason).toContain('will not be restarted');
    // A latched detector refuses to start again until the latch is cleared —
    // which is the deliberate act of turning the feature off and on.
    const refused = await h.listener.start();
    expect(refused.started).toBe(false);
    h.listener.clearLatch();
    expect(h.listener.state().latchReason).toBeNull();
  });

  test('a command in flight when the device dies is still delivered, not thrown away', async () => {
    const h = harness({ 'voice.wake.enabled': true, 'voice.wake.captureMaxSeconds': 30, 'voice.wake.silenceStopMs': 0 });
    await h.listener.start();
    for (let i = 0; i < POSITIVE.length + WAKE_CLASSIFIER_FRAMES && h.wakes.length === 0; i += 1) {
      h.child.emit(frameBytes(1200));
      await settle();
    }
    expect(h.wakes).toHaveLength(1);
    h.child.emit(frameBytes(6000));
    await settle();
    h.child.close(1);
    await settle();
    expect(h.utterances).toHaveLength(1);
    expect(h.utterances[0]?.stopReason).toBe('stream-ended');
  });

  test('a deliberate stop releases the device and is not counted as a crash', async () => {
    const h = harness({ 'voice.wake.enabled': true });
    await h.listener.start();
    const stopping = h.listener.stop();
    h.child.close(null);
    await stopping;
    expect(h.child.signals).toContain('SIGTERM');
    expect(h.failures).toHaveLength(0);
    expect(h.listener.state().phase).toBe('stopped');
    expect(h.listener.state().restarts).toBe(0);
  });
});
