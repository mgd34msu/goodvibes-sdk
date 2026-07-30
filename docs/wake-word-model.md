# The `hey goodvibes` wake-word model

The pinned wake-word classifier, its measured behavior, and the attribution it
ships with. The pin itself lives in
`packages/sdk/src/platform/voice/provisioning/wake-word-manifest.ts`.

The wake-word **engine, config surface, provisioning flow and recovery
housekeeping** live under `packages/sdk/src/platform/voice/wake/`. The **capture
capability** they sit on lives beside them in
`packages/sdk/src/platform/voice/capture/`, and it serves the whole voice stack
rather than the wake word alone: push-to-talk speech-to-text and wake detection
are two consumers of ONE device path, because a wake does not end a capture
session — it starts one, and re-opening the microphone at that moment would drop
the front of the sentence and race whatever still holds the device.

> **Detection runs, and where it runs is stated per surface.** The
> `notOperable` declaration is gone, removed in the change that wired capture up
> as it required. The terminal opens a recorder subprocess
> (`voice.wake.captureCommand`) and a browser tab opens `getUserMedia`; both feed
> the same engine and both hand the utterance after a wake to the same
> speech-to-text call. `voice.wake.enabled` now drives the feature gate the way
> every other capability's setting does.
>
> Two limits remain, and each is written in its own settings row rather than
> behind one blanket claim: `voice.wake.surfaces.agent` has no capture host, and
> a browser tab has no filesystem for `voice.wake.retainAudio` or a local
> `voice.wake.activationSoundPath`. `voice.wake.vadThreshold` is no longer one of
> them — there is a pinned speech gate now, and a surface refuses only when it has
> not loaded it. `resolveWakeRuntimeSettings` reads every row and reports these
> as blockers (the detector does not start) or limitations (it runs, with that row
> not in force).

## What is published

Hosted at the same append-only `voice-runtimes-v1` release tag that hosts the
voice engine bundles, each with a `<asset>.sha256` sidecar.

| artifact | bytes | sha256 |
|---|---|---|
| `goodvibes-wakeword-hey-goodvibes-1.0.0.onnx` | 2,367,644 | `89a0b7b565d433cb73e3dd24476274fdbec2c71925a63185973303861c0467d9` |
| `goodvibes-wakeword-hey-goodvibes-1.0.0.tflite` | 2,369,264 | `05da156c040e497d7e71f1892e4f773e46d8f9a3ef24ba1c2572d30241647c8a` |
| `goodvibes-wakeword-hey-goodvibes-1.0.0.NOTICE.txt` | 5,574 | `7d85d7b37ac37dbe3753cabaae3ace8d8d35052ea6902cc9b27ec0051e594ab0` |
| `goodvibes-vad-1.0.0.onnx` | 15,885 | `0ee90b4849f667211fc8fdd27f3c459560108db64b8978f17ae2b27c65596aab` |
| `goodvibes-vad-1.0.0.tflite` | 18,136 | `f8f1903c075b3d8cb0c7998ae613bbbf31ad5c2bd4c090fde3f83cfed588fdcd` |
| `goodvibes-vad-1.0.0.NOTICE.txt` | 6,786 | `3d8d27800798397e4b1974712e28753f0c149018be733421d84bfe6cc16546d0` |

