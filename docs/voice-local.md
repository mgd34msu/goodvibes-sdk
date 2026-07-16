# Local voice engines — free, offline STT + TTS

The `local` voice provider runs speech-to-text and text-to-speech entirely on
your machine, behind the exact same seams as the cloud providers (the voice
provider registry, the spoken-turn controller, the audio-sink contract). It is
the free peer beside the premium ElevenLabs route: selection is the ordinary
`tts.provider` setting, and a spoken conversation completes with no cloud
voice dependency once engines are configured.

**Nothing auto-downloads.** Out of the box the provider reports an honest
`unconfigured` status (never an error). Setup is one explicit action per
engine: install it, download a model, set the `voice.local.*` keys below.

## Blessed engines (research pass, 2026-07-14)

Chosen from current comparative evidence, not from memory:

- **STT — whisper.cpp** (default): a pure C/C++ Whisper port; CPU-first,
  realtime-capable, no Python dependency; on Apple Silicon it runs ~10× real
  time on large-v3 with Metal. **faster-whisper** is the alternative when an
  NVIDIA GPU is present (CTranslate2 int8, ~4× original-Whisper throughput).
  Sources: [promptquorum — whisper.cpp vs faster-whisper 2026 benchmarks](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026),
  [codersera — faster-whisper vs whisper.cpp vs OpenAI Whisper (2026)](https://codersera.com/blog/faster-whisper-vs-whisper-cpp-speech-to-text-2026/),
  [modal — choosing Whisper variants](https://modal.com/blog/choosing-whisper-variants).
- **TTS — Piper** (default): ~0.03 real-time factor, first audio in ~40–50 ms,
  MIT-licensed, runs on CPU-only and edge hardware. **Kokoro-82M** is the
  quality alternative (Apache 2.0, 54 voices, beats XTTS v2 in blind listening
  tests at a fraction of the size).
  Sources: [contracollective — Kokoro vs Piper vs XTTS v2 (2026)](https://contracollective.com/blog/kokoro-vs-piper-vs-xtts-local-text-to-speech-m5-max-2026),
  [localaimaster — best local TTS models 2026](https://localaimaster.com/blog/best-local-tts-models),
  [codesota — TTS leaderboard 2026](https://www.codesota.com/text-to-speech).

## Worked setup path (Linux x86_64; the one used for the measurement below)

```bash
# 1. Piper (TTS): prebuilt binary + one small voice (~63 MB), user-scoped.
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -sL -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tar.gz
mkdir -p piper-voices
curl -sL -o piper-voices/en_US-lessac-low.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx"
curl -sL -o piper-voices/en_US-lessac-low.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx.json"

# 2. whisper.cpp (STT): build once + one tiny English model (~75 MB).
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --target whisper-cli
curl -sL -o ggml-tiny.en.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"

# 3. Point the platform at them (settings.json / config set):
#   voice.local.ttsEngine    = "piper"
#   voice.local.ttsBinary    = "~/.local/opt/piper/piper"           (absolute path)
#   voice.local.ttsModelPath = "~/.local/opt/piper-voices/en_US-lessac-low.onnx"
#   voice.local.sttEngine    = "whisper-cpp"
#   voice.local.sttBinary    = "~/.local/opt/whisper.cpp/build/bin/whisper-cli"
#   voice.local.sttModelPath = "~/.local/opt/whisper.cpp/ggml-tiny.en.bin"
#   tts.provider             = "local"                              (route selection)
```

Engine invocation contracts (what the provider runs):

- `whisper-cpp`: `<binary> -m <model> -f <wav> --no-timestamps --no-prints` → transcript on stdout.
- `faster-whisper`: `<binary> <model> <wav>` → transcript on stdout. Wrapper:
  `python -c "from faster_whisper import WhisperModel; import sys; print(' '.join(s.text for s in WhisperModel(sys.argv[1]).transcribe(sys.argv[2])[0]))" "$@"`
- `piper`: `<binary> --model <onnx> --output_file <wav>`, text on stdin.
- `kokoro`: same contract as piper (`--model`, `--output_file`, text on stdin) via a small wrapper script around the kokoro-onnx CLI.

## Measured end-to-end latency (real run, this repo's development host)

Hardware class: AMD Ryzen 9 5900X (12C/24T), CPU-only, Linux. Measured
2026-07-14 with the exact setup above (process spawn + model load included —
the provider's real per-call path, no warm daemon):

| Leg | Engine / model | Input | Wall clock |
| --- | --- | --- | --- |
| TTS | Piper, en_US-lessac-low | 85-char sentence → 4.9 s of 16 kHz wav | **327 ms** |
| STT | whisper.cpp, tiny.en | that 4.9 s wav | **459 ms** |
| Spoken round trip | both | text → audio → text (round-tripped exactly) | **≈ 786 ms** |

The STT leg reproduced the input text byte-for-byte ("Hello from the local
voice engine. This is a real end to end synthesis measurement."). Larger
models trade latency for accuracy; GPU hosts should prefer faster-whisper for
STT per the sources above.

## Managed engine bundles: hosting + stability contract

`voice.local.install` provisions the STT engine (whisper.cpp) from a
goodvibes-built, checksum-pinned bundle. Those bundles are hosted at ONE
append-only GitHub release tag — **`voice-runtimes-v1`** on the SDK repo — with a
`<asset>.sha256` sidecar next to every asset.

Stability contract (relied on by the pinned manifest and every referencing
script):

- **Append-only.** Assets are added under new, versioned filenames
  (`goodvibes-whisper-cpp-<version>-<platform>.tar.gz`). An existing asset is
  **never re-uploaded in place and never renamed**. The publish workflow uploads
  without `--clobber`, so an attempt to replace a pinned asset fails loudly.
- **Move-in-lockstep.** If an asset location ever must change, every script/doc
  that references it (the manifest `bundle.url`, this doc, the build script's
  printed URL) is updated in the **same commit** — a pinned URL is never left
  dangling.
- **Reproducible.** `scripts/build-whisper-bundle.ts` produces a byte-reproducible
  tarball (`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`,
  `gzip -n`), so a clean rebuild of identical inputs matches the pinned `sha256`.
  A user can therefore build the bundle themselves and sideload it — dropping it
  at `<managedRoot>/engines/whisper.tar.gz` — and it verifies against the same
  pin whether or not a hosted URL is set.

Building + publishing a new bundle: run `scripts/build-whisper-bundle.ts` (it
prints the bundle, its `.sha256` sidecar, and the durable hosted URL), or trigger
the **Voice runtimes** workflow (`.github/workflows/voice-runtimes.yml`), then
stamp the printed `WHISPER_ENGINES` entry into the manifest. linux-x64 is hosted
today; other platforms report `unsupported` honestly until their bundle is
uploaded to the same tag.

## Cost honesty

- **ElevenLabs (premium route)**: every synthesis/transcription through the
  voice service records billable units (characters for TTS, seconds for STT)
  into cost attribution under a voice-scoped model key
  (`elevenlabs:voice-tts:characters`). It reports honestly UNPRICED until the
  one-key manual price names your plan's rate:
  `pricing.modelPrices["elevenlabs:voice-tts:characters"] = { "input": <USD per 1M characters> }` —
  after which sessions show real dollars with `user` pricing provenance.
- **Local**: no billing dimension at all. Local calls record nothing — the
  cost surfaces show an honest absence, never a fake $0.00.
