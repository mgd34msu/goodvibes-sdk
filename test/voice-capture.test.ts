/**
 * voice-capture.test.ts — the capture path both voice consumers share.
 *
 * Every assertion here covers a failure that is SILENT rather than loud, which is
 * why they are worth pinning:
 *
 *  - a recorder's stdout arrives in sizes that have nothing to do with a frame,
 *    and mis-cutting frames does not error — it shifts the front end off the
 *    framing the classifier was trained at and the detector simply never fires;
 *  - int16 magnitudes vs normalised -1..1 audio look identical in a buffer and
 *    score two orders of magnitude apart;
 *  - `pw-record` without `--container raw` writes a container header before the
 *    samples, byte-misaligning the whole stream (checked against the real tool:
 *    the first bytes are a header without the flag and pure PCM with it);
 *  - a microphone left open after a failed transcription is the bug users notice
 *    and never report precisely.
 */
import { describe, expect, test } from 'bun:test';
import {
  AudioCaptureError,
  AudioFrameSlicer,
  bytesToBase64,
  buildRecorderCommand,
  concatSamples,
  createRecorderCaptureOpener,
  encodeWavPcm16,
  floatSamplesToPcm16,
  frameRms,
  PushToTalkSession,
  pcm16ToFloatSamples,
  RECORDER_PROBE_ORDER,
  resolveRecorderCommand,
  utteranceToAudioArtifact,
  VoiceInputRecorder,
  VOICE_INPUT_SILENCE_RMS,
  type AudioCaptureHandlers,
  type CaptureChildProcess,
} from '../packages/sdk/src/platform/voice/capture/index.js';

/** A recorder subprocess stand-in the test drives byte by byte. */
function fakeProcess(): CaptureChildProcess & {
  emit(bytes: Uint8Array): void;
  emitStderr(text: string): void;
  close(code: number | null): void;
  fail(error: Error): void;
  readonly signals: string[];
} {
  const dataListeners: Array<(chunk: Uint8Array) => void> = [];
  const stderrListeners: Array<(chunk: Uint8Array) => void> = [];
  const closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const signals: string[] = [];
  return {
    signals,
    stdout: { on: (_event: 'data', listener: (chunk: Uint8Array) => void) => dataListeners.push(listener) },
    stderr: { on: (_event: 'data', listener: (chunk: Uint8Array) => void) => stderrListeners.push(listener) },
    on(event: 'error' | 'close', listener: never) {
      if (event === 'error') errorListeners.push(listener as unknown as (error: Error) => void);
      else closeListeners.push(listener as unknown as (code: number | null, signal: string | null) => void);
      return this;
    },
    kill(signal?: string) {
      signals.push(signal ?? 'SIGTERM');
      return true;
    },
    emit: (bytes) => { for (const l of dataListeners) l(bytes); },
    emitStderr: (text) => { for (const l of stderrListeners) l(new TextEncoder().encode(text)); },
    close: (code) => { for (const l of closeListeners) l(code, null); },
    fail: (error) => { for (const l of errorListeners) l(error); },
  };
}

/** s16le bytes for a run of samples at one magnitude. */
function pcmBytes(count: number, magnitude: number): Uint8Array {
  return floatSamplesToPcm16(new Float32Array(count).fill(magnitude));
}