The three `goodvibes-vad-1.0.0` assets are the speech gate — see
[The speech gate](#the-speech-gate-is-ours-too-and-it-rides-the-same-front-end).
Their byte counts and checksums are of the built artifacts and are what the
upload to the release tag must match; **they land with this round's release**.
Until then a provision reports the gate as failed and `vadReady` false, while the
detector itself stays ready, which is why the gate is not part of
`WakeProvisionStatus.ready`.

The `.onnx` and `.tflite` twins are bit-identical in every decision on every
evaluation clip — they are the same classifier in two runtime formats.

**The `.tflite` twin is pinned but not currently exercised.** The engine runs
onnxruntime-web everywhere, including in the browser, so it consumes the
`.onnx` artifact only. The TFLite file is published and checksummed for a
mobile runtime that does not exist here yet; nothing in this repository loads
it, and no test scores against it. Its bit-identical claim rests on the
training-time comparison recorded above, not on continuous verification.

## Swapping in a newer model

An accent-diverse retrain is in training and is expected to replace this pin.
Adopting it is a **pin change, not re-plumbing**:

1. Upload the new artifacts to `voice-runtimes-v1` under new versioned
   filenames (assets are never re-uploaded in place or renamed).
2. Add a new version entry to `WAKE_WORD_MODELS`.
3. Move `DEFAULT_WAKE_WORD_MODEL_VERSION` to it.

Nothing else changes. Consumers resolve the default through
`resolveWakeWordModel()` and never hold a version, URL, or checksum of their
own, and older versions stay listed and stay fetchable.

## Run it at threshold 0.9, not 0.5

openWakeWord ships a default detection threshold of **0.5**. For this phrase
that is too low, and the manifest carries `recommendedThreshold: 0.9`.

| threshold | recall | minimal-pair false accepts (never-trained phrases) | false accepts/hour on real speech |
|---|---|---|---|
| 0.5 (upstream default) | 99.2 % | 34.5 % | 0.83 |
| **0.9 (recommended)** | **96.8 %** | **24.7 %** | **0.13** |

"Minimal pairs" are near-miss phrases like "hey good vibe check" — ordinary
English a user will actually say. 0.9 costs about two and a half points of
recall and removes roughly a third of those false fires.

## Recall figures are from synthetic speech

**No human recording of the phrase "hey goodvibes" exists yet.** Every positive
clip used to measure recall — training, golden, adversarial — is text-to-speech
output from a single VITS model. The 96.8 % / 99.2 % recall numbers above have
no real microphones behind them, no real rooms beyond convolved simulated
impulse responses, no accents outside the LibriTTS-R distribution, no children,
no whispering, no speakerphone.

The false-accept side is different: it rests on **81 hours of real human
speech** held out of training. So "it rarely fires when it shouldn't" is
measured against reality; "it fires when it should" is not yet.

A human test pass is required before this model ships as a default. Any
user-facing description of the model must carry this qualification.

## The classifier cannot run on its own

It is the last stage of a three-stage pipeline and consumes speech
**embeddings**, not audio:

```
audio -> melspectrogram -> speech-embedding backbone -> this classifier
```

A runtime must therefore also provide the two front-end models:

- **Google `speech_embedding`** — Apache 2.0, provided by Google as a TFHub
  module. openWakeWord's README states this directly: "This model is provided
  by Google as a TFHub module under an Apache-2.0 license."
- **Melspectrogram front-end** — an untrained, fixed DSP graph (STFT plus a mel
  filterbank and window function). No learned parameters, nothing derived from
  any training corpus.

**Source both from Google's own Apache-2.0 TFHub distribution rather than
redistributing openWakeWord's copies.** The provenance then traces to that
Apache-2.0 grant directly and unambiguously.

### What that produced, and the measured divergence

The classifier was TRAINED against openWakeWord's front end, so re-sourcing it
is only safe if the replacement reproduces it. Both stages were rebuilt and
both were measured against the originals.

**Melspectrogram — computed in code, not downloaded.** It is a fixed STFT and
mel filterbank with no learned parameters, so
`platform/voice/wake/melspectrogram.ts` computes it directly, removing a
runtime download entirely. Its constants were not chosen and were not taken
from a library's defaults: they were recovered numerically from openWakeWord's
own `melspectrogram.onnx` initializers (a `torchlibrosa` export). Recovered
values, with the residual against those weights:

| parameter | value | residual vs the reference weights |
|---|---|---|
| window | periodic Hann, 400 taps, centred in 512 | 2.8e-8 |
| Fourier basis | `w[n]·cos(2πkn/512)` / `−w[n]·sin(2πkn/512)` | 5.6e-8 over all 257×512 taps |
| n_fft / hop | 512 / 160 | exact (graph attributes) |
| padding | none (`center=False`) | exact (`pads=[0,0]`) |
| filterbank | 32 bands, Slaney scale, Slaney norm, 60–3800 Hz | 8.1e-10 against a 1.4e-2 peak weight |
| decibels | power spectrogram, amin 1e-10, ref 1.0, top_db 80 | exact |

**Speech embedding — Google's weights, rebuilt.** Google's TF1 SavedModel was
read directly (GraphDef for topology, checkpoint for all 332,088 parameters)
and emitted as ONNX, with each batch normalisation folded into the convolution
ahead of it. Folding those 19 batch norms reproduces openWakeWord's ONNX
initializers with a maximum absolute difference of **exactly 0.0 on all 20
weight tensors and all 19 bias tensors** — openWakeWord's file is Google's
checkpoint unmodified, which is the strongest possible provenance check.

One graph note, recorded rather than glossed: Google's graph applies a ReLU
between the first convolution and its batch normalisation, and openWakeWord's
re-implementation omits it. The shipped build omits it too, because that is the
embedding function the classifier was trained against. A faithful Relu-keeping
build reproduces Google's own TF module to 5.1e-05, and differs from the
shipped one by up to 13.1 — the ReLU is materially active, so switching to it
would require retraining the classifier.

### Measured end-to-end divergence

Running the re-sourced front end instead of openWakeWord's, through the same
published classifier:

| comparison | n | max abs difference | mean abs difference |
|---|---|---|---|
| mel values (dB) | 4,713,216 | 4.292e-5 | 7.481e-7 |
| embedding elements | 2,464 inputs | **0.0** (bit-exact) | **0.0** |
| classifier scores | 11,061 frames | 8.464e-6 | 6.002e-8 |
| per-clip peak score | 240 clips | 5.305e-6 | — |

**Zero detection decisions changed**, at threshold 0.5 and at 0.9, across all
11,061 frame decisions, with identical detection counts on every evaluation
set. The measured figures in this document therefore still describe the running
detector. `test/wake-word-front-end-parity.test.ts` pins this against committed
reference frames so a regression fails a test rather than degrading detection
quality silently.

### The re-sourced embedding artifact

Hosted at the same append-only `voice-runtimes-v1` tag, with a `.sha256`
sidecar and its own NOTICE:

| artifact | bytes | sha256 |
|---|---|---|
| `goodvibes-speech-embedding-1.0.0.onnx` | 1,319,365 | `463e5c778f7f623bb1ee52e82daad200f36a947738fe191c247ba1fbc5eed28a` |
| `goodvibes-speech-embedding-1.0.0.NOTICE.txt` | 3,434 | `2e9426d943fdd65fbf881c7ecc3bd1c68fda30a1334cce4de2787e607c48d6f3` |

Source of record, and where its Apache-2.0 grant was read on 2026-07-25:
`https://www.kaggle.com/api/v1/models/google/speech-embedding/tensorFlow1/speech-embedding/1/download`
(Google's distribution; `licenseName: "Apache 2.0"`, `author: "Google"`).

openWakeWord's README carries a blanket sentence licensing "all of the included
pre-trained models" CC BY-NC-SA 4.0, giving its own reason: "due to the
inclusion of datasets with unknown or restrictive licensing as part of the
training data." That reason describes the author's own wake-word classifiers,
trained on those corpora. GoodVibes does not use them — this classifier was
trained from scratch on attribution-only corpora. The reason cannot apply to an
untrained DSP graph, nor to Google's Apache-2.0 embedding model.

## Attribution is mandatory

The models are licensed **Apache-2.0**. Several training corpora are Creative
Commons Attribution, which **requires** attribution, so
`goodvibes-wakeword-hey-goodvibes-1.0.0.NOTICE.txt` must be retained and
reproduced by anything that redistributes the artifacts. It is pinned and
checksummed in the manifest like any other asset.

Training data credited in the NOTICE: LibriTTS-R and LibriSpeech (CC BY 4.0),
MUSAN `music/rfm` and `noise/sound-bible` (CC BY 3.0), MUSAN `noise/free-sound`
(Public Domain), and the openSLR SLR26/28 **simulated** room impulse responses
(Apache 2.0). Only the simulated RIRs were used; SLR28's redistributed
real-recorded RIR and pointsource-noise directories were deliberately excluded
because they carry separate upstream terms.

No third-party audio, no third-party model weights, and no training data are
embedded in the artifacts. Every corpus that shaped the weights is
attribution-only or public domain — none is NonCommercial, ShareAlike,
NoDerivatives, or unstated.

## How each surface runs it

One inference runtime serves both surfaces: **`onnxruntime-web` on a WASM
backend**, which is a plain JavaScript package with a WASM binary rather than a
native module, so the terminal binary and the browser tab load the same thing.
Measured on the reference machine with the pinned models: **3.46 ms per 80 ms
frame, single-threaded** — inside the 3.53 ms budget the engine documents, and
more than an order of magnitude inside real time.

**The terminal / daemon host.** A recorder subprocess produces the audio
(`voice.wake.captureCommand`: pw-record, parecord, arecord, ffmpeg or sox, with
`auto` probing in that order), and `platform/voice/capture/recorder-command.ts`
holds the argv. Those arguments were checked against the real tools, not
recalled — most consequentially, **pw-record needs `--container raw`**, because
writing to `-` without it emits a container header before the samples and
byte-misaligns the entire stream, which does not fail: it produces a detector
that never fires. A compiled single-file binary cannot rely on the runtime
dynamically importing its own WASM glue by path, so the host embeds the two
`onnxruntime-web` assets, writes them out once, and points
`ort.env.wasm.wasmPaths` at that directory.

**The browser tab.** `getUserMedia` produces the audio, re-cut to exact frames by
`AudioFrameSlicer`, and the tab reads the model **from the daemon** rather than
from the release tag: the published assets answer without an
`access-control-allow-origin` header, so a cross-origin fetch of them from the
web UI's origin is refused before the bytes arrive. `voice.wake.model` serves the
artifact in bounded chunks, each restating the pinned sha256, and the tab
verifies the file it reassembled before creating a session — a truncated transfer
then fails at the consumer instead of loading as a model that silently never
detects.

**Frames carry int16 magnitudes as floats, not normalised −1..1 audio.** That is
the scale the classifier was trained on; normalised audio scores near zero
forever and looks exactly like a microphone that is picking nothing up.

## Noise suppression runs in the same place, on both surfaces

`voice.wake.noiseSuppression: "speex"` is **SpeexDSP 1.2.1's preprocessor,
compiled to WebAssembly and carried in the package** — 53,678 bytes, sha256
`4829d9fa97e648ab9c45e9a685adba7bd762a4f948ec499c59b073bd03cce2bb`, with zero
imports (no WASI syscalls, no JavaScript glue). It runs wherever `WebAssembly`
exists, which is both shipped surfaces, for the same reason the inference runtime
is a WASM backend: a native binding cannot run in the browser tab, and a setting
that means different things on different surfaces is the problem rather than the
fix. Build inputs, the pinned toolchain and the attribution are in
`native/speexdsp-wasm/`; `bun scripts/build-speexdsp-wasm.ts` rebuilds it.

**One application point, so no consumer can be missed.**
`createNoiseSuppressingOpener` wraps whatever a host opens, and both consumers —
the wake listener and the push-to-talk session — wrap the opener they are given.
So the classifier scores filtered frames, the utterance recorded after a wake is
filtered, the pre-roll carried from before the wake is filtered, and voice input
is filtered. A host passes the same plain opener it always did. Wrapping is
idempotent: the wrapper asks the opener underneath it for `none`, so a host that
wraps its own opener as well filters once, not twice.

**Measured, on a synthetic tone-plus-white-noise set** (a 1 kHz tone gated on and
off under white noise, measured over the last four seconds of six with a
960-sample guard band either side of each gate edge, because the suppressor
overlap-adds a window twice its block length):

| | noise floor | tone window | SNR |
| --- | --- | --- | --- |
| passthrough | 515.5 rms | 4277.3 rms | 18.38 dB |
| speex | 112.7 rms | 4097.3 rms | 31.21 dB |

**Noise floor down 13.20 dB, SNR up 12.83 dB, tone correlation 0.9990** — the
floor comes down by about the 15 dB the filter is asked for while the tone
survives. `test/voice-noise-suppression.test.ts` asserts those numbers with
margin, and asserts that `none` is a true passthrough: the same frame objects, so
the byte path with suppression off is the path that shipped.

**Cost: 0.100 ms per 80 ms frame** (p95 0.112 ms, max 0.285 ms over 1000 frames
after warm-up) — 0.13 % of one core, beside the detector's own 3.46 ms. Creating a
stage costs 5.3 ms the first time (compiling the module) and 0.18 ms per stream
after that, since the compiled module is shared and only the filter state is per
stream. Frames are filtered in 20 ms blocks through one continuous state, not in
80 ms ones: the suppressor estimates its noise floor over a window twice the
block length, and an 80 ms block would track a room four times more slowly than
SpeexDSP is tuned for.

**What it is not.** The module carries the denoiser and nothing else — no echo
canceller, no automatic gain control (which would move the loudness the
classifier was trained against), and no voice-activity gate. Those stages are
disabled explicitly in the build rather than left at upstream defaults.
`voice.wake.vadThreshold` still has no model behind it and still refuses.

**Attribution is mandatory here too.** SpeexDSP is BSD 3-clause, which requires
its copyright notice, condition list and disclaimer to be reproduced with binary
redistribution — and the base64 module inside the published package is binary
redistribution. `native/speexdsp-wasm/NOTICE.txt` is that reproduction and
`SPEEXDSP_PREPROCESS.noticePath` points at it. Nothing in the chain is
NonCommercial, ShareAlike or NoDerivatives: SpeexDSP is BSD 3-clause and the
linked C runtime (wasi-libc) is Apache-2.0-with-LLVM-exception / Apache-2.0 / MIT.

## The speech gate is ours too, and it rides the same front end

`voice.wake.vadThreshold` used to refuse: it named a stage with no model behind
it. There is a model now, and it is **ours — trained by us**, on the same
commercially-clean corpora class as the wake classifier. It is a
**speech/non-speech head over the SAME 96-dimension embedding the wake classifier
consumes**:

```
audio -> melspectrogram -> speech-embedding backbone -> ┬─> wake classifier
                                                        └─> this speech gate
```

That shape is the point. The front end already runs once per 80 ms frame for the
classifier, so the gate adds one tiny inference and **no extra front-end pass**,
and it provisions with artifacts the surface already downloads. A standalone
voice-activity detector would have brought its own front end, its own artifacts
and its own provenance. Architecture: 96 inputs → fixed input standardisation →
32 units (ReLU) → 16 units (ReLU) → 1 unit (sigmoid). 3,713 parameters, 15.9 kB.

**What it does.** A frame whose speech probability falls below the threshold is
**withheld from the classifiers** — the 2.4 MB classifier is not run for it — and
the withheld frame breaks any run of above-threshold frames in progress, because
patience counts consecutive SCORED frames. Cooldown is untouched: withholding a
frame must not let one utterance fire twice.

**Trained on.** 278,553 frames: LibriSpeech `train-clean-100` and MUSAN speech as
positives, MUSAN noise and music as negatives, with per-file gain randomisation
and **half the speech mixed with noise at 0–18 dB SNR** — a head trained on loud
clean speech and quiet noise learns "loud", and would then gate the exact case
the detector has to survive, someone speaking with a fan running. Labels for
speech recordings are weak, derived from energy over the embedding's own 760 ms
receptive field (≥60 % of the window above the recording's own floor is speech,
≤5 % is non-speech, in between is dropped as ambiguous); the negative class is
anchored by recordings that contain no speech at all. Every corpus is
attribution-only or public domain — the same set the wake classifier's NOTICE
credits — and `goodvibes-vad-1.0.0.NOTICE.txt` carries the attribution.

**Measured on 106,390 held-out frames** (44,286 speech), from recordings disjoint
from training by file and by speaker:

| threshold | speech frames passed | non-speech frames withheld |
|---|---|---|
| 0.05 | 98.59 % | 77.68 % |
| 0.10 | 97.78 % | 88.45 % |
| 0.20 | 96.83 % | 93.76 % |
| **0.30 (recommended)** | **96.03 %** | **95.65 %** |
| 0.50 | 94.51 % | 97.35 % |
| 0.70 | 92.62 % | 98.24 % |
| 0.90 | 88.33 % | 99.03 % |

**Run it at 0.30.** The two errors are not symmetric: a withheld speech frame is
a wake that cannot fire, while a passed non-speech frame only costs one
classifier inference that was going to be spent anyway. 0.30 is where speech pass
rate starts falling faster than withholding rises. On the two individual held-out
recordings recorded into `test/fixtures/wake-vad.json`, **0 % of the noise
recording's frames pass and 95.8 % of the speech recording's do**, and the test
suite asserts both.

**`voice.wake.vadThreshold` still ships at 0** — the gate off. That is the
configuration that has been exercised, and a gate can only ever cost a detection;
0.30 is what to set it to when turning the gate on.

**Cost: 0.025 ms per 80 ms frame** (p50 0.020 ms, p95 0.033 ms over 1000 frames
after warm-up, measured through onnxruntime-node on the reference machine) —
0.031 % of one core, beside the detector's own 3.46 ms.

**The twins agree.** onnx vs Keras 1.8e-07, tflite vs Keras 5.4e-07 over 2,000
held-out frames, with **zero gating decisions changed** at thresholds 0.2, 0.3 and
0.5. The ONNX graph was assembled by hand from the trained weights (eight nodes)
rather than run through a converter, then verified against Keras.

**Both hosts, one artifact — with one host-side line each.** The gate is a
session the host loads and hands to the engine, exactly as it does the classifier
and the embedding, and the browser tab reads its bytes from the daemon
(`voice.wake.model` with `component: "vad"`) because the release asset answers
with no CORS header. A surface that has not loaded it refuses any threshold above
0 rather than running unscreened frames through a stage the user configured —
`WakeSurfaceCapabilities.vadAvailable` is that declaration.

## Known weaknesses

- **Minimal pairs.** At 0.9 it still fires on 24.7 % of never-trained near-miss
  phrases. "hey good vibes" is made of ordinary English words.
- **Non-speech audio.** The negative corpus is roughly 98 % English read speech
  — little music, no television, no non-English. The model has never been
  taught what those sound like and false-accepts more on them. This is the
  known, bounded reason to prefer the accent-diverse retrain when it lands.
- **Homophones.** "hay good vibes" fires 100 % of the time. That is unavoidable
  for this phrase.
