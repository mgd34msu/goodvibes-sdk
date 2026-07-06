/**
 * Spoken-turn — the shared spoken-output (live TTS) policy engine.
 *
 * SDK owns POLICY: the sentence chunker, the bounded 2-slot synthesis window
 * with merge coalescing, the transient-failure retry/backoff with honest
 * skip-and-continue, and the turn-lifecycle state machine with drain-vs-
 * interrupt semantics. Consumers own I/O by supplying an {@link AudioSink}
 * (a terminal subprocess player, a browser Web Audio sink, or a test fake) and,
 * where they run their own scheduler, injectable clocks/timers.
 */
export { SpokenTurnController } from './controller.js';
export type { SpokenTurnControllerOptions } from './controller.js';
export { TtsTextChunker, normalizeSpeechText } from './text-chunker.js';
export type { TtsTextChunkerOptions } from './text-chunker.js';
export type { AudioSink, AudioSinkPlaybackOptions } from './audio-sink.js';
