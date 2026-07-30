/**
 * provisioning.ts — managed, checksum-pinned download of the wake-word models.
 *
 * Two artifacts have to be on disk before the detector can run: our pinned
 * classifier, and the Google `speech_embedding` backbone it sits behind. Both
 * are fetched from the append-only `voice-runtimes-v1` release tag against a
 * pinned byte count and sha256, through the same verified-download path the
 * piper and whisper runtimes use — so a truncated body, a proxy's error page,
 * or a swapped asset is refused and NOTHING is left at the destination.
 *
 * The classifier is pinned in BOTH runtime formats and both are fetched: the
 * onnx build is what every current host loads, and the tflite twin is the same
 * classifier for a runtime that cannot load onnx. Fetching both is what lets
 * runtime/wake-setup.ts serve either one to a surface that cannot fetch release
 * assets itself, and it is what the reported download size has always counted
 * ({@link wakeWordProvisionBytes} includes the tflite).
 *
 * BOTH ATTRIBUTION NOTICES TRAVEL, AND BOTH GATE READINESS
 *
 * Two artifacts are redistributed out of this tree — our classifier and Google's
 * Apache-2.0 `speech_embedding` build — and each is published with an attribution
 * file a deployment carrying the artifact must carry with it. Both are therefore
 * fetched, both are served by the chunk path a browser reads through, and both
 * count toward {@link WakeProvisionStatus.ready}: an artifact whose attribution is
 * not on disk is not one this tree may hand to anything. Fetching one NOTICE and
 * not the other would have left half the attribution set on the server it came
 * from, which is exactly what happened until the embedding's was added here.
 *
 * The ONE artifact that does not gate readiness is the tflite twin, because
 * nothing in this SDK loads it: a host that got the onnx build, both NOTICEs and
 * the front end can detect, and reporting otherwise would be a lie in the
 * unhelpful direction.
 *
 * DOWNLOADED ARTIFACTS ARE PERSISTED STATE, SO THEY GET REAL HOUSEKEEPING
 *
 * This exact bug class has already cost this project a training run: a feature
 * cache pre-allocated its file, a crash left a full-size zero-filled file
 * behind, and an existence-only check treated it as complete. So nothing here
 * asks whether a file exists:
 *
 *  - {@link wakeArtifactStatus} verifies by CONTENT (size + sha256) and reports
 *    a present-but-failing file as `corrupt`, distinct from missing.
 *  - {@link provisionWakeWordModels} re-fetches anything that fails
 *    verification instead of using it, and is resumable by re-run: an artifact
 *    that already matches is skipped without re-downloading.
 *  - Reaping of stale versions, abandoned partial downloads, and retained audio
 *    lives in recovery.ts and runs at recovery time and periodically, with a
 *    written receipt so a deletion is never silent.
 *
 * WHEN THIS RUNS, AND WHAT STILL NEVER DOWNLOADS
 *
 * The model ships WITH the installation: the installer and the npm postinstall
 * call the install policy in ./install-provision.ts, and a daemon retries at
 * boot whatever the install could not get. So a fresh machine has the artifacts
 * without the user asking, which is the point — an always-listening feature the
 * user has to go and fetch a model for is a feature most people never reach.
 *
 * What did NOT change is the runtime rule. Nothing in this file downloads as a
 * side effect of anything: {@link wakeProvisionStatus} only reads, and turning
 * `voice.wake.enabled` on never fetches — a host missing the artifacts reports
 * not-provisioned and names the recovery command. Install-time and boot-time
 * provisioning are sanctioned acts with a receipt; flipping a switch is not.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import {
  downloadVerifiedFile,
  fileMatches,
  fileSha256,
  type VerifiedDownloadSpec,
} from '../provisioning/download-verified.js';
import {
  resolveWakeWordModel,
  WAKE_WORD_FRONT_END,
  wakeWordFrontEndProvisionBytes,
  wakeWordProvisionBytes,
  type WakeWordModelManifest,
} from '../provisioning/wake-word-manifest.js';
import { DEFAULT_WAKE_MODEL_ID } from '../../config/schema-domain-voice-wake.js';
import type { WakeArtifactStatus, WakeUnavailableReason } from './types.js';

/** Directory layout of the managed wake-word tree. */
export interface ManagedWakePaths {
  /** `<managedRoot>/wake`. */
  readonly wakeRoot: string;
  /** Pinned classifiers, one file per model version. */
  readonly modelsDir: string;
  /** The shared speech-embedding backbone. */
  readonly frontEndDir: string;
  /** User-supplied models, never checksum-pinned. */
  readonly customDir: string;
  /** Session-scoped retained audio, only used when retainAudio is session-temp. */
  readonly retainedDir: string;
  /** The pinned classifier for the resolved version, in onnx form. */
  readonly classifierPath: string;
  /**
   * The same pinned classifier in TensorFlow Lite form, for a runtime that
   * cannot load onnx. Provisioned beside the onnx build so the daemon can serve
   * either form; not required for the detector this SDK runs.
   */
  readonly mobileClassifierPath: string;
  /** The attribution NOTICE that must travel with the classifier. */
  readonly noticePath: string;
  /** The speech-embedding backbone. */
  readonly embeddingPath: string;
  /**
   * The attribution NOTICE that must travel with the speech-embedding backbone,
   * on exactly the terms the classifier's does.
   *
   * Two artifacts are redistributed by this tree — the classifier and Google's
   * Apache-2.0 `speech_embedding` build — and each carries an attribution file
   * that a deployment redistributing it must carry with it. The daemon serves the
   * embedding's bytes over the same chunk path it serves the classifier's, so
   * fetching one NOTICE and not the other would leave half the attribution set on
   * the server it was published from.
   */
  readonly embeddingNoticePath: string;
}

