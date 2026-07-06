# Decision: hoist the spoken-output (live TTS) policy engine into the SDK, with an injectable AudioSink

Date: 2026-07-06
Scope: One-Platform — shared behavioral contract extraction; SDK owns policy, clients own I/O
Status: accepted

## Context

The TUI and the agent each carried a twin copy of the live text-to-speech
pipeline: `src/audio/spoken-turn-controller.ts`, `src/audio/text-chunker.ts`,
and their deterministic test suites. The freshest copy (the TUI's) had grown a
substantial behavioral contract that the agent's copy tracked by hand:

- a sentence-boundary chunker with a max-length cut and a latency flush;
- a bounded **2-slot** synthesis window that never bursts more than two
  concurrent requests at the voice provider (ElevenLabs plans allow as few as 3
  concurrent — an unbounded burst 429s the whole turn);
- aggressive **merge-pending coalescing** with a 1,500-char cap, so a
  multi-paragraph answer folds into one or two requests instead of one per
  sentence;
- **bounded backoff retry** for transient failures (429 / transient 5xx /
  network drops) with an **honest skip-and-continue** — a gap in speech beats
  losing the whole response;
- **drain-vs-interrupt** semantics: a natural end plays the tail out fully; a
  deliberate interrupt (Ctrl+C, /tts stop, turn cancel, preemption) cuts
  instantly; and a `stopForExit` path that lets the audio already playing drain
  inside a bounded window before teardown.

Mike's standing rule: shared behavioral contracts hoist into the SDK. The webui
voice build needs this exact policy behind a Web Audio sink, and keeping three
copies in sync by hand is a defect source.

## Decision

Hoist the pipeline into the SDK as the single shared **policy engine**, under
`packages/sdk/src/platform/voice/spoken-turn/`, re-exported from the existing
`@pellux/goodvibes-sdk/platform/voice` entry (no new package export subpath):

- `text-chunker.ts` — `TtsTextChunker`, ported verbatim (pure policy: no I/O, no
  timers of its own — the caller drives `flushDue()` on its own clock).
- `controller.ts` — `SpokenTurnController`, the turn state machine + bounded
  window + coalescing + retry/backoff. Parameterized by an injected
  `AudioSink`, `configManager` (`Pick<ConfigManager, 'get'>` — reads
  `tts.provider` / `tts.voice` / `tts.speed`), `voiceService`
  (`Pick<VoiceService, 'synthesizeStream'>`), a `notify` callback, an optional
  `source` attribution label, and injectable clocks/timers
  (`now`/`setInterval`/`clearInterval`/`setTimeout`/`clearTimeout`) for
  deterministic tests. It consumes the SDK's own `TurnEvent` union
  (`packages/sdk/src/events/turn.ts`).
- `audio-sink.ts` — the `AudioSink` interface: the injectable I/O boundary.

**The SDK owns POLICY; clients own I/O via the sink.** No subprocess code lives
in the SDK — the mpv/ffplay player stays consumer-side as a sink
implementation. The browser voice build supplies a Web Audio sink implementing
the same interface.

### The AudioSink interface

```
interface AudioSink {
  readonly label: string;
  readonly available: boolean;
  play(chunks: AsyncIterable<VoiceAudioChunk>, options: { format?; signal? }): Promise<void>;
  stop(): void;
  waitForDrain(timeoutMs: number): Promise<void>;
}
```

This is structurally identical to the consumers' existing
`StreamingAudioPlayer`, so the TUI's and the agent's `LocalStreamingAudioPlayer`
already satisfy `AudioSink` with **no code change** — adoption is a type import
and a one-word option rename (`player:` → `sink:`).

The interface carries a documented **behavioral contract** the controller relies
on and every sink must honor:

1. **Readiness / head survival** — `play()` must not drop the leading bytes
   while the output device is still coming up (subprocess: hold until the
   `spawn` event; browser: hold until MediaSource `sourceopen`). `available` is
   the coarse synchronous readiness signal.
2. **Natural drain plays everything** — on a non-aborted end, `play()` resolves
   only after the last sample is heard, never at end-of-input.
3. **Abort cuts immediately** — an aborted `options.signal` (or `stop()`) cuts
   sound and resolves promptly; no graceful drain.
4. **Bounded exit drain** — `waitForDrain(timeoutMs)` resolves on natural finish
   or after `timeoutMs`, whichever first; immediately when idle.

### Browser-fit proof (Web Audio, streaming MP3 → MediaSource)

The interface was designed against **both** the consumers' `player.ts` and a
browser sink, and fits the browser without change (documented in
`audio-sink.ts`):

- `available` → `MediaSource.isTypeSupported('audio/mpeg')` (fall back to Web
  Audio `decodeAudioData` where MSE is absent).
- `play(chunks, { format, signal })` → attach a `MediaSource` to an
  `HTMLAudioElement`, `await sourceopen` (readiness gate — contract 1),
  `addSourceBuffer(mimeFor(format))` where `mimeFor('mp3') === 'audio/mpeg'`
  (the same `format` string the controller forwards), then for each chunk
  `sourceBuffer.appendBuffer(chunk.data)` awaiting `updateend`; on input end
  `endOfStream()` and resolve on the element's `ended` event (contract 2); on
  abort, `pause()` + `sourceBuffer.abort()` + resolve (contract 3).
- `stop()` → the abort teardown driven imperatively.
- `waitForDrain(timeoutMs)` → resolve on `ended` or a `setTimeout`, whichever
  first (contract 4).

`VoiceAudioChunk.data` is a `Uint8Array` (accepted by `appendBuffer` directly)
and `format` maps 1:1 to a MediaSource MIME type, so the byte-and-format shape
the controller emits is exactly what a browser sink consumes. The webui builds
the actual sink; the SDK only proves the interface fits it.

### Ported test evidence (every fix class pinned against a fake sink)

Three SDK test files, 19 tests, all green:

- `test/voice-tts-text-chunker.test.ts` — sentence flush, latency flush,
  word-boundary split.
- `test/voice-spoken-turn-controller.test.ts` — coalesce-to-one for a
  burst-complete turn; multi-paragraph stays within three requests and window
  ≤ 2; 429 retried with backoff and no user-facing error; exhausted retries
  skip one chunk with one honest notice and the turn continues; abort mid-backoff
  clears the timer and stays silent; turn-scoping (only the marked turn speaks);
  STREAM_END is not the logical turn end; unpunctuated tail flushed at
  completion; exit-drain bounded (queued chunks dropped, playing audio drains);
  preemption instant; cancel stops cleanly; `source` attribution forwarded.
- `test/voice-audio-sink-contract.test.ts` — pins the `AudioSink` contract from
  the policy engine's view: head survival (delayed readiness still plays every
  byte in order), `stop()` cuts the active stream mid-play, bounded
  `waitForDrain` on exit.