describe('framing: a recorder chunk has nothing to do with a frame size', () => {
  test('misaligned chunks still produce exact frames, and the remainder is carried not dropped', () => {
    const slicer = new AudioFrameSlicer(1280);
    // 700-sample chunks against a 1280-sample frame: every boundary falls mid-chunk.
    let emitted = 0;
    const seen: Float32Array[] = [];
    for (let i = 0; i < 10; i += 1) {
      const chunk = new Float32Array(700);
      for (let s = 0; s < chunk.length; s += 1) chunk[s] = i * 700 + s;
      const frames = slicer.push(chunk);
      emitted += frames.length;
      seen.push(...frames);
    }
    // 7000 samples in => 5 whole frames out, 600 carried.
    expect(emitted).toBe(5);
    expect(slicer.pendingSamples).toBe(600);
    for (const frame of seen) expect(frame.length).toBe(1280);
    // The stream is continuous across every boundary: sample n has value n.
    const flat = concatSamples(seen);
    expect(flat.length).toBe(6400);
    for (let i = 0; i < flat.length; i += 1) expect(flat[i]).toBe(i);
  });

  test('a frame is its own buffer, so a consumer may retain it', () => {
    const slicer = new AudioFrameSlicer(4);
    const [first] = slicer.push(Float32Array.from([1, 2, 3, 4]));
    slicer.push(Float32Array.from([9, 9, 9, 9]));
    expect(Array.from(first ?? [])).toEqual([1, 2, 3, 4]);
  });

  test('reset drops the carried remainder, as a restarted stream requires', () => {
    const slicer = new AudioFrameSlicer(4);
    slicer.push(Float32Array.from([1, 2]));
    expect(slicer.pendingSamples).toBe(2);
    slicer.reset();
    expect(slicer.pendingSamples).toBe(0);
    expect(slicer.push(Float32Array.from([1, 2, 3, 4])).length).toBe(1);
  });
});

describe('sample scale: int16 magnitudes, not normalised audio', () => {
  test('decoding produces magnitudes on the int16 scale, negatives included', () => {
    // -1, 0, 1, 32767, -32768 as little-endian int16.
    const bytes = Uint8Array.from([0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    expect(Array.from(pcm16ToFloatSamples(bytes))).toEqual([-1, 0, 1, 32767, -32768]);
  });

  test('an odd trailing byte is not turned into a bogus sample', () => {
    expect(pcm16ToFloatSamples(Uint8Array.from([0x01, 0x00, 0x7f])).length).toBe(1);
  });

  test('encode round-trips and clamps rather than wrapping', () => {
    const round = pcm16ToFloatSamples(floatSamplesToPcm16(Float32Array.from([0, -1, 1, 300, -300])));
    expect(Array.from(round)).toEqual([0, -1, 1, 300, -300]);
    const clamped = pcm16ToFloatSamples(floatSamplesToPcm16(Float32Array.from([99999, -99999])));
    expect(Array.from(clamped)).toEqual([32767, -32768]);
  });

  test('rms is on the same scale the silence floor is written in', () => {
    expect(frameRms(new Float32Array(100))).toBe(0);
    expect(frameRms(new Float32Array(100).fill(1000))).toBeCloseTo(1000, 5);
    expect(VOICE_INPUT_SILENCE_RMS).toBeLessThan(1000);
  });
});

describe('the wav container speech-to-text receives', () => {
  test('the header says what the data is, little-endian, with a true length', () => {
    const wav = encodeWavPcm16(Float32Array.from([0, 1, -1]), 16_000);
    const text = new TextDecoder().decode(wav.subarray(0, 4));
    expect(text).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(new TextDecoder().decode(wav.subarray(12, 16))).toBe('fmt ');
    expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe('data');
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(6); // 3 samples * 2 bytes
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + 6);
  });

  test('base64 matches the platform encoder, padding included', () => {
    for (const input of [[], [0], [0, 1], [0, 1, 2], [255, 254, 253, 252], [77]]) {
      const bytes = Uint8Array.from(input);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  test('an utterance becomes the artifact the voice.stt verb takes', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 0 });
    recorder.push(new Float32Array(16_000).fill(1000));
    const artifact = utteranceToAudioArtifact(recorder.finish('requested'));
    expect(artifact.mimeType).toBe('audio/wav');
    expect(artifact.format).toBe('wav');
    expect(artifact.sampleRateHz).toBe(16_000);
    expect(artifact.durationMs).toBe(1000);
    expect(Buffer.from(artifact.dataBase64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });
});

describe('the utterance policy', () => {
  test('silence ends it only after speech was heard, so a slow start is not cut', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 400 });
    const silent = new Float32Array(1280);
    const loud = new Float32Array(1280).fill(4000);
    // 1.6s of leading silence must NOT stop it: nobody has spoken yet.
    for (let i = 0; i < 20; i += 1) expect(recorder.push(silent)).toBeNull();
    expect(recorder.heardSpeech).toBe(false);
    expect(recorder.push(loud)).toBeNull();
    expect(recorder.heardSpeech).toBe(true);
    // 400ms of silence = 5 frames of 80ms; the fifth trips it.
    for (let i = 0; i < 4; i += 1) expect(recorder.push(silent)).toBeNull();
    expect(recorder.push(silent)).toBe('silence');
    expect(recorder.finish('silence').stopReason).toBe('silence');
  });

  test('the ceiling stops it, and the frame that tripped it is kept', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 1, silenceStopMs: 0 });
    const frame = new Float32Array(1280).fill(500);
    let stop: string | null = null;
    let pushed = 0;
    while (stop === null && pushed < 100) {
      stop = recorder.push(frame);
      pushed += 1;
    }
    expect(stop).toBe('max-duration');
    // 16000 samples / 1280 = 12.5 frames, so the 13th trips it and is retained.
    expect(pushed).toBe(13);
    const utterance = recorder.finish('max-duration');
    expect(utterance.samples.length).toBe(13 * 1280);
  });

  test('pre-roll is prepended and reported, so a phrase run into the command is not clipped', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 0 });
    recorder.seedPreRoll(new Float32Array(8000).fill(100)); // 500ms
    recorder.push(new Float32Array(1280).fill(200));
    const utterance = recorder.finish('requested');
    expect(utterance.preRollMs).toBe(500);
    expect(utterance.samples.length).toBe(8000 + 1280);
    expect(utterance.samples[0]).toBe(100);
    expect(utterance.samples[8000]).toBe(200);
  });

  test('pre-roll after frames is refused rather than silently misordering audio', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 0 });
    recorder.push(new Float32Array(1280));
    expect(() => recorder.seedPreRoll(new Float32Array(10))).toThrow(/before frames are pushed/);
  });

  test('an all-silent capture is reported as silent instead of sent as a transcript', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 0 });
    for (let i = 0; i < 5; i += 1) recorder.push(new Float32Array(1280));
    expect(recorder.finish('requested').silent).toBe(true);
  });
});