/** Resolve the managed wake-word paths for a model version. */
export function resolveManagedWakePaths(managedRoot: string, version?: string): ManagedWakePaths {
  const wakeRoot = join(managedRoot, 'wake');
  const modelsDir = join(wakeRoot, 'models');
  const frontEndDir = join(wakeRoot, 'front-end');
  const model = resolveWakeWordModel(version);
  const modelVersion = model?.version ?? 'unresolved';
  return {
    wakeRoot,
    modelsDir,
    frontEndDir,
    customDir: join(wakeRoot, 'custom'),
    retainedDir: join(wakeRoot, 'retained'),
    classifierPath: join(modelsDir, `goodvibes-wakeword-hey-goodvibes-${modelVersion}.onnx`),
    mobileClassifierPath: join(modelsDir, `goodvibes-wakeword-hey-goodvibes-${modelVersion}.tflite`),
    noticePath: join(modelsDir, `goodvibes-wakeword-hey-goodvibes-${modelVersion}.NOTICE.txt`),
    embeddingPath: join(frontEndDir, `speech-embedding-${WAKE_WORD_FRONT_END.embedding.version}.onnx`),
    embeddingNoticePath: join(frontEndDir, `speech-embedding-${WAKE_WORD_FRONT_END.embedding.version}.NOTICE.txt`),
  };
}

/**
 * Content-verified status of one artifact. `verified` means the bytes on disk
 * hash to the pin — never that the path exists.
 */
export function wakeArtifactStatus(path: string, spec: VerifiedDownloadSpec): WakeArtifactStatus {
  if (!existsSync(path)) {
    return { path, verified: false, corrupt: false, bytes: 0 };
  }
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    return { path, verified: false, corrupt: true, bytes: 0 };
  }
  const verified = fileMatches(path, spec);
  return { path, verified, corrupt: !verified, bytes };
}

/** One model the engine should load, resolved to a file. */
export interface ResolvedWakeModelFile {
  readonly id: string;
  readonly path: string;
  /**
   * True for the managed, checksum-pinned artifact. False for a file loaded from
   * a custom directory as-is — which `voice.wake.customModelDir`'s description
   * promises explicitly, because it is the difference between a model whose
   * bytes were verified and one that was not.
   */
  readonly pinned: boolean;
}

/**
 * Turn `voice.wake.models` into files to load.
 *
 * The pinned default id resolves inside the managed tree. Any other id resolves
 * against `voice.wake.customModelDir`, and when that row is EMPTY it falls back
 * to the managed `custom` directory — the fallback the row's description
 * promises, implemented here rather than left for each host to re-derive, since
 * a host that skipped it would look for custom models in the process's working
 * directory.
 */
