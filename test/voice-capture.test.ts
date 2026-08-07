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
  VOICE_INPUT_ADAPTIVE_FLOOR_MAX,
  VOICE_INPUT_ADAPTIVE_MARGIN,
  VOICE_INPUT_AMBIENT_FRAME_MS,
  VOICE_INPUT_AMBIENT_MIN_FRAMES,
  estimateAmbientRms,
  resolveSilenceFloorRms,
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

/**
 * Deterministic pseudo-random noise at a target RMS, on the int16 magnitude
 * scale. A constant fill would give every analysis frame an identical level and
 * hide exactly the frame-to-frame scatter the margin exists to clear, so the
 * noise is real noise — just reproducible.
 */
function noise(samples: number, rms: number, seed = 1): Float32Array {
  const out = new Float32Array(samples);
  let state = seed >>> 0;
  for (let i = 0; i < samples; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    // Uniform on [-1, 1), whose RMS is 1/sqrt(3) — scaled up to land on `rms`.
    out[i] = ((state / 0x1_0000_0000) * 2 - 1) * rms * Math.SQRT2 * Math.sqrt(1.5);
  }
  return out;
}

/** A wake pre-roll: room noise, then the wake phrase over the top of it. */
function preRollWithPhrase(ambientRms: number, speechRms: number): Float32Array {
  const window = noise(8000, ambientRms, 7); // 500ms at 16kHz
  const phrase = noise(4800, speechRms, 9); // the last 300ms is the phrase
  window.set(phrase, window.length - phrase.length);
  return window;
}

describe('the silence floor measures the room instead of assuming it', () => {
  test('THE DEFECT: steady room noise above the fixed floor rides every capture to the ceiling', () => {
    // A fan, a compressor, traffic — anything holding the room at 300 RMS, above
    // the fixed 180. No frame is ever silent, so silenceStopMs never accumulates
    // and the capture runs the full ceiling however long ago the speaker stopped.
    const roomRms = 300;
    expect(roomRms).toBeGreaterThan(VOICE_INPUT_SILENCE_RMS);
    const speech = noise(1280, 4000, 3);
    const room = noise(1280, roomRms, 5);

    const fixed = new VoiceInputRecorder({
      captureMaxSeconds: 10,
      silenceStopMs: 1200,
      silenceRms: VOICE_INPUT_SILENCE_RMS,
    });
    for (let i = 0; i < 5; i += 1) expect(fixed.push(speech)).toBeNull();
    // 1200ms of silence is 15 frames of 80ms. Push far past that: none of it
    // reads as silence, so the only thing that ever stops it is the ceiling.
    let fixedStop: string | null = null;
    let fixedFrames = 5;
    while (fixedStop === null && fixedFrames < 200) {
      fixedStop = fixed.push(room);
      fixedFrames += 1;
    }
    expect(fixedStop).toBe('max-duration');
    // 10s / 80ms = 125 frames, not the 20 a working silence-stop would have used.
    expect(fixedFrames).toBe(125);

    // THE FIX: the same room, with the floor measured from the pre-wake audio.
    const floor = resolveSilenceFloorRms({
      ambient: preRollWithPhrase(roomRms, 4000),
      sampleRate: 16_000,
    });
    expect(floor).toBeGreaterThan(roomRms);
    expect(floor).toBeLessThan(4000); // still well under the speaker
    const adaptive = new VoiceInputRecorder({
      captureMaxSeconds: 10,
      silenceStopMs: 1200,
      silenceRms: floor,
    });
    for (let i = 0; i < 5; i += 1) expect(adaptive.push(speech)).toBeNull();
    for (let i = 0; i < 14; i += 1) expect(adaptive.push(room)).toBeNull();
    expect(adaptive.push(room)).toBe('silence');
    // 15 frames after speech stopped = the 1200ms asked for, not 10 seconds.
    expect(adaptive.finish('silence').stopReason).toBe('silence');
  });

  test('a quiet room is left exactly as it was — the floor never drops below the constant', () => {
    // Measuring near-silence could only ever push the floor DOWN, which would
    // start clipping sentences. The lower clamp is what makes adapting safe.
    for (const quiet of [1, 10, 30, 44]) {
      const floor = resolveSilenceFloorRms({
        ambient: noise(8000, quiet, 11),
        sampleRate: 16_000,
      });
      expect(floor).toBe(VOICE_INPUT_SILENCE_RMS);
    }
    // A silent pre-roll is the extreme of the same case.
    expect(resolveSilenceFloorRms({ ambient: new Float32Array(8000), sampleRate: 16_000 }))
      .toBe(VOICE_INPUT_SILENCE_RMS);
  });

  test('an explicitly set floor wins over the measurement, exactly as given', () => {
    const loudRoom = preRollWithPhrase(400, 4000);
    // Above what the room would have produced.
    expect(resolveSilenceFloorRms({ override: 2500, ambient: loudRoom, sampleRate: 16_000 })).toBe(2500);
    // And BELOW it, including below the constant: someone who set a level meant
    // that level, and the clamps that guard the measurement do not apply to it.
    expect(resolveSilenceFloorRms({ override: 40, ambient: loudRoom, sampleRate: 16_000 })).toBe(40);
    expect(40).toBeLessThan(VOICE_INPUT_SILENCE_RMS);
    // 0 is "unset", which is what the schema default carries — it must adapt,
    // not pin the floor at zero and call every frame speech.
    const adapted = resolveSilenceFloorRms({ override: 0, ambient: loudRoom, sampleRate: 16_000 });
    expect(adapted).toBeGreaterThan(VOICE_INPUT_SILENCE_RMS);
  });

  test('with no pre-roll to measure, the constant stands', () => {
    expect(resolveSilenceFloorRms({})).toBe(VOICE_INPUT_SILENCE_RMS);
    expect(resolveSilenceFloorRms({ ambient: new Float32Array(0) })).toBe(VOICE_INPUT_SILENCE_RMS);
    // Too short to be a statistic rather than a coin flip: under 8 frames of
    // 20ms, no estimate is reported at all.
    expect(estimateAmbientRms(noise(2000, 400, 13), 16_000)).toBeNull();
    expect(resolveSilenceFloorRms({ ambient: noise(2000, 400, 13), sampleRate: 16_000 }))
      .toBe(VOICE_INPUT_SILENCE_RMS);
    // At exactly the minimum it does report one.
    const enough = VOICE_INPUT_AMBIENT_MIN_FRAMES * (VOICE_INPUT_AMBIENT_FRAME_MS / 1000) * 16_000;
    expect(estimateAmbientRms(noise(enough, 400, 13), 16_000)).not.toBeNull();
  });

  test('the measurement reads the room inside the phrase, not the speaker', () => {
    // The pre-roll is mostly the wake phrase. A mean would measure the SPEAKER
    // and put the floor over their head; the order statistic finds the room.
    const measured = estimateAmbientRms(preRollWithPhrase(250, 5000), 16_000);
    expect(measured).not.toBeNull();
    expect(measured as number).toBeLessThan(600);
    expect(measured as number).toBeGreaterThan(100);
  });

  test('a room too loud to separate by level is capped rather than set over the speaker', () => {
    // Past the cap the next thing above the floor is the speaker. Clamping keeps
    // the old behaviour (the ceiling ends it) instead of never hearing speech.
    const floor = resolveSilenceFloorRms({ ambient: noise(8000, 3000, 17), sampleRate: 16_000 });
    expect(floor).toBe(VOICE_INPUT_ADAPTIVE_FLOOR_MAX);
    expect(floor).toBe(VOICE_INPUT_SILENCE_RMS * 8);
    // Speech is still heard at the cap, which is the whole point of having one.
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 10, silenceStopMs: 1200, silenceRms: floor });
    recorder.push(noise(1280, 4000, 19));
    expect(recorder.heardSpeech).toBe(true);
  });

  test('the margin is the documented +12 dB over what was measured', () => {
    // Pinning the rule itself: a mid-range room lands on ambient * 4, untouched
    // by either clamp.
    const ambient = noise(16_000, 250, 23);
    const measured = estimateAmbientRms(ambient, 16_000) as number;
    const floor = resolveSilenceFloorRms({ ambient, sampleRate: 16_000 });
    expect(floor).toBeCloseTo(measured * VOICE_INPUT_ADAPTIVE_MARGIN, 6);
    expect(VOICE_INPUT_ADAPTIVE_MARGIN).toBe(4);
    expect(20 * Math.log10(VOICE_INPUT_ADAPTIVE_MARGIN)).toBeCloseTo(12.04, 1);
  });
});

