/**
 * wake-word-manifest.ts — the PINNED wake-word classifier manifest.
 *
 * Same contract as the piper/whisper pins in ./manifest.ts: exact version, URL,
 * byte size and sha256 for every artifact, hosted at the ONE append-only
 * `voice-runtimes-v1` release tag with a `<asset>.sha256` sidecar. Nothing is
 * fetched without a matching checksum.
 *
 * WHY THIS FILE IS DATA AND NOTHING ELSE
 *
 * A better classifier is expected to replace the pin below (an accent-diverse
 * retrain is the known next one). Swapping it must be a one-entry change here —
 * add the new version to {@link WAKE_WORD_MODELS}, move
 * {@link DEFAULT_WAKE_WORD_MODEL_VERSION} — and nothing else. Consumers read the
 * default through {@link resolveWakeWordModel}, so no consumer holds a version,
 * URL, or checksum of its own. Old versions stay listed and stay fetchable,
 * because the hosted assets are append-only and are never deleted.
 *
 * The wake-word engine, config surface, provisioning flow and recovery
 * housekeeping read this pin — see `platform/voice/wake/`. Per-surface audio
 * capture and UI do not live in the SDK, because capture is genuinely
 * per-surface: the engine takes 16 kHz frames and returns detections.
 *
 * THE CLASSIFIER IS THE LAST STAGE OF A THREE-STAGE PIPELINE
 *
 *     audio -> melspectrogram -> speech-embedding backbone -> this classifier
 *
 * It consumes speech EMBEDDINGS, not audio, so it cannot run alone. A runtime
 * must also provide the two front-end models. Source them from Google's own
 * Apache-2.0 `speech_embedding` TFHub distribution rather than redistributing
 * openWakeWord's copies — see {@link WAKE_WORD_FRONT_END_SOURCING} — so the
 * provenance traces to that Apache-2.0 grant directly.
 */
import type { VerifiedDownloadSpec } from './download-verified.js';

/**
 * The one append-only release tag every voice runtime asset is hosted at.
 * Declared before the manifests below because they are evaluated at module load.
 */
const VOICE_RUNTIMES_BASE =
  'https://github.com/mgd34msu/goodvibes-sdk/releases/download/voice-runtimes-v1';

/**
 * How a runtime should obtain the two front-end models this classifier sits
 * behind. Stated here so a provisioning flow surfaces the sourcing rule rather
 * than restating it.
 *
 * The melspectrogram stage is an untrained, fixed DSP graph (STFT plus a mel
 * filterbank and window function) with no learned parameters. The embedding
 * stage is Google's `speech_embedding` model, which openWakeWord's own README
 * identifies as "provided by Google as a TFHub module under an Apache-2.0
 * license". Taking both from Google's distribution keeps the provenance
 * unambiguous.
 */
export const WAKE_WORD_FRONT_END_SOURCING =
  "This classifier consumes speech embeddings, not audio: a runtime must also provide the melspectrogram and speech-embedding front-end models. Export them from Google's Apache-2.0 speech_embedding TFHub distribution rather than redistributing openWakeWord's copies, so their provenance traces to that Apache-2.0 grant. The melspectrogram stage is an untrained DSP graph (STFT + mel filterbank) with no learned parameters.";

/**
 * The front end, as actually built. {@link WAKE_WORD_FRONT_END_SOURCING} states
 * the rule; this states what satisfying it produced.
 *
 * Both stages were re-sourced away from openWakeWord's copies, and both were
 * measured against them, because the pinned classifier was TRAINED against that
 * front end — if the front end shifts, every number in docs/wake-word-model.md
 * stops describing the running detector.
 */