export function resolveWakeModelFiles(
  modelIds: readonly string[],
  options: { readonly managedRoot: string; readonly customModelDir?: string | undefined; readonly version?: string | undefined },
): readonly ResolvedWakeModelFile[] {
  const paths = resolveManagedWakePaths(options.managedRoot, options.version);
  const customRoot = (options.customModelDir ?? '').trim();
  const customDir = customRoot.length > 0 ? customRoot : paths.customDir;
  return modelIds.map((id) => (
    id === DEFAULT_WAKE_MODEL_ID
      ? { id, path: paths.classifierPath, pinned: true }
      : { id, path: join(customDir, `${id}.onnx`), pinned: false }
  ));
}

/** Whether the wake-word runtime can start, and if not, honestly why. */
export interface WakeProvisionStatus {
  readonly ready: boolean;
  readonly reason: WakeUnavailableReason | null;
  readonly classifier: WakeArtifactStatus;
  /**
   * The tflite twin of the classifier. Reported so a surface can say whether the
   * daemon can serve that form, and deliberately NOT part of {@link ready}: the
   * detector this SDK runs loads the onnx build, so a host missing only the
   * tflite is a host that detects.
   */
  readonly mobileClassifier: WakeArtifactStatus;
  readonly notice: WakeArtifactStatus;
  readonly embedding: WakeArtifactStatus;
  /**
   * The front end's attribution NOTICE. Part of {@link ready} for the same reason
   * the classifier's `notice` is: an artifact whose attribution is not on disk is
   * not an artifact this tree may hand to anything, and the daemon hands the
   * embedding's bytes to browsers.
   */
  readonly embeddingNotice: WakeArtifactStatus;
  /** Total bytes a fresh provision would download. */
  readonly downloadBytes: number;
  /** The model version these paths resolve to, or null when unpinned. */
  readonly modelVersion: string | null;
  /**
   * Always true today and surfaced wherever the model is described: the recall
   * figures behind this model are measured on synthesised speech only. No human
   * has recorded the wake phrase.
   */
  readonly recallIsSyntheticOnly: boolean;
}

/** Report what is on disk, verifying by content. Never downloads. */
export function wakeProvisionStatus(options: {
  readonly managedRoot: string;
  readonly version?: string | undefined;
}): WakeProvisionStatus {
  const model = resolveWakeWordModel(options.version);
  const paths = resolveManagedWakePaths(options.managedRoot, options.version);
  const embeddingSpec = WAKE_WORD_FRONT_END.embedding.download;
  if (model === null) {
    const empty: WakeArtifactStatus = { path: '', verified: false, corrupt: false, bytes: 0 };
    return {
      ready: false,
      reason: 'not-provisioned',
      classifier: empty,
      mobileClassifier: empty,
      notice: empty,
      embedding: wakeArtifactStatus(paths.embeddingPath, embeddingSpec),
      embeddingNotice: wakeArtifactStatus(paths.embeddingNoticePath, WAKE_WORD_FRONT_END.embedding.notice),
      downloadBytes: 0,
      modelVersion: null,
      recallIsSyntheticOnly: true,
    };
  }
  const classifier = wakeArtifactStatus(paths.classifierPath, model.onnx);
  const mobileClassifier = wakeArtifactStatus(paths.mobileClassifierPath, model.tflite);
  const notice = wakeArtifactStatus(paths.noticePath, model.notice);
  const embedding = wakeArtifactStatus(paths.embeddingPath, embeddingSpec);
  const embeddingNotice = wakeArtifactStatus(paths.embeddingNoticePath, WAKE_WORD_FRONT_END.embedding.notice);
  // The two NOTICEs count exactly as much as the artifacts they attribute: an
  // attribution file that is not on disk cannot travel with bytes this tree hands
  // out, and the daemon hands both the classifier's and the embedding's to browsers.
  const anyCorrupt = classifier.corrupt || notice.corrupt || embedding.corrupt || embeddingNotice.corrupt;
  const allVerified = classifier.verified && notice.verified && embedding.verified && embeddingNotice.verified;
  return {
    ready: allVerified,
    reason: allVerified ? null : anyCorrupt ? 'checksum-mismatch' : 'not-provisioned',
    classifier,
    mobileClassifier,
    notice,
    embedding,
    embeddingNotice,
    // Both totals come from the manifest's own helpers rather than being summed
    // field by field here, which is how the front end's NOTICE went uncounted.
    downloadBytes: wakeWordProvisionBytes(model) + wakeWordFrontEndProvisionBytes(),
    modelVersion: model.version,
    recallIsSyntheticOnly: model.measurements.recallIsSyntheticOnly,
  };
}