describe('the recorder command line, against what the real tools accept', () => {
  test('pw-record carries --container raw, without which the stream is byte-misaligned', () => {
    const built = buildRecorderCommand('pw-record', { device: '53' });
    expect(built.command).toBe('pw-record');
    expect(built.args).toContain('--container');
    expect(built.args[built.args.indexOf('--container') + 1]).toBe('raw');
    expect(built.args).toContain('--target');
    expect(built.args[built.args.indexOf('--target') + 1]).toBe('53');
    expect(built.args).toContain('s16');
    expect(built.args.at(-1)).toBe('-');
  });

  test('parecord writes raw to stdout, and takes its device as one --device= argument', () => {
    const built = buildRecorderCommand('parecord', { device: 'alsa_input.pci-0000_00_1f.3.analog-stereo' });
    expect(built.args).toContain('--raw');
    expect(built.args).toContain('--rate=16000');
    expect(built.args).toContain('--channels=1');
    expect(built.args).toContain('--format=s16le');
    expect(built.args).toContain('--device=alsa_input.pci-0000_00_1f.3.analog-stereo');
  });

  test('arecord asks for raw S16_LE and takes -D', () => {
    const built = buildRecorderCommand('arecord', { device: 'pulse' });
    expect(built.args).toEqual(['-q', '-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-D', 'pulse']);
  });

  test('ffmpeg input format follows the platform, because one argv cannot serve three', () => {
    expect(buildRecorderCommand('ffmpeg', { platform: 'linux' }).args).toContain('pulse');
    expect(buildRecorderCommand('ffmpeg', { platform: 'darwin' }).args).toContain('avfoundation');
    expect(buildRecorderCommand('ffmpeg', { platform: 'win32' }).args).toContain('dshow');
    expect(buildRecorderCommand('ffmpeg', { platform: 'linux', device: 'mymic' }).args).toContain('mymic');
  });

  test('sox reports that it cannot target a device instead of pretending to', () => {
    const built = buildRecorderCommand('sox', { device: 'mymic' });
    expect(built.deviceSelectable).toBe(false);
    expect(built.args.join(' ')).not.toContain('mymic');
    expect(buildRecorderCommand('parecord', {}).deviceSelectable).toBe(true);
  });

  test('every backend asks for the same 16 kHz mono signed-16-bit stream', () => {
    for (const backend of RECORDER_PROBE_ORDER) {
      const joined = buildRecorderCommand(backend, {}).args.join(' ');
      expect(joined).toContain('16000');
      // Each tool spells the format its own way — sox takes a bit depth and an
      // encoding rather than a format name — so the shape is checked per tool
      // instead of grepping for one spelling that only some of them use.
      expect(joined).toMatch(/s16|S16|-b 16 -e signed-integer/);
      // Mono, again spelled per tool: --channels 1, --channels=1, -c 1, -ac 1.
      expect(joined).toMatch(/--channels[= ]1|-c 1|-ac 1/);
    }
  });

  test('auto uses the first installed recorder in probe order', () => {
    const installed = new Set(['arecord', 'sox']);
    const resolved = resolveRecorderCommand('auto', { isInstalled: (c) => installed.has(c) });
    expect(resolved?.backend).toBe('arecord');
    expect(resolved?.label).toContain('auto');
  });

  test('auto with nothing installed resolves to null, which is a reportable state', () => {
    expect(resolveRecorderCommand('auto', { isInstalled: () => false })).toBeNull();
  });

  test('a NAMED backend that is missing does not silently fall back — pinning it was the point', () => {
    const resolved = resolveRecorderCommand('pw-record', { isInstalled: (c) => c === 'parecord' });
    expect(resolved).toBeNull();
  });
});