export interface WakeWordFrontEndManifest {
  /**
   * Stage 1. Not a download: a fixed STFT + mel filterbank with no learned
   * parameters, computed in `platform/voice/wake/melspectrogram.ts`. Its
   * constants were recovered numerically from openWakeWord's own
   * `melspectrogram.onnx` initializers rather than chosen.
   */
  readonly melspectrogram: {
    readonly computedInCode: true;
    /** Largest absolute deviation, in dB, from the reference graph's output. */
    readonly maxAbsDeviationDb: number;
    /** Mel values compared to establish that deviation. */
    readonly valuesCompared: number;
  };
  /** Stage 2. Google's model, re-sourced from Google's own Apache-2.0 distribution. */
  readonly embedding: {
    readonly version: string;
    readonly license: string;
    /**
     * Google's own distribution the weights came from. Recorded so provenance
     * traces to the Apache-2.0 grant directly, not through a third party.
     */
    readonly sourceUrl: string;
    /** The attribution NOTICE, hosted beside the artifact and checksummed like it. */
    readonly notice: VerifiedDownloadSpec;
    /** Our ONNX build of those weights, hosted on the append-only release tag. */
    readonly download: VerifiedDownloadSpec;
    /** Input shape the pipeline feeds it: one 76-frame, 32-bin mel window. */
    readonly inputDims: readonly number[];
    /** Embedding width it emits per window. */
    readonly outputDim: number;
    /**
     * Largest absolute difference, per output element, from openWakeWord's copy
     * of the same model. 0 means bit-exact on every element measured.
     */
    readonly maxAbsDeviation: number;
    /** Inputs the deviation above was measured over. */
    readonly inputsCompared: number;
  };
  /**
   * End-to-end evidence: the largest change in the CLASSIFIER's score caused by
   * running the re-sourced front end instead of openWakeWord's, and whether any
   * detection decision changed as a result.
   */
  readonly endToEnd: {
    readonly maxAbsScoreDeviation: number;
    readonly framesCompared: number;
    readonly decisionFlipsAtRecommendedThreshold: number;
  };
}

/**
 * The pinned front end. The melspectrogram stage carries no URL because there
 * is nothing to download — removing that download is the point.
 */
export const WAKE_WORD_FRONT_END: WakeWordFrontEndManifest = {
  melspectrogram: {
    computedInCode: true,
    maxAbsDeviationDb: 4.292e-5,
    valuesCompared: 4_713_216,
  },
  embedding: {
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl:
      'https://www.kaggle.com/api/v1/models/google/speech-embedding/tensorFlow1/speech-embedding/1/download',
    notice: {
      url: `${VOICE_RUNTIMES_BASE}/goodvibes-speech-embedding-1.0.0.NOTICE.txt`,
      bytes: 3434,
      sha256: '2e9426d943fdd65fbf881c7ecc3bd1c68fda30a1334cce4de2787e607c48d6f3',
    },
    download: {
      url: `${VOICE_RUNTIMES_BASE}/goodvibes-speech-embedding-1.0.0.onnx`,
      bytes: 1319365,
      sha256: '463e5c778f7f623bb1ee52e82daad200f36a947738fe191c247ba1fbc5eed28a',
    },
    inputDims: [1, 76, 32, 1],
    outputDim: 96,
    maxAbsDeviation: 0,
    inputsCompared: 2464,
  },
  endToEnd: {
    maxAbsScoreDeviation: 8.464e-6,
    framesCompared: 11_061,
    decisionFlipsAtRecommendedThreshold: 0,
  },
};

/**
 * openWakeWord ships a default detection threshold of 0.5. For this phrase that
 * is too low, so every pinned model below carries its own measured
 * `recommendedThreshold` and callers must use it rather than the upstream
 * default. See {@link WakeWordModelManifest.recommendedThreshold}.
 */
export const OPENWAKEWORD_UPSTREAM_DEFAULT_THRESHOLD = 0.5;

/** Measured detection quality at the recommended threshold. */
export interface WakeWordModelMeasurements {
  /** The threshold every figure here was measured at. */
  readonly threshold: number;
  /**
   * Fraction of wake-phrase utterances detected, 0..1.
   *
   * SYNTHETIC ONLY — see {@link recallIsSyntheticOnly}.
   */
  readonly recall: number;
  /**
   * Fraction of never-trained minimal-pair phrases ("hey good vibe check",
   * "hey goodbye vibes", …) that wrongly fire, 0..1. Lower is better.
   */
  readonly minimalPairFalseAcceptRate: number;
  /** False accepts per hour on held-out real human speech never trained on. */
  readonly falseAcceptsPerHourRealSpeech: number;
  /**
   * Always true today, and stated rather than hidden: no human recording of the
   * wake phrase exists yet, so recall is measured entirely on text-to-speech
   * output from a single VITS model — no real microphones, no real rooms, no
   * accents outside the synthesis model's distribution, no children, no
   * whispering, no speakerphone. The false-accept figures ARE measured on real
   * human speech. A human test pass is required before this ships as a default.
   */
  readonly recallIsSyntheticOnly: boolean;
}