/**
 * Which artifact a progress event or outcome is about.
 *
 * `mobile-classifier` is the tflite form of the same classifier — a separate
 * component rather than a detail of `classifier`, so a receipt can report one
 * landing and the other not. `embedding-notice` is the front end's attribution
 * file, listed on the same terms as the classifier's `notice`: two artifacts are
 * redistributed from this tree and each has its own NOTICE to travel with.
 */
export type WakeProvisionComponent =
  | 'classifier'
  | 'mobile-classifier'
  | 'notice'
  | 'embedding'
  | 'embedding-notice';

/** Progress for one artifact during provisioning. */
export interface WakeProvisionProgress {
  readonly component: WakeProvisionComponent;
  readonly phase: 'skip' | 'download' | 'verify' | 'done' | 'error';
  readonly message?: string | undefined;
  readonly bytesTotal?: number | undefined;
}

/** One artifact's outcome. */
export interface WakeComponentOutcome {
  readonly component: WakeProvisionComponent;
  readonly state: 'installed' | 'skipped' | 'failed';
  readonly path: string;
  readonly bytes?: number | undefined;
  /** Honest "got X, want Y" on a checksum failure. */
  readonly error?: string | undefined;
}

export interface WakeProvisionResult {
  /**
   * The DETECTOR can run: the onnx classifier, its NOTICE and the embedding all
   * landed. Deliberately not "every artifact landed" — see
   * {@link mobileFormatReady} — because this is the field a surface renders as
   * "wake works", and the tflite twin is not something the detector loads.
   */
  readonly ready: boolean;
  /** The tflite form landed too, so the daemon can serve it. */
  readonly mobileFormatReady: boolean;
  readonly modelVersion: string | null;
  readonly outcomes: readonly WakeComponentOutcome[];
  /** The classifier's attribution NOTICE, which must travel with it wherever it goes. */
  readonly noticePath: string | null;
  /** The front end's attribution NOTICE, on exactly the same terms. */
  readonly embeddingNoticePath: string | null;
  /** Restated at every provisioning boundary, not only in docs. */
  readonly recallIsSyntheticOnly: boolean;
}

export interface WakeProvisionOptions {
  readonly managedRoot: string;
  readonly version?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onProgress?: ((progress: WakeProvisionProgress) => void) | undefined;
}

/**
 * Download and verify every wake-word artifact.
 *
 * Resumable: re-running after a partial or interrupted provision re-checks each
 * artifact by content and fetches only what does not already match. An artifact
 * present but failing its checksum is REPLACED, never used — a truncated or
 * mismatched download is a re-fetch, and if the re-fetch also fails the result
 * says so rather than reporting success over a bad file.
 */