describe('the recorder capture stream', () => {
  const request = { frameSamples: 1280, device: '', backend: 'parecord' as const, noiseSuppression: 'none' as const };

  function opener(child: CaptureChildProcess, overrides: { speexAvailable?: boolean } = {}) {
    return createRecorderCaptureOpener({
      spawn: () => child,
      isInstalled: () => true,
      platform: 'linux',
      ...overrides,
    });
  }

  test('bytes become frames the engine can take, at exactly the frame size', async () => {
    const child = fakeProcess();
    const frames: Float32Array[] = [];
    const handlers: AudioCaptureHandlers = { onFrame: (f) => frames.push(f), onStopped: () => {} };
    const stream = await opener(child)(request, handlers);
    expect(stream.label).toBe('parecord');
    // 3000 samples in two ragged writes: two whole frames, 440 carried.
    child.emit(pcmBytes(1700, 800));
    child.emit(pcmBytes(1300, 800));
    expect(frames.length).toBe(2);
    for (const frame of frames) expect(frame.length).toBe(1280);
    expect(frames[0]?.[0]).toBe(800);
  });

  test('a recorder that exits on its own is a failure the restart policy can act on', async () => {
    const child = fakeProcess();
    const stops: Array<{ reason: string; message: string | undefined }> = [];
    await opener(child)(request, {
      onFrame: () => {},
      onStopped: (reason, error) => stops.push({ reason, message: error?.message }),
    });
    child.close(0);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.reason).toBe('failed');
    expect(stops[0]?.message).toContain('exited on its own');
  });

  test('a device error in stderr is classified, not dumped as a generic failure', async () => {
    const child = fakeProcess();
    let captured: AudioCaptureError | undefined;
    await opener(child)(request, {
      onFrame: () => {},
      onStopped: (_reason, error) => { captured = error; },
    });
    child.emitStderr('stream node 56 error: no target node available');
    child.close(1);
    expect(captured?.reason).toBe('device-unavailable');
  });

  test('a permission refusal is its own reason, because the remedy is different', async () => {
    const child = fakeProcess();
    let captured: AudioCaptureError | undefined;
    await opener(child)(request, { onFrame: () => {}, onStopped: (_r, e) => { captured = e; } });
    child.emitStderr('arecord: main:850: audio open error: Permission denied');
    child.close(1);
    expect(captured?.reason).toBe('permission-denied');
  });

  test('stopping kills the recorder and reports the stop as requested, not as a crash', async () => {
    const child = fakeProcess();
    const stops: string[] = [];
    const stream = await opener(child)(request, { onFrame: () => {}, onStopped: (r) => stops.push(r) });
    const stopping = stream.stop();
    child.close(null); // the process goes as asked
    await stopping;
    expect(child.signals).toContain('SIGTERM');
    expect(stops).toEqual(['requested']);
  });

  test('speex is refused while no surface implements it, never run unfiltered', async () => {
    const child = fakeProcess();
    await expect(
      opener(child)({ ...request, noiseSuppression: 'speex' }, { onFrame: () => {}, onStopped: () => {} }),
    ).rejects.toThrow(/applies no speex suppression/);
  });

  test('speex opens normally once a host declares it actually applies the stage', async () => {
    const child = fakeProcess();
    const stream = await opener(child, { speexAvailable: true })(
      { ...request, noiseSuppression: 'speex' },
      { onFrame: () => {}, onStopped: () => {} },
    );
    expect(stream.label).toBe('parecord');
  });

  test('no recorder installed rejects with the reason and never spawns', async () => {
    let spawns = 0;
    const open = createRecorderCaptureOpener({
      spawn: () => { spawns += 1; return fakeProcess(); },
      isInstalled: () => false,
    });
    await expect(open({ ...request, backend: 'auto' }, { onFrame: () => {}, onStopped: () => {} }))
      .rejects.toThrow(/no audio recorder is installed/);
    expect(spawns).toBe(0);
  });
});