/** One pinned wake-word classifier, in both runtime formats. */
export interface WakeWordModelManifest {
  /** Wake phrase this classifier detects. */
  readonly phrase: string;
  /** Manifest version of THIS artifact set — bumped per retrain, not per SDK release. */
  readonly version: string;
  /** SPDX identifier of the grant the artifacts themselves ship under. */
  readonly license: string;
  /**
   * The attribution NOTICE, hosted next to the artifacts. Several training
   * corpora are CC BY, which REQUIRES attribution — a deployment that
   * redistributes these artifacts must carry this NOTICE with them. It is
   * checksummed like any other asset so it cannot be silently swapped.
   */
  readonly notice: VerifiedDownloadSpec;
  /** onnxruntime format (node/web). */
  readonly onnx: VerifiedDownloadSpec;
  /** TensorFlow Lite format (mobile). Bit-identical decisions to the onnx twin. */
  readonly tflite: VerifiedDownloadSpec;
  /**
   * The threshold to run at. NOT openWakeWord's 0.5 — see
   * {@link OPENWAKEWORD_UPSTREAM_DEFAULT_THRESHOLD}.
   */
  readonly recommendedThreshold: number;
  /** Measured quality at {@link recommendedThreshold}. */
  readonly measurements: WakeWordModelMeasurements;
  /** One-line plain statement of what trained it, for a UI that describes the model. */
  readonly provenance: string;
}

/**
 * Every pinned wake-word model, keyed by version. Append-only: an entry is
 * added for a new retrain and existing entries are never edited or removed,
 * because the hosted assets they point at are never re-uploaded or renamed.
 */
export const WAKE_WORD_MODELS: Readonly<Record<string, WakeWordModelManifest>> = {
  '1.0.0': {
    phrase: 'hey goodvibes',
    version: '1.0.0',
    license: 'Apache-2.0',
    notice: {
      url: `${VOICE_RUNTIMES_BASE}/goodvibes-wakeword-hey-goodvibes-1.0.0.NOTICE.txt`,
      bytes: 5574,
      sha256: '7d85d7b37ac37dbe3753cabaae3ace8d8d35052ea6902cc9b27ec0051e594ab0',
    },
    onnx: {
      url: `${VOICE_RUNTIMES_BASE}/goodvibes-wakeword-hey-goodvibes-1.0.0.onnx`,
      bytes: 2367644,
      sha256: '89a0b7b565d433cb73e3dd24476274fdbec2c71925a63185973303861c0467d9',
    },
    tflite: {
      url: `${VOICE_RUNTIMES_BASE}/goodvibes-wakeword-hey-goodvibes-1.0.0.tflite`,
      bytes: 2369264,
      sha256: '05da156c040e497d7e71f1892e4f773e46d8f9a3ef24ba1c2572d30241647c8a',
    },
    recommendedThreshold: 0.9,
    measurements: {
      threshold: 0.9,
      recall: 0.968,
      minimalPairFalseAcceptRate: 0.247,
      falseAcceptsPerHourRealSpeech: 0.13,
      recallIsSyntheticOnly: true,
    },
    provenance:
      'Trained on synthetic speech from a LibriTTS-R VITS model, with negative and background audio from LibriSpeech, MUSAN music/rfm and noise, and openSLR SLR26/28 simulated room impulse responses. Every training corpus is attribution-only or public domain; none is NonCommercial, ShareAlike, or NoDerivatives.',
  },
};

/** One measured operating point of the speech gate, on held-out frames. */
export interface WakeVadThresholdRow {
  /** `voice.wake.vadThreshold` value this row describes. */
  readonly threshold: number;
  /**
   * Fraction of held-out SPEECH frames that pass the gate and reach the
   * classifier, 0..1. This is the number that decides whether a wake can fire at
   * all, so it is the one to read first: a gated speech frame is a wake that
   * cannot happen.
   */
  readonly speechPassRate: number;
  /**
   * Fraction of held-out NON-SPEECH frames the gate stops, 0..1 — classifier
   * inferences not run, which is the entire point of the stage.
   */
  readonly noiseGateRate: number;
}

/**
 * The speech gate `voice.wake.vadThreshold` turns on: OUR speech/non-speech
 * head, trained by us, over the SAME pinned embedding the wake classifier sits
 * behind.
 *
 * WHY A HEAD RATHER THAN A SEPARATE VAD MODEL
 *
 * The front end (melspectrogram + {@link WAKE_WORD_FRONT_END}) already runs once
 * per 80 ms frame for the classifier. A head over that same 96-dimension
 * embedding costs a few thousand multiply-adds and NO extra front-end pass, and
 * provisions with artifacts the surface already has. A standalone VAD would add
 * its own front end, its own download, and its own provenance to keep honest.
 */