export async function provisionWakeWordModels(options: WakeProvisionOptions): Promise<WakeProvisionResult> {
  const model = resolveWakeWordModel(options.version);
  const paths = resolveManagedWakePaths(options.managedRoot, options.version);
  if (model === null) {
    return {
      ready: false,
      mobileFormatReady: false,
      modelVersion: null,
      outcomes: [
        {
          component: 'classifier',
          state: 'failed',
          path: '',
          error: `no wake-word model pinned for version "${options.version ?? '(default)'}"`,
        },
      ],
      noticePath: null,
      embeddingNoticePath: null,
      recallIsSyntheticOnly: true,
    };
  }
  mkdirSync(paths.modelsDir, { recursive: true });
  mkdirSync(paths.frontEndDir, { recursive: true });

  // Order matters for a partial network: the three the detector needs come
  // first, so an install that loses the connection part-way still leaves a
  // WORKING detector rather than a tflite file and nothing to run.
  const plan: readonly { component: WakeProvisionComponent; spec: VerifiedDownloadSpec; dest: string }[] = [
    { component: 'embedding', spec: WAKE_WORD_FRONT_END.embedding.download, dest: paths.embeddingPath },
    { component: 'embedding-notice', spec: WAKE_WORD_FRONT_END.embedding.notice, dest: paths.embeddingNoticePath },
    { component: 'classifier', spec: model.onnx, dest: paths.classifierPath },
    { component: 'notice', spec: model.notice, dest: paths.noticePath },
    { component: 'mobile-classifier', spec: model.tflite, dest: paths.mobileClassifierPath },
  ];

  const outcomes: WakeComponentOutcome[] = [];
  for (const step of plan) {
    outcomes.push(await provisionOne(step, options));
  }
  const landed = (component: WakeProvisionComponent): boolean =>
    outcomes.some((outcome) => outcome.component === component && outcome.state !== 'failed');
  const ready = landed('classifier') && landed('notice') && landed('embedding') && landed('embedding-notice');
  return {
    ready,
    mobileFormatReady: landed('mobile-classifier'),
    modelVersion: model.version,
    outcomes,
    // Each NOTICE's own outcome decides its path, not the run's: it must travel
    // with whatever WAS redistributed, and it is on disk whenever its fetch
    // succeeded, however the rest of the run went.
    noticePath: landed('notice') ? paths.noticePath : null,
    embeddingNoticePath: landed('embedding-notice') ? paths.embeddingNoticePath : null,
    recallIsSyntheticOnly: model.measurements.recallIsSyntheticOnly,
  };
}

async function provisionOne(
  step: { component: WakeProvisionComponent; spec: VerifiedDownloadSpec; dest: string },
  options: WakeProvisionOptions,
): Promise<WakeComponentOutcome> {
  const { component, spec, dest } = step;
  // Content check before anything else: a file that exists but does not hash to
  // the pin is treated as absent, and its bad hash is reported rather than swallowed.
  if (existsSync(dest) && !fileMatches(dest, spec)) {
    logger.warn('wake artifact failed verification and will be re-fetched', {
      component,
      path: dest,
      expectedSha256: spec.sha256,
      actualSha256: fileSha256(dest) ?? '(unreadable)',
    });
  }
  options.onProgress?.({ component, phase: 'download', bytesTotal: spec.bytes });
  const result = await downloadVerifiedFile({
    spec,
    destPath: dest,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    onProgress: (phase, message) => {
      options.onProgress?.({
        component,
        phase: phase === 'skip' ? 'skip' : phase,
        ...(message !== undefined ? { message } : {}),
        bytesTotal: spec.bytes,
      });
    },
  });
  if (!result.ok) {
    options.onProgress?.({ component, phase: 'error', message: result.error });
    return { component, state: 'failed', path: dest, error: `${result.reason}: ${result.error}` };
  }
  options.onProgress?.({ component, phase: 'done', bytesTotal: spec.bytes });
  return {
    component,
    state: result.skipped ? 'skipped' : 'installed',
    path: dest,
    bytes: result.bytes,
  };
}

/**
 * The wake-phrase model's user-facing description, including the qualification
 * that must accompany every surfacing of it.
 *
 * Wherever a surface names the model, it names this too. The recall figures are
 * measured entirely on text-to-speech output — no human has recorded the phrase
 * "hey goodvibes" — so quoting a recall number without this sentence would
 * present a synthetic result as a real one.
 */
export function describeWakeModel(model: WakeWordModelManifest): string {
  const { measurements } = model;
  const recall = `${(measurements.recall * 100).toFixed(1)}%`;
  const minimalPairs = `${(measurements.minimalPairFalseAcceptRate * 100).toFixed(1)}%`;
  const synthetic = measurements.recallIsSyntheticOnly
    ? ' Recall is measured on synthesised speech only — no human recording of the phrase exists, '
      + 'so this figure has no real microphones, rooms, or accents behind it. The false-accept figures '
      + 'ARE measured on real human speech.'
    : '';
  return (
    `"${model.phrase}" v${model.version} (${model.license}). At the recommended threshold of `
    + `${model.recommendedThreshold}: ${recall} recall, ${minimalPairs} of never-trained near-miss phrases `
    + `wrongly fire, ${measurements.falseAcceptsPerHourRealSpeech} false accepts per hour on real speech.${synthetic}`
  );
}