describe('push-to-talk voice input', () => {
  const capture = { device: '', backend: 'parecord' as const, noiseSuppression: 'none' as const, frameSamples: 1280 };

  test('a press, some speech and a release produce one utterance and release the device', async () => {
    const child = fakeProcess();
    const phases: string[] = [];
    const session = new PushToTalkSession({
      openCapture: createRecorderCaptureOpener({ spawn: () => child, isInstalled: () => true }),
      capture,
      captureMaxSeconds: 10,
      onPhaseChange: (phase) => phases.push(phase),
    });
    await session.start();
    expect(session.phase).toBe('recording');
    expect(session.deviceLabel).toBe('parecord');
    child.emit(pcmBytes(1280 * 5, 3000));
    const stopping = session.stop();
    child.close(null);
    const utterance = await stopping;
    expect(utterance?.samples.length).toBe(1280 * 5);
    expect(utterance?.silent).toBe(false);
    expect(utterance?.stopReason).toBe('requested');
    expect(child.signals).toContain('SIGTERM');
    expect(phases).toEqual(['requesting', 'recording', 'stopping', 'idle']);
  });

  test('the ceiling stops a held key that never came back up, and announces it', async () => {
    const child = fakeProcess();
    const auto: number[] = [];
    const session = new PushToTalkSession({
      openCapture: createRecorderCaptureOpener({ spawn: () => child, isInstalled: () => true }),
      capture,
      captureMaxSeconds: 1,
      onAutoStop: (utterance) => auto.push(utterance.samples.length),
    });
    await session.start();
    child.emit(pcmBytes(1280 * 13, 3000));
    child.close(null);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(auto).toHaveLength(1);
    expect(session.phase).toBe('idle');
  });

  test('stop with nothing recording is a no-op, not an error', async () => {
    const session = new PushToTalkSession({
      openCapture: createRecorderCaptureOpener({ spawn: () => fakeProcess(), isInstalled: () => true }),
      capture,
      captureMaxSeconds: 10,
    });
    expect(await session.stop()).toBeNull();
  });

  test('a failure to open reports the reason and leaves nothing open', async () => {
    const errors: string[] = [];
    const session = new PushToTalkSession({
      openCapture: createRecorderCaptureOpener({ spawn: () => fakeProcess(), isInstalled: () => false }),
      capture,
      captureMaxSeconds: 10,
      onError: (error) => errors.push(error.reason),
    });
    await expect(session.start()).rejects.toThrow(AudioCaptureError);
    expect(errors).toEqual(['no-recorder']);
    expect(session.phase).toBe('error');
    expect(session.deviceLabel).toBeNull();
  });

  test('cancel releases the device and keeps nothing', async () => {
    const child = fakeProcess();
    const session = new PushToTalkSession({
      openCapture: createRecorderCaptureOpener({ spawn: () => child, isInstalled: () => true }),
      capture,
      captureMaxSeconds: 10,
    });
    await session.start();
    child.emit(pcmBytes(1280, 3000));
    const cancelling = session.cancel();
    child.close(null);
    await cancelling;
    expect(child.signals).toContain('SIGTERM');
    expect(session.phase).toBe('idle');
    expect(await session.stop()).toBeNull();
  });
});
