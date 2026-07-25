# The `hey goodvibes` wake-word model

The pinned wake-word classifier, its measured behavior, and the attribution it
ships with. The pin itself lives in
`packages/sdk/src/platform/voice/provisioning/wake-word-manifest.ts`.

The wake-word **engine, config surface, provisioning flow and UI are not built
yet**. This page and the manifest describe the published artifact only. The
manifest ships ahead of the integration deliberately, as the pin it will read.

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

## Known weaknesses

- **Minimal pairs.** At 0.9 it still fires on 24.7 % of never-trained near-miss
  phrases. "hey good vibes" is made of ordinary English words.
- **Non-speech audio.** The negative corpus is roughly 98 % English read speech
  — little music, no television, no non-English. The model has never been
  taught what those sound like and false-accepts more on them. This is the
  known, bounded reason to prefer the accent-diverse retrain when it lands.
- **Homophones.** "hay good vibes" fires 100 % of the time. That is unavoidable
  for this phrase.