The **subprocess-level** head-gate and process-drain implementation stays with
the consumer's sink and remains pinned by the consumer's `player-playback`
tests; the SDK pins the **contract** those implementations must satisfy.

## Ruling: ElevenLabs websocket text-streaming-input is the module's next step, not this order

The optional second synthesis strategy — ElevenLabs' websocket
text-streaming-input mode (one persistent connection per turn, incremental text
pushed in, audio streamed back continuously) — does **not** fit cleanly behind
the current policy engine, so per the work order it is ruled explicitly as the
next step rather than forced in.

Why it does not fit the current shape: the hoisted engine's scheduling model is
**request/response per merged chunk** — merge pending text, dispatch a bounded
number of `synthesizeStream` requests, retry each request independently. The
websocket mode inverts that: there is no per-chunk request to bound or retry,
no merge-to-request step, and no 2-slot window; there is one connection that
wants raw incremental text fed to it and manages its own generation buffering,
with reconnect handled at the **connection** level, not the request level.
Forcing it behind the current scheduler would either defeat its streaming
advantage (by still chunking to requests) or require a parallel scheduling path
bolted onto the controller.

Next-step design sketch (for whoever picks it up): introduce a `SynthesisStrategy`
seam between the controller's *text intake* and *audio production*:

- `HttpWindowStrategy` — today's behavior: merge + bounded 2-slot window +
  per-request retry over `voiceService.synthesizeStream`.
- `WebsocketSessionStrategy` — opens one text-streaming-input connection per
  turn on turn start, forwards chunker output as it arrives, yields audio
  chunks to the same `AudioSink`, and handles connection-level reconnect;
  drain/interrupt map to closing the connection.

The turn state machine, chunker, `AudioSink`, and drain/interrupt semantics are
strategy-independent and stay put. Deferring keeps this hoist a faithful
1:1 port with no untested speculative surface.

## Consumer adoption

- **TUI / agent** — replace the local `SpokenTurnController` /`TtsTextChunker`
  imports with `@pellux/goodvibes-sdk/platform/voice`; rename the controller
  option `player:` → `sink:` (their `LocalStreamingAudioPlayer` already satisfies
  `AudioSink` unchanged); pass `source: 'goodvibes-tui'` / `'goodvibes-agent'`.
  The consumer-side `player.ts` (mpv/ffplay subprocess sink) and its
  `player-playback` tests stay. The local `spoken-turn-controller.ts` /
  `text-chunker.ts` and their controller/chunker tests become redundant and are
  deleted on adoption.
- **webui** — implement a `WebAudioSink implements AudioSink` (mapping above),
  supply a `{ get }` config shape and the SDK `voiceService`, pass
  `source: 'goodvibes-webui'`, and wire it to the same turn event bus.