export interface WakeVadModelManifest {
  /** Manifest version of this head — bumped per retrain, not per SDK release. */
  readonly version: string;
  /** SPDX identifier of the grant the artifact ships under. */
  readonly license: string;
  /** Attribution NOTICE, hosted beside the artifacts and checksummed like them. */
  readonly notice: VerifiedDownloadSpec;
  /** onnxruntime format (node/web). */
  readonly onnx: VerifiedDownloadSpec;
  /** TensorFlow Lite format (mobile). */
  readonly tflite: VerifiedDownloadSpec;
  /** The embedding manifest version this head was trained against. */
  readonly frontEndVersion: string;
  /** Input the graph takes: one 96-dimension embedding frame. */
  readonly inputDims: readonly number[];
  /** Graph input/output names, recorded so a host can assert what it loaded. */
  readonly inputName: string;
  readonly outputName: string;
  /**
   * The threshold to run at, measured. Read this rather than picking a round
   * number: the shipped `voice.wake.vadThreshold` default is 0 (gate off), and
   * this is what to set it to when turning the gate on.
   */
  readonly recommendedThreshold: number;
  /** Measured behaviour across operating points, on held-out frames. */
  readonly thresholds: readonly WakeVadThresholdRow[];
  /** How the figures above were measured. */
  readonly measurements: {
    /** Held-out frames scored. */
    readonly evalFrames: number;
    /** How many of those were speech. */
    readonly evalSpeechFrames: number;
    /**
     * Largest absolute difference between the onnx and tflite twins' outputs over
     * the frames compared, and how many detection decisions that changed at the
     * recommended threshold. 0 flips means the twins decide identically.
     */
    readonly maxAbsTwinDeviation: number;
    readonly twinDecisionFlips: number;
    readonly twinFramesCompared: number;
  };
  /** One-line plain statement of what trained it, for a UI that describes it. */
  readonly provenance: string;
}

/**
 * The pinned speech gate.
 *
 * Hosted on the same append-only `voice-runtimes-v1` tag as every other voice
 * artifact, provisioned with the wake models, and verified by content before use.
 *
 * THE ASSETS LAND WITH THIS ROUND'S RELEASE. The byte counts and checksums below
 * are of the built artifacts and are what the upload must match; until the upload
 * happens a provision reports the gate as failed and `vadReady` false, while the
 * detector itself stays ready — which is why the gate is not part of
 * `WakeProvisionStatus.ready`.
 */
export const WAKE_VAD_MODEL: WakeVadModelManifest = {
  version: '1.0.0',
  license: 'Apache-2.0',
  notice: {
    url: `${VOICE_RUNTIMES_BASE}/goodvibes-vad-1.0.0.NOTICE.txt`,
    bytes: 6786,
    sha256: '3d8d27800798397e4b1974712e28753f0c149018be733421d84bfe6cc16546d0',
  },
  onnx: {
    url: `${VOICE_RUNTIMES_BASE}/goodvibes-vad-1.0.0.onnx`,
    bytes: 15885,
    sha256: '0ee90b4849f667211fc8fdd27f3c459560108db64b8978f17ae2b27c65596aab',
  },
  tflite: {
    url: `${VOICE_RUNTIMES_BASE}/goodvibes-vad-1.0.0.tflite`,
    bytes: 18136,
    sha256: 'f8f1903c075b3d8cb0c7998ae613bbbf31ad5c2bd4c090fde3f83cfed588fdcd',
  },
  frontEndVersion: '1.0.0',
  inputDims: [1, 96],
  inputName: 'embedding',
  outputName: 'speech_probability',
  // The two errors are not symmetric: a gated speech frame is a wake that cannot
  // fire, while a passed non-speech frame costs one classifier inference. 0.3 is
  // where speech pass rate starts falling faster than noise gating rises.
  recommendedThreshold: 0.3,
  thresholds: [
    { threshold: 0.05, speechPassRate: 0.9859, noiseGateRate: 0.7768 },
    { threshold: 0.1, speechPassRate: 0.9778, noiseGateRate: 0.8845 },
    { threshold: 0.2, speechPassRate: 0.9683, noiseGateRate: 0.9376 },
    { threshold: 0.3, speechPassRate: 0.9603, noiseGateRate: 0.9565 },
    { threshold: 0.4, speechPassRate: 0.9526, noiseGateRate: 0.9667 },
    { threshold: 0.5, speechPassRate: 0.9451, noiseGateRate: 0.9735 },
    { threshold: 0.6, speechPassRate: 0.9366, noiseGateRate: 0.9786 },
    { threshold: 0.7, speechPassRate: 0.9262, noiseGateRate: 0.9824 },
    { threshold: 0.8, speechPassRate: 0.9111, noiseGateRate: 0.9862 },
    { threshold: 0.9, speechPassRate: 0.8833, noiseGateRate: 0.9903 },
  ],
  measurements: {
    evalFrames: 106_390,
    evalSpeechFrames: 44_286,
    maxAbsTwinDeviation: 5.364e-7,
    twinDecisionFlips: 0,
    twinFramesCompared: 2000,
  },
  provenance:
    'Trained by the GoodVibes project: a 3,713-parameter head (96 -> 32 -> 16 -> 1) over the same pinned '
    + 'speech-embedding front end the wake classifier uses, on 278,553 frames of LibriSpeech train-clean-100 and '
    + 'MUSAN speech against MUSAN noise and music, with per-file gain randomisation and half the speech mixed with '
    + 'noise at 0-18 dB SNR so the head cannot learn loudness as a proxy for speech. Every corpus is '
    + 'attribution-only or public domain; none is NonCommercial, ShareAlike, or NoDerivatives.',
};

