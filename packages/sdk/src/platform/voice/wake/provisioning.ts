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
 * Nothing here downloads on its own. Provisioning is an explicit act, matching
 * the rest of the local voice stack.
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
  wakeWordProvisionBytes,
  type WakeWordModelManifest,
} from '../provisioning/wake-word-manifest.js';
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
  /** The pinned classifier for the resolved version. */
  readonly classifierPath: string;
  /** The attribution NOTICE that must travel with the classifier. */
  readonly noticePath: string;
  /** The speech-embedding backbone. */
  readonly embeddingPath: string;
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
    noticePath: join(modelsDir, `goodvibes-wakeword-hey-goodvibes-${modelVersion}.NOTICE.txt`),
    embeddingPath: join(frontEndDir, `speech-embedding-${WAKE_WORD_FRONT_END.embedding.version}.onnx`),
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

/** Whether the wake-word runtime can start, and if not, honestly why. */
export interface WakeProvisionStatus {
  readonly ready: boolean;
  readonly reason: WakeUnavailableReason | null;
  readonly classifier: WakeArtifactStatus;
  readonly notice: WakeArtifactStatus;
  readonly embedding: WakeArtifactStatus;
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
      notice: empty,
      embedding: wakeArtifactStatus(paths.embeddingPath, embeddingSpec),
      downloadBytes: 0,
      modelVersion: null,
      recallIsSyntheticOnly: true,
    };
  }
  const classifier = wakeArtifactStatus(paths.classifierPath, model.onnx);
  const notice = wakeArtifactStatus(paths.noticePath, model.notice);
  const embedding = wakeArtifactStatus(paths.embeddingPath, embeddingSpec);
  const anyCorrupt = classifier.corrupt || notice.corrupt || embedding.corrupt;
  const allVerified = classifier.verified && notice.verified && embedding.verified;
  return {
    ready: allVerified,
    reason: allVerified ? null : anyCorrupt ? 'checksum-mismatch' : 'not-provisioned',
    classifier,
    notice,
    embedding,
    downloadBytes: wakeWordProvisionBytes(model) + embeddingSpec.bytes,
    modelVersion: model.version,
    recallIsSyntheticOnly: model.measurements.recallIsSyntheticOnly,
  };
}

/** Progress for one artifact during provisioning. */
export interface WakeProvisionProgress {
  readonly component: 'classifier' | 'notice' | 'embedding';
  readonly phase: 'skip' | 'download' | 'verify' | 'done' | 'error';
  readonly message?: string | undefined;
  readonly bytesTotal?: number | undefined;
}

/** One artifact's outcome. */
export interface WakeComponentOutcome {
  readonly component: 'classifier' | 'notice' | 'embedding';
  readonly state: 'installed' | 'skipped' | 'failed';
  readonly path: string;
  readonly bytes?: number | undefined;
  /** Honest "got X, want Y" on a checksum failure. */
  readonly error?: string | undefined;
}

export interface WakeProvisionResult {
  readonly ready: boolean;
  readonly modelVersion: string | null;
  readonly outcomes: readonly WakeComponentOutcome[];
  /** The attribution NOTICE's path, which must travel with redistributed artifacts. */
  readonly noticePath: string | null;
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
      recallIsSyntheticOnly: true,
    };
  }
  mkdirSync(paths.modelsDir, { recursive: true });
  mkdirSync(paths.frontEndDir, { recursive: true });

  const plan: readonly { component: WakeComponentOutcome['component']; spec: VerifiedDownloadSpec; dest: string }[] = [
    { component: 'embedding', spec: WAKE_WORD_FRONT_END.embedding.download, dest: paths.embeddingPath },
    { component: 'classifier', spec: model.onnx, dest: paths.classifierPath },
    { component: 'notice', spec: model.notice, dest: paths.noticePath },
  ];

  const outcomes: WakeComponentOutcome[] = [];
  for (const step of plan) {
    outcomes.push(await provisionOne(step, options));
  }
  const ready = outcomes.every((outcome) => outcome.state !== 'failed');
  return {
    ready,
    modelVersion: model.version,
    outcomes,
    noticePath: ready ? paths.noticePath : null,
    recallIsSyntheticOnly: model.measurements.recallIsSyntheticOnly,
  };
}

async function provisionOne(
  step: { component: WakeComponentOutcome['component']; spec: VerifiedDownloadSpec; dest: string },
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
