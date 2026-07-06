import type { VoiceAudioChunk } from '../types.js';

/**
 * AudioSink — the injectable I/O boundary the spoken-turn policy engine plays
 * through. The SDK owns POLICY (chunking, the bounded synthesis window, merge
 * coalescing, retry/backoff, the turn state machine); a sink owns I/O (turning
 * an ordered stream of audio bytes into sound and reporting when it has stopped
 * making sound). The controller never spawns a process, opens a device, or
 * touches Web Audio — it only talks to this interface, so the same policy runs
 * unchanged behind a terminal subprocess player, a browser Web Audio sink, or a
 * test fake.
 *
 * ## Behavioral contract
 *
 * The controller depends on these guarantees, not on any implementation detail:
 *
 * 1. **Readiness / head survival.** `play()` must not drop the leading bytes of
 *    the stream while the underlying output is still coming up. A subprocess
 *    sink holds the first byte until the player has actually exec'd (its spawn
 *    event); a browser sink holds until the MediaSource `sourceopen` /
 *    SourceBuffer is ready. The controller writes the whole stream and trusts
 *    the sink to have played the head — it does not re-send or pre-buffer.
 *    `available` is the coarse, synchronous readiness signal (is any output
 *    device usable at all); per-call readiness is internal to `play()`.
 *
 * 2. **Natural drain plays everything.** When the input stream ends without an
 *    abort, `play()` resolves only after the last buffered sample has been
 *    heard — never at end-of-input. Truncating the tail of a response is the
 *    bug this contract exists to prevent.
 *
 * 3. **Abort cuts immediately.** When `options.signal` aborts (a deliberate
 *    interrupt — new turn, Ctrl+C, /tts stop, turn cancel), `play()` stops
 *    emitting sound and resolves promptly; it must NOT wait on a graceful
 *    drain. `stop()` is the same instant cut driven imperatively rather than by
 *    a signal.
 *
 * 4. **Bounded exit drain.** `waitForDrain(timeoutMs)` resolves when the sound
 *    currently playing finishes naturally OR after `timeoutMs`, whichever comes
 *    first, and resolves immediately when nothing is playing. The exit path
 *    uses this to let the final audio of a finished response play out inside a
 *    short window instead of being cut mid-word.
 *
 * ## Web Audio / browser sink mapping (proof the interface fits a browser)
 *
 * A browser sink for the webui voice build implements this same interface over
 * streaming MP3 into MediaSource; no interface change is required:
 *
 * - `available` -> `('MediaSource' in window) && MediaSource.isTypeSupported('audio/mpeg')`
 *   (fall back to Web Audio `decodeAudioData` where MSE is absent).
 * - `play(chunks, { format, signal })` ->
 *     - create a `MediaSource`, attach it to an `HTMLAudioElement` via
 *       `URL.createObjectURL`, and `await` its `sourceopen` event — this is the
 *       readiness gate (contract 1);
 *     - `addSourceBuffer(mimeFor(format))` where `mimeFor('mp3') === 'audio/mpeg'`
 *       (the same `format` string the controller forwards from the synthesis
 *       result), then `await audioEl.play()`;
 *     - `for await (const chunk of chunks)` -> `sourceBuffer.appendBuffer(chunk.data)`,
 *       awaiting each `updateend`, honoring `signal.aborted` between chunks;
 *     - on input end without abort: `mediaSource.endOfStream()` and resolve on
 *       the audio element's `ended` event -> natural drain (contract 2);
 *     - on `signal` abort: `audioEl.pause()`, `sourceBuffer.abort()`,
 *       `mediaSource.endOfStream()`, revoke the object URL, resolve now
 *       (contract 3).
 * - `stop()` -> the same teardown as the abort branch, driven imperatively.
 * - `waitForDrain(timeoutMs)` -> resolve on the audio element's `ended` event or
 *   a `setTimeout(timeoutMs)`, whichever fires first (contract 4).
 *
 * `VoiceAudioChunk.data` is a `Uint8Array`, which `appendBuffer` accepts
 * directly, and the `format` string maps 1:1 to a MediaSource MIME type, so the
 * byte-and-format shape the controller emits is exactly what a browser sink
 * consumes. (The subprocess sink — mpv/ffplay over stdin — stays consumer-side
 * and is not part of the SDK.)
 */
export interface AudioSink {
  /** Human-readable sink name for status lines (e.g. 'mpv', 'web-audio'). */
  readonly label: string;
  /**
   * Coarse, synchronous readiness: is any output device usable at all. When
   * false the controller arms nothing and reports the graceful-degradation
   * notice instead of attempting playback.
   */
  readonly available: boolean;
  /**
   * Play an ordered stream of audio chunks to completion. Resolves after the
   * final sample is heard on a natural end, or promptly on abort. See the
   * interface contract above for readiness, drain, and abort obligations.
   */
  play(chunks: AsyncIterable<VoiceAudioChunk>, options: AudioSinkPlaybackOptions): Promise<void>;
  /** Instant cut: stop emitting sound now and release the output. Idempotent; a no-op when idle. */
  stop(): void;
  /**
   * Resolves once the currently playing sound has finished naturally or after
   * `timeoutMs`, whichever comes first; resolves immediately when nothing is
   * playing. The bounded exit drain — see contract 4.
   */
  waitForDrain(timeoutMs: number): Promise<void>;
}

export interface AudioSinkPlaybackOptions {
  /**
   * Container/codec hint for the byte stream (e.g. 'mp3'), forwarded verbatim
   * from the synthesis result's `format`. A subprocess sink maps it to a
   * demuxer flag; a browser sink maps it to a MediaSource MIME type. Omitted or
   * a value containing '/' (already a MIME type) leaves the sink on its default.
   */
  readonly format?: string | undefined;
  /**
   * Deliberate-interrupt signal. When it aborts, playback cuts immediately (no
   * graceful drain) and `play()` resolves. Absence means "play to natural end".
   */
  readonly signal?: AbortSignal | undefined;
}
