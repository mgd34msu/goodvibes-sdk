import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '../packages/sdk/src/events/turn.js';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '../packages/sdk/src/platform/voice/types.js';
import { SpokenTurnController } from '../packages/sdk/src/platform/voice/spoken-turn/controller.js';
import type { AudioSink } from '../packages/sdk/src/platform/voice/spoken-turn/audio-sink.js';

/**
 * These tests pin the AudioSink BEHAVIORAL CONTRACT (readiness / head survival,
 * natural drain, abort cut, bounded waitForDrain) from the policy engine's
 * point of view — the guarantees the controller relies on and that a real sink
 * (the subprocess player, the browser Web Audio sink) must honor. The
 * subprocess-level implementation of the head gate and drain lives with the
 * consumer's sink and is pinned by that consumer's player-playback tests; here
 * we prove the controller depends only on the contract, using a conformant
 * fake sink.
 */

function turn(event: TurnEvent): TurnEvent {
  return event;
}

async function* multiByteChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  // Emit one byte per character so a mid-stream abort is observable at a fine
  // grain — a real MP3 stream arrives as many small chunks.
  const bytes = new TextEncoder().encode(text);
  let sequence = 0;
  for (const b of bytes) {
    sequence += 1;
    yield { data: new Uint8Array([b]), sequence, format: 'mp3' };
  }
}

function voiceServiceFor(makeChunks: (text: string) => AsyncIterable<VoiceAudioChunk>) {
  return {
    async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      return {
        providerId: providerId ?? 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: makeChunks(request.text),
        metadata: {},
      };
    },
  };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AudioSink contract — readiness / head survival', () => {
  test('a sink that delays its internal readiness still plays every byte in order (no head loss)', async () => {
    const received: number[] = [];
    let readinessOpened = false;

    const sink: AudioSink = {
      label: 'delayed-readiness',
      available: true,
      async play(chunks, options) {
        // Contract 1: hold the head until the output is actually up. Model a
        // startup that resolves on a later tick; the controller has already
        // handed us the whole stream and only awaits this play().
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        readinessOpened = true;
        for await (const chunk of chunks) {
          if (options.signal?.aborted) break;
          received.push(...chunk.data);
        }
      },
      stop() {},
      async waitForDrain() {},
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('greeting')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'r1', prompt: 'greeting' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'r1', content: 'Hello.', accumulated: 'Hello.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'r1', response: 'Hello.', stopReason: 'completed' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readinessOpened).toBe(true);
    // Every byte survived, in order — including the leading 'H'.
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe('Hello.');
  });
});

describe('AudioSink contract — abort cuts immediately', () => {
  test('a deliberate stop cuts the currently-playing sink mid-stream before the bytes finish', async () => {
    // The chunk that is actively playing has already been removed from the
    // controller's abort set (its signal is released before playback begins),
    // so a deliberate stop cuts it through sink.stop() — the imperative
    // instant-cut half of the contract — not through the signal. (The signal
    // path short-circuits only queued chunks that have not started playing.)
    const received: number[] = [];
    let stopped = false;
    let sawStopCut = false;
    let gateReleased!: () => void;
    const gate = new Promise<void>((resolve) => { gateReleased = resolve; });

    const sink: AudioSink = {
      label: 'stoppable',
      available: true,
      async play(chunks, options) {
        let count = 0;
        for await (const chunk of chunks) {
          if (stopped || options.signal?.aborted) { sawStopCut = true; return; }
          received.push(...chunk.data);
          count += 1;
          // After the first byte, pause until the test releases the gate; the
          // deliberate stop lands during this pause.
          if (count === 1) await gate;
          if (stopped || options.signal?.aborted) { sawStopCut = true; return; }
        }
      },
      stop() { stopped = true; gateReleased(); },
      async waitForDrain() {},
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('long line')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'a1', prompt: 'long line' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'a1', content: 'ABCDEFGH', accumulated: 'ABCDEFGH' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'a1', response: 'ABCDEFGH', stopReason: 'completed' }));
    await drain();

    // One byte in, then a deliberate stop: sink.stop() cuts the active stream.
    controller.stop();
    await drain();

    expect(sawStopCut).toBe(true);
    // The cut happened before the full stream was consumed.
    expect(received.length).toBeLessThan('ABCDEFGH'.length);
  });
});

describe('AudioSink contract — bounded waitForDrain on exit', () => {
  test('stopForExit resolves within the drain window even when the sink never finishes naturally', async () => {
    let waitForDrainMs: number | null = null;

    const sink: AudioSink = {
      label: 'never-finishes',
      available: true,
      async play(chunks) {
        for await (const _chunk of chunks) { /* consume */ }
        // Model a sink still holding the device open after all bytes are in.
        await new Promise<void>(() => { /* never resolves on its own */ });
      },
      stop() {},
      waitForDrain(timeoutMs) {
        waitForDrainMs = timeoutMs;
        // Contract 4: bounded — resolve after the window, never hang.
        return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      },
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('draining answer')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'd1', prompt: 'draining answer' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'd1', content: 'Tail.', accumulated: 'Tail.' }));
    await drain();

    const started = Date.now();
    await controller.stopForExit(30);
    const elapsed = Date.now() - started;

    // The exit path forwarded its budget to waitForDrain and returned inside it.
    expect(waitForDrainMs).toBe(30);
    expect(elapsed).toBeLessThan(500);
  });
});