describe('captureMaxSeconds 0 means no ceiling', () => {
  test('a long capture is never cut, and 0 is not read as "stop immediately"', () => {
    // 0 seconds is 0 samples, and a length-vs-0 comparison is true on the very
    // first frame — the failure this has to not have.
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 0, silenceStopMs: 0 });
    const frame = new Float32Array(1280).fill(2000);
    expect(recorder.push(frame)).toBeNull();
    // Four minutes of audio, well past the 120s the schema's own maximum allows.
    for (let i = 0; i < 3000; i += 1) expect(recorder.push(frame)).toBeNull();
    expect(recorder.durationMs).toBeGreaterThan(240_000);
    expect(recorder.finish('requested').stopReason).toBe('requested');
  });

  test('silence still ends an unlimited capture, which is what keeps the mic from staying open', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 0, silenceStopMs: 400 });
    const loud = new Float32Array(1280).fill(4000);
    const silent = new Float32Array(1280);
    expect(recorder.push(loud)).toBeNull();
    for (let i = 0; i < 4; i += 1) expect(recorder.push(silent)).toBeNull();
    expect(recorder.push(silent)).toBe('silence');
  });

  test('a positive ceiling is unchanged by the 0 handling', () => {
    const recorder = new VoiceInputRecorder({ captureMaxSeconds: 1, silenceStopMs: 0 });
    const frame = new Float32Array(1280).fill(500);
    let stop: string | null = null;
    let pushed = 0;
    while (stop === null && pushed < 100) {
      stop = recorder.push(frame);
      pushed += 1;
    }
    expect(stop).toBe('max-duration');
    expect(pushed).toBe(13);
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

  test('this opener does not filter, so driving it directly with speex is refused', async () => {
    // The suppression stage runs one layer up (createNoiseSuppressingOpener, which
    // both consumers apply). A caller reaching past it with `speex` gets a refusal
    // pointing at the wrapper rather than unfiltered audio.
    const child = fakeProcess();
    await expect(
      opener(child)({ ...request, noiseSuppression: 'speex' }, { onFrame: () => {}, onStopped: () => {} }),
    ).rejects.toThrow(/wrap this opener with createNoiseSuppressingOpener/);
  });

  test('speex opens normally once a caller declares it filters these frames itself', async () => {
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
