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
> Three limits remain, and each is written in its own settings row rather than
> behind one blanket claim: `voice.wake.surfaces.agent` has no capture host,
> `voice.wake.vadThreshold` above 0 refuses to start because no VAD model is
> pinned to screen frames with, and a browser tab has no filesystem for
> `voice.wake.retainAudio` or a local `voice.wake.activationSoundPath`.
> `resolveWakeRuntimeSettings` reads every row and reports these as blockers
> (the detector does not start) or limitations (it runs, with that row not in
> force).

## What is published

Hosted at the same append-only `voice-runtimes-v1` release tag that hosts the
voice engine bundles, each with a `<asset>.sha256` sidecar.

| artifact | bytes | sha256 |
|---|---|---|
| `goodvibes-wakeword-hey-goodvibes-1.0.0.onnx` | 2,367,644 | `89a0b7b565d433cb73e3dd24476274fdbec2c71925a63185973303861c0467d9` |
| `goodvibes-wakeword-hey-goodvibes-1.0.0.tflite` | 2,369,264 | `05da156c040e497d7e71f1892e4f773e46d8f9a3ef24ba1c2572d30241647c8a` |
| `goodvibes-wakeword-hey-goodvibes-1.0.0.NOTICE.txt` | 5,574 | `7d85d7b37ac37dbe3753cabaae3ace8d8d35052ea6902cc9b27ec0051e594ab0` |

The `.onnx` and `.tflite` twins are bit-identical in every decision on every
evaluation clip — they are the same classifier in two runtime formats.

**The `.tflite` twin is provisioned and served, but not loaded here.** The engine
runs onnxruntime-web everywhere, including in the browser, so nothing in this
repository loads the TFLite file and no test scores against it — its
bit-identical claim rests on the training-time comparison recorded above, not on
continuous verification. It IS downloaded alongside the `.onnx` build and served
by `voice.wake.model.get` (`component=tflite`), so a runtime that cannot load
onnx has the same access to the model as one that can. It does **not** gate
`ready` — the only pinned artifact that does not: the detector this SDK runs needs
the `.onnx` build, the front end, and **both** attribution NOTICEs, so a host that
got those four and missed the twin is a host that detects, and reporting otherwise
would be false in the unhelpful direction.

## How it gets onto a machine

**The model ships with the installation.** That is a deliberate reversal of the
first shape of this feature, where provisioning was reachable only by typing
`/voice wake setup`. Everything needed to detect the phrase existed and the
ordinary outcome of installing goodvibes was a wake word that could not start,
waiting on a download most people would never go and find.

Three seams, one policy
(`packages/sdk/src/platform/voice/wake/install-provision.ts`):

| when | who calls it | what happens |
|---|---|---|
| curl installer | `install_wake_word_model` in the TUI's `scripts/install.sh`, running the installed `goodvibes-daemon provision-wake-model` | artifacts land before the daemon is started |
| `npm`/`bun install` | the TUI's `scripts/postinstall.js` | same policy, in-process |
| every daemon boot | `startWakeBootProvisioning` | sweeps the tree, then fetches whatever is still missing |

Four rules hold across all three:

1. **A failed download never fails the installation.** No path throws — not an
   absent network, not DNS, not a proxy serving HTML, not an unwritable home
   directory. A failure degrades to precisely the previous behaviour: status
   reports `not-provisioned` **by content**, and the recovery command works.
2. **It says so once, plainly.** One line of prose naming what happened and how
   to retry, printed by the installer or logged by the daemon. Not a stack trace,
   not a debug-level line nobody reads, and not one message per artifact.
3. **It reaps before it retries.** An attempt killed mid-download leaves a
   partial, and a file that exists but does not hash to its pin must never be
   re-used. Each run sweeps first (`recovery.ts`), which is what makes the boot
   retry converge rather than re-inspecting the same torn file forever.
4. **Turning the feature on still downloads nothing.** `voice.wake.enabled`
   moving to `true` reads the artifacts and refuses honestly when they are
   missing, naming the recovery command. Installing and booting are the
   sanctioned acts, each with a receipt; a switch is not one.

`GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1` installs without the model — for an
air-gapped host, a CI image, or a user who does not want the feature. It is
reported in the same one-line message, so opting out never looks like a silent
failure.

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
sidecar and its own NOTICE. **Both** rows are provisioned, served, and counted in
the reported download size — see "Attribution is mandatory" below for why the
NOTICE is not optional:

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

**There are TWO redistributable artifacts here, so there are two NOTICEs, and both
are treated identically.** The classifier is ours; the front end is Google's
Apache-2.0 `speech_embedding` build, whose own
`goodvibes-speech-embedding-1.0.0.NOTICE.txt` carries that grant. The daemon
serves the embedding's bytes over the same chunk path it serves the classifier's
(`voice.wake.model.get`), which makes it a redistribution on exactly the same
terms. So both NOTICEs are:

- **fetched** by provisioning (`embedding-notice` is a component of the plan, not
  an afterthought);
- **counted** in `downloadBytes`, through the manifest's own
  `wakeWordProvisionBytes` and `wakeWordFrontEndProvisionBytes` rather than a
  hand-written sum at each call site — which is how the front end's NOTICE went
  uncounted and unfetched in the first place;
- **served** as their own chunk components (`notice`, `embedding-notice`), because
  a client that can fetch the bytes but not the NOTICE cannot satisfy the terms it
  received them under;
- **required for `ready`**, because an artifact whose attribution is not on disk is
  not one this tree may hand to anything; and
- **kept by the sweeper**, whose pinned-filename set names them explicitly. A file
  the provisioner writes and the sweeper does not recognise gets deleted once an
  hour, forever — that defect shipped once for the `.tflite`, and the front-end
  directory's NOTICE was the next place it could have happened.

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

## Known weaknesses

- **Minimal pairs.** At 0.9 it still fires on 24.7 % of never-trained near-miss
  phrases. "hey good vibes" is made of ordinary English words.
- **Non-speech audio.** The negative corpus is roughly 98 % English read speech
  — little music, no television, no non-English. The model has never been
  taught what those sound like and false-accepts more on them. This is the
  known, bounded reason to prefer the accent-diverse retrain when it lands.
- **Homophones.** "hay good vibes" fires 100 % of the time. That is unavoidable
  for this phrase.