/**
 * Total download size of the speech gate's artifacts (bytes), for an offer.
 *
 * Counts what a provision FETCHES — the onnx head and its NOTICE — and not the
 * tflite twin, which is pinned here for a runtime that cannot load onnx but is
 * not part of the plan, because nothing in this SDK loads it. The rule this obeys
 * is the one the classifier's twin was fixed to obey: a reported download size
 * has to describe the set of artifacts actually fetched, or `voice.wake.status`
 * quotes a figure for a download that never happens. The classifier's twin is
 * counted by {@link wakeWordProvisionBytes} because the plan fetches it; this one
 * is not counted because the plan does not.
 */
export function wakeVadProvisionBytes(vad: WakeVadModelManifest = WAKE_VAD_MODEL): number {
  return vad.onnx.bytes + vad.notice.bytes;
}

/**
 * The measured row for a configured threshold, or the nearest one below it, so a
 * surface can state what a chosen value actually does instead of guessing.
 */
export function resolveWakeVadThreshold(
  threshold: number,
  vad: WakeVadModelManifest = WAKE_VAD_MODEL,
): WakeVadThresholdRow | null {
  let best: WakeVadThresholdRow | null = null;
  for (const row of vad.thresholds) {
    if (row.threshold > threshold) continue;
    if (best === null || row.threshold > best.threshold) best = row;
  }
  return best ?? vad.thresholds[0] ?? null;
}

/**
 * The version {@link resolveWakeWordModel} returns. Moving this line is the
 * whole of adopting a newer model.
 */
export const DEFAULT_WAKE_WORD_MODEL_VERSION = '1.0.0';

/**
 * The pinned model to use. Callers read the default through this rather than
 * indexing {@link WAKE_WORD_MODELS} with a version of their own, so a model
 * swap stays a one-line change in this file.
 */
export function resolveWakeWordModel(
  version: string = DEFAULT_WAKE_WORD_MODEL_VERSION,
): WakeWordModelManifest | null {
  return WAKE_WORD_MODELS[version] ?? null;
}

/** Total download size of a wake-word model's artifacts (bytes), for an offer. */
export function wakeWordProvisionBytes(model: WakeWordModelManifest): number {
  return model.onnx.bytes + model.tflite.bytes + model.notice.bytes;
}

/**
 * Total download size of the front end's artifacts (bytes).
 *
 * A function beside {@link wakeWordProvisionBytes} rather than an addition at
 * each call site, and for the reason the front end's own NOTICE exposed: a
 * consumer summing `embedding.download.bytes` by hand quietly omitted the
 * attribution file, so the reported download size described a set of artifacts
 * that was not the set being fetched. The melspectrogram stage contributes
 * nothing — it is computed in code, which is the point of it.
 */
export function wakeWordFrontEndProvisionBytes(): number {
  return WAKE_WORD_FRONT_END.embedding.download.bytes + WAKE_WORD_FRONT_END.embedding.notice.bytes;
}
