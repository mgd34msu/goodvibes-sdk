/**
 * provisioner.ts — managed one-act provisioning of the local voice runtime.
 *
 * Installs the piper TTS engine (binary + espeak-ng-data, from the pinned
 * checksummed tarball) and one default voice into a goodvibes-managed directory,
 * using the atomic + checksum-verified download machinery (downloadVerifiedFile).
 * Per-component and resumable: a re-run skips anything already present and
 * verified, and retries only what failed. Every step emits a structured progress
 * event a surface can render, and every terminal state is honest
 * (not-provisioned / download-failed / checksum-mismatch / unsupported-platform).
 *
 * STT (whisper.cpp) has no official prebuilt binary and this never compiles on
 * the user's machine, so STT is reported unsupported with a reason.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { downloadVerifiedFile, fileMatches, fileMatchesCached, fileSha256, type VerifiedDownloadResult } from './download-verified.js';
import type { VoiceInstallProgressSnapshot } from './install-progress.js';
import {
  DEFAULT_PIPER_VOICE,
  DEFAULT_WHISPER_MODEL,
  PIPER_ENGINES,
  WHISPER_ENGINES,
  WHISPER_UNSUPPORTED_REASON,
  currentVoicePlatform,
  piperProvisionBytes,
  type PiperEngineManifest,
  type PiperVoiceManifest,
  type WhisperEngineManifest,
  type WhisperModelManifest,
  type VoicePlatform,
} from './manifest.js';

/** The install stamp file: records installed versions + the config keys install wrote. */
const INSTALL_STAMP_FILE = 'install-stamp.json';

/** What the last successful install put on disk (versions) and wrote to config. */
export interface VoiceInstallStamp {
  readonly engineVersion: string;
  readonly voiceId: string;
  /** Installed whisper engine version (absent when STT is not provisioned). */
  readonly sttEngineVersion?: string | undefined;
  /** Installed whisper model id (absent when STT is not provisioned). */
  readonly sttModelId?: string | undefined;
  /** The exact voice.local.* values THIS installer wrote (ownership marker). */
  readonly configWrites: Record<string, string>;
}

export interface ManagedVoicePaths {
  readonly managedRoot: string;
  readonly enginesDir: string;
  readonly modelsDir: string;
  readonly piperArchive: string;
  readonly piperBinary: string;
  readonly defaultVoiceOnnx: string;
  readonly defaultVoiceJson: string;
  /** The whisper bundle archive path — ALSO the sideload drop location. */
  readonly whisperArchive: string;
  readonly whisperBinary: string;
  readonly whisperModel: string;
}

export function resolveManagedVoicePaths(managedRoot: string, platform?: VoicePlatform | null): ManagedVoicePaths {
  const enginesDir = join(managedRoot, 'engines');
  const modelsDir = join(managedRoot, 'models');
  // The binary's location inside the extracted archive comes from the PLATFORM
  // manifest entry — a platform whose tarball layout differs sets its own
  // binaryRelPath (a duplicated constant here silently broke that).
  const resolved = platform === undefined ? currentVoicePlatform() : platform;
  const binaryRelPath = (resolved ? PIPER_ENGINES[resolved]?.binaryRelPath : undefined) ?? 'piper/piper';
  const whisperRelPath = (resolved ? WHISPER_ENGINES[resolved]?.binaryRelPath : undefined) ?? 'whisper/whisper-cli';
  return {
    managedRoot,
    enginesDir,
    modelsDir,
    piperArchive: join(enginesDir, 'piper.tar.gz'),
    piperBinary: join(enginesDir, binaryRelPath),
    defaultVoiceOnnx: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx`),
    defaultVoiceJson: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx.json`),
    whisperArchive: join(enginesDir, 'whisper.tar.gz'),
    whisperBinary: join(enginesDir, whisperRelPath),
    whisperModel: join(modelsDir, `${DEFAULT_WHISPER_MODEL.id}.bin`),
  };
}

/** Read the install stamp, or null when absent/corrupt. */
export function readVoiceInstallStamp(managedRoot: string): VoiceInstallStamp | null {
  try {
    const raw = readFileSync(join(managedRoot, INSTALL_STAMP_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as VoiceInstallStamp;
    if (typeof parsed.engineVersion !== 'string' || typeof parsed.voiceId !== 'string') return null;
    return {
      engineVersion: parsed.engineVersion,
      voiceId: parsed.voiceId,
      ...(typeof parsed.sttEngineVersion === 'string' ? { sttEngineVersion: parsed.sttEngineVersion } : {}),
      ...(typeof parsed.sttModelId === 'string' ? { sttModelId: parsed.sttModelId } : {}),
      configWrites: parsed.configWrites ?? {},
    };
  } catch {
    return null;
  }
}

/** Persist the install stamp (best effort — a failed stamp write is logged, not fatal). */
export function writeVoiceInstallStamp(managedRoot: string, stamp: VoiceInstallStamp): void {
  try {
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, INSTALL_STAMP_FILE), JSON.stringify(stamp, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('voice install stamp write failed', { managedRoot, error: summarizeError(error) });
  }
}

export type ProvisionPhase = 'skip' | 'download' | 'verify' | 'extract' | 'done' | 'error';
export interface VoiceProvisionProgress {
  readonly component: string;
  readonly phase: ProvisionPhase;
  readonly message?: string | undefined;
  /** The component's pinned size in bytes, where the manifest knows it. */
  readonly bytesTotal?: number | undefined;
  /**
   * Bytes landed on disk, where known. Downloads verify whole-file (atomic
   * temp+rename), so this is reported at completion boundaries (done/skip),
   * not incrementally mid-transfer.
   */
  readonly bytesDone?: number | undefined;
}

export type TtsProvisionState = 'provisioned' | 'unsupported-platform' | 'download-failed' | 'checksum-mismatch';
/**
 * STT terminal states. `bundle-unavailable`: no hosted URL and no sideloaded
 * archive (and no usable binary). `sideload-mismatch`: an archive IS present at
 * the sideload path but fails the current pin, so it is refused rather than
 * extracted — reported explicitly so the user knows to rebuild/replace it.
 */
export type SttProvisionState = TtsProvisionState | 'bundle-unavailable' | 'sideload-mismatch';
export interface VoiceComponentOutcome {
  readonly id: string;
  readonly state: 'installed' | 'skipped' | 'failed';
  readonly bytes?: number | undefined;
  readonly error?: string | undefined;
}

export interface VoiceProvisionResult {
  readonly platform: VoicePlatform | null;
  readonly tts: {
    readonly engine: 'piper';
    readonly state: TtsProvisionState;
    readonly binaryPath?: string | undefined;
    readonly modelPath?: string | undefined;
    readonly reason?: string | undefined;
  };
  readonly stt: {
    readonly engine: 'whisper-cpp';
    readonly state: SttProvisionState;
    readonly binaryPath?: string | undefined;
    readonly modelPath?: string | undefined;
    readonly reason?: string | undefined;
  };
  readonly components: readonly VoiceComponentOutcome[];
}

export type ArchiveExtractor = (archivePath: string, destDir: string) => Promise<void>;

const defaultExtractor: ArchiveExtractor = async (archivePath, destDir) => {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', destDir], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`tar extract failed (exit ${code}): ${(await new Response(proc.stderr).text()).slice(0, 500)}`);
  }
};

export interface VoiceProvisionOptions {
  readonly managedRoot: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly onProgress?: ((progress: VoiceProvisionProgress) => void) | undefined;
  readonly extractArchive?: ArchiveExtractor | undefined;
  /** Override the detected platform (tests). */
  readonly platform?: VoicePlatform | null | undefined;
  /** Override the pinned engine manifest (tests / staged rollouts). */
  readonly engineOverride?: PiperEngineManifest | undefined;
  /** Override the pinned default voice manifest (tests / staged rollouts). */
  readonly voiceOverride?: PiperVoiceManifest | undefined;
  /** Override the pinned whisper engine manifest (tests / staged rollouts). */
  readonly whisperOverride?: WhisperEngineManifest | undefined;
  /** Override the pinned whisper model manifest (tests / staged rollouts). */
  readonly whisperModelOverride?: WhisperModelManifest | undefined;
}

/** Provision the managed local voice runtime (piper TTS + default voice). */
export async function provisionLocalVoiceRuntime(options: VoiceProvisionOptions): Promise<VoiceProvisionResult> {
  const platform = options.platform === undefined ? currentVoicePlatform() : options.platform;
  const emit = (
    component: string,
    phase: ProvisionPhase,
    message?: string,
    bytes?: { readonly bytesTotal?: number | undefined; readonly bytesDone?: number | undefined },
  ): void => {
    options.onProgress?.({
      component,
      phase,
      ...(message ? { message } : {}),
      ...(bytes?.bytesTotal !== undefined ? { bytesTotal: bytes.bytesTotal } : {}),
      ...(bytes?.bytesDone !== undefined ? { bytesDone: bytes.bytesDone } : {}),
    });
  };
  // STT resolves independently of TTS; the placeholder is replaced below.
  let stt: VoiceProvisionResult['stt'] = { engine: 'whisper-cpp', state: 'unsupported-platform', reason: WHISPER_UNSUPPORTED_REASON };

  const engine = options.engineOverride ?? (platform ? PIPER_ENGINES[platform] : undefined);
  const voice = options.voiceOverride ?? DEFAULT_PIPER_VOICE;
  if (!platform || !engine) {
    emit('piper-engine', 'error', 'no pinned piper build for this platform');
    return {
      platform,
      tts: { engine: 'piper', state: 'unsupported-platform', reason: `No pinned, checksum-verified piper build for platform "${platform ?? `${process.platform}/${process.arch}`}".` },
      stt,
      components: [],
    };
  }

  const paths = resolveManagedVoicePaths(options.managedRoot, platform);
  const components: VoiceComponentOutcome[] = [];
  const extractArchive = options.extractArchive ?? defaultExtractor;
  const priorStamp = readVoiceInstallStamp(options.managedRoot);

  const download = async (id: string, spec: { url: string; bytes: number; sha256: string }, dest: string): Promise<VerifiedDownloadResult> => {
    const result = await downloadVerifiedFile({
      spec,
      destPath: dest,
      fetchImpl: options.fetchImpl,
      // Byte-labeled progress: the pinned total is always known from the
      // manifest; completion boundaries (done/skip) report the landed bytes.
      onProgress: (phase, message) => emit(id, phase, message, {
        bytesTotal: spec.bytes,
        ...(phase === 'done' || phase === 'skip' ? { bytesDone: spec.bytes } : {}),
      }),
    });
    if (result.ok) {
      components.push({ id, state: result.skipped ? 'skipped' : 'installed', bytes: result.bytes });
    } else {
      components.push({ id, state: 'failed', error: result.error });
    }
    return result;
  };

  // 1. Default voice (onnx + json).
  const onnx = await download('piper-voice-onnx', voice.onnx, paths.defaultVoiceOnnx);
  const jsonCfg = onnx.ok ? await download('piper-voice-json', voice.json, paths.defaultVoiceJson) : null;

  // 2. Piper engine archive.
  const archive = onnx.ok && jsonCfg?.ok ? await download('piper-engine', engine.archive, paths.piperArchive) : null;

  // Collect the first hard failure for an honest terminal state.
  const failed = [onnx, jsonCfg, archive].find((r) => r && !r.ok) as Extract<VerifiedDownloadResult, { ok: false }> | undefined;
  if (failed) {
    const state: TtsProvisionState = failed.reason === 'checksum-mismatch' ? 'checksum-mismatch' : 'download-failed';
    emit('piper-engine', 'error', failed.error);
    return { platform, tts: { engine: 'piper', state, reason: failed.error }, stt, components };
  }

  // 3. Extract the engine. Extraction runs when the binary is missing OR the
  // pinned engine version differs from the installed stamp (a version bump
  // must REPLACE the old binary — skipping on mere existence made engine
  // updates a silent no-op) OR the archive was freshly re-downloaded.
  const archiveFresh = archive !== null && archive.ok && !archive.skipped;
  const versionChanged = priorStamp !== null && priorStamp.engineVersion !== engine.version;
  const needsExtract = !existsSync(paths.piperBinary) || versionChanged || archiveFresh;
  if (needsExtract) {
    try {
      emit('piper-engine', 'extract', versionChanged ? `updating piper engine ${priorStamp?.engineVersion} -> ${engine.version}` : 'extracting piper engine');
      await extractEngineAtomically(paths.enginesDir, paths.piperArchive, engine.binaryRelPath, extractArchive);
    } catch (error) {
      const message = summarizeError(error);
      emit('piper-engine', 'error', message);
      components.push({ id: 'piper-engine-extract', state: 'failed', error: message });
      return { platform, tts: { engine: 'piper', state: 'download-failed', reason: `piper extract failed: ${message}` }, stt, components };
    }
  }
  if (!isUsableBinary(paths.piperBinary)) {
    const message = `piper binary not found (or not executable) at ${paths.piperBinary} after extraction`;
    emit('piper-engine', 'error', message);
    return { platform, tts: { engine: 'piper', state: 'download-failed', reason: message }, stt, components };
  }

  // ── STT: the goodvibes-built whisper.cpp bundle + the default ggml model ──
  const whisperOutcome = await provisionWhisperStt({
    options,
    platform,
    paths,
    priorStamp,
    components,
    extractArchive,
    download,
    emit,
  });
  stt = whisperOutcome.stt;

  // Stamp the installed versions so a later manifest bump knows to replace.
  // STT provenance prefers what THIS run actually installed on disk; otherwise
  // it PRESERVES the prior stamp — a failed or absent STT half must never erase
  // sttEngineVersion/sttModelId, the only version provenance the sideload update
  // path has (a rewrite-erase would freeze a later correct sideload forever).
  const sttEngineVersion = whisperOutcome.installedEngineVersion ?? priorStamp?.sttEngineVersion;
  const sttModelId = whisperOutcome.installedModelId ?? priorStamp?.sttModelId;
  writeVoiceInstallStamp(options.managedRoot, {
    engineVersion: engine.version,
    voiceId: voice.id,
    ...(sttEngineVersion !== undefined ? { sttEngineVersion } : {}),
    ...(sttModelId !== undefined ? { sttModelId } : {}),
    configWrites: priorStamp?.configWrites ?? {},
  });

  emit('piper-engine', 'done', 'local voice runtime provisioned');
  return {
    platform,
    tts: { engine: 'piper', state: 'provisioned', binaryPath: paths.piperBinary, modelPath: paths.defaultVoiceOnnx },
    stt,
    components,
  };
}

/** The STT provision outcome plus what it ACTUALLY put on disk (for the stamp). */
interface WhisperProvisionOutcome {
  readonly stt: VoiceProvisionResult['stt'];
  /**
   * The whisper engine version now on disk, attestable ONLY when the installed
   * binary came from a pin-verified archive of that version. null when this run
   * did not (re)install a pin-verified engine — the caller then preserves the
   * prior stamp rather than claiming a version it cannot attest.
   */
  readonly installedEngineVersion: string | null;
  /** The whisper model id verified on disk this run, or null. */
  readonly installedModelId: string | null;
}

/**
 * Provision the STT half: the pinned whisper.cpp bundle (hosted URL when the
 * release pipeline has published it, else a sideloaded archive matching the
 * SAME pin at the managed archive path) plus the default ggml model from its
 * stable Hugging Face URL. Every terminal state is honest; an STT failure
 * never blocks TTS.
 *
 * Extraction is gated on the on-disk archive VERIFYING against the current pin:
 * a stale/mismatched archive is never extracted and its version is never
 * stamped over the running binary. A present-but-mismatched sideload archive is
 * reported explicitly (sideload-mismatch, or a skip note when an older verified
 * binary is still usable) rather than silently ignored.
 */
async function provisionWhisperStt(ctx: {
  readonly options: VoiceProvisionOptions;
  readonly platform: VoicePlatform;
  readonly paths: ManagedVoicePaths;
  readonly priorStamp: VoiceInstallStamp | null;
  readonly components: VoiceComponentOutcome[];
  readonly extractArchive: ArchiveExtractor;
  readonly download: (id: string, spec: { url: string; bytes: number; sha256: string }, dest: string) => Promise<VerifiedDownloadResult>;
  readonly emit: (component: string, phase: ProvisionPhase, message?: string) => void;
}): Promise<WhisperProvisionOutcome> {
  const { options, platform, paths, priorStamp, components, extractArchive, download, emit } = ctx;
  const whisper = options.whisperOverride ?? WHISPER_ENGINES[platform];
  const model = options.whisperModelOverride ?? DEFAULT_WHISPER_MODEL;
  const unprovisioned = (stt: VoiceProvisionResult['stt']): WhisperProvisionOutcome =>
    ({ stt, installedEngineVersion: null, installedModelId: null });
  if (!whisper) {
    return unprovisioned({ engine: 'whisper-cpp', state: 'unsupported-platform', reason: WHISPER_UNSUPPORTED_REASON });
  }
  const pinSpec = { url: '', bytes: whisper.bundle.bytes, sha256: whisper.bundle.sha256 };

  // Obtain the engine bundle. `bundleVerified` gates extraction: it is true ONLY
  // when the on-disk archive matches the current pin (fresh verified download,
  // or a pin-matching sideload) — extraction never runs against an unverified
  // archive, so a bumped version can never be stamped over an old binary.
  let archiveFresh = false;
  let bundleVerified = false;
  if (whisper.bundle.url) {
    const result = await download('whisper-engine', { url: whisper.bundle.url, bytes: whisper.bundle.bytes, sha256: whisper.bundle.sha256 }, paths.whisperArchive);
    if (!result.ok) {
      const state: SttProvisionState = result.reason === 'checksum-mismatch' ? 'checksum-mismatch' : 'download-failed';
      emit('whisper-engine', 'error', result.error);
      return unprovisioned({ engine: 'whisper-cpp', state, reason: result.error });
    }
    archiveFresh = !result.skipped;
    bundleVerified = true;
  } else {
    const archivePresent = existsSync(paths.whisperArchive);
    const archiveMatchesPin = archivePresent && fileMatches(paths.whisperArchive, pinSpec);
    if (archiveMatchesPin) {
      bundleVerified = true;
      emit('whisper-engine', 'skip', 'using the sideloaded whisper bundle (pin verified)');
      components.push({ id: 'whisper-engine', state: 'skipped', bytes: whisper.bundle.bytes });
      // A pin-matching archive whose version differs from the stamp is a NEWLY
      // sideloaded bundle: force extraction even though an old usable binary
      // exists, so the update actually applies (else it would freeze forever).
      if (priorStamp?.sttEngineVersion !== undefined && priorStamp.sttEngineVersion !== whisper.version) {
        archiveFresh = true;
      }
    } else if (archivePresent) {
      // Present but fails the current pin — NEVER extract it. Report honestly.
      const got = fileSha256(paths.whisperArchive);
      const reason = `A whisper bundle is present at ${paths.whisperArchive} but does not match the pinned sha256 (got ${(got ?? 'unreadable').slice(0, 12)}…, want ${whisper.bundle.sha256.slice(0, 12)}…). Rebuild it byte-for-byte with scripts/build-whisper-bundle.ts, or wait for a release that hosts it. Local TTS is unaffected.`;
      if (isUsableBinary(paths.whisperBinary)) {
        // An older verified binary is still installed — keep serving it; the pin
        // update simply cannot be applied from a mismatched archive, and the
        // stamp stays at the recorded (old) version rather than claiming the new.
        emit('whisper-engine', 'skip', reason);
        components.push({ id: 'whisper-engine', state: 'skipped', error: reason });
      } else {
        emit('whisper-engine', 'error', reason);
        components.push({ id: 'whisper-engine', state: 'failed', error: reason });
        return unprovisioned({ engine: 'whisper-cpp', state: 'sideload-mismatch', reason });
      }
    } else if (!isUsableBinary(paths.whisperBinary)) {
      const reason = `The whisper.cpp ${whisper.version} bundle for ${platform} is pinned (sha256 ${whisper.bundle.sha256.slice(0, 12)}…) but not yet hosted. Build it reproducibly with scripts/build-whisper-bundle.ts and drop the archive at ${paths.whisperArchive}, or wait for a release that hosts it. Local TTS is unaffected.`;
      emit('whisper-engine', 'error', reason);
      components.push({ id: 'whisper-engine', state: 'failed', error: reason });
      return unprovisioned({ engine: 'whisper-cpp', state: 'bundle-unavailable', reason });
    }
    // else: no archive present but a usable binary is already installed — keep it.
  }

  // Model (real hosted URL, checksum-pinned).
  const modelResult = await download('whisper-model', model.bin, paths.whisperModel);
  if (!modelResult.ok) {
    const state: SttProvisionState = modelResult.reason === 'checksum-mismatch' ? 'checksum-mismatch' : 'download-failed';
    emit('whisper-model', 'error', modelResult.error);
    return unprovisioned({ engine: 'whisper-cpp', state, reason: modelResult.error });
  }

  // Atomic extract — ONLY from a pin-verified archive. A version bump or missing
  // binary that cannot be served from a verified archive is left as-is above.
  const versionChanged = priorStamp?.sttEngineVersion !== undefined && priorStamp.sttEngineVersion !== whisper.version;
  const needsExtract = bundleVerified && (!isUsableBinary(paths.whisperBinary) || versionChanged || archiveFresh);
  if (needsExtract) {
    if (!existsSync(paths.whisperArchive)) {
      const reason = `whisper bundle archive missing at ${paths.whisperArchive}`;
      return unprovisioned({ engine: 'whisper-cpp', state: 'bundle-unavailable', reason });
    }
    try {
      emit('whisper-engine', 'extract', versionChanged ? `updating whisper engine ${priorStamp?.sttEngineVersion} -> ${whisper.version}` : 'extracting whisper engine');
      await extractEngineAtomically(paths.enginesDir, paths.whisperArchive, whisper.binaryRelPath, extractArchive);
    } catch (error) {
      const message = summarizeError(error);
      emit('whisper-engine', 'error', message);
      components.push({ id: 'whisper-engine-extract', state: 'failed', error: message });
      return unprovisioned({ engine: 'whisper-cpp', state: 'download-failed', reason: `whisper extract failed: ${message}` });
    }
  }
  if (!isUsableBinary(paths.whisperBinary)) {
    const message = `whisper binary not found (or not executable) at ${paths.whisperBinary} after extraction`;
    emit('whisper-engine', 'error', message);
    return unprovisioned({ engine: 'whisper-cpp', state: 'download-failed', reason: message });
  }
  emit('whisper-engine', 'done', 'local STT provisioned');
  // Only claim the pinned version when the installed binary is attestably from a
  // pin-verified archive; otherwise preserve whatever the prior stamp recorded.
  const installedEngineVersion = bundleVerified ? whisper.version : (priorStamp?.sttEngineVersion ?? null);
  return {
    stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: paths.whisperBinary, modelPath: paths.whisperModel },
    installedEngineVersion,
    installedModelId: model.id,
  };
}

/** A binary is usable when it exists, is non-empty, and is executable. */
function isUsableBinary(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Atomic engine extraction: untar into a TEMP directory, verify the expected
 * binary exists non-empty and executable, then swap the extracted tree into
 * place (old tree renamed aside and removed). A kill mid-tar can never leave a
 * truncated binary at the final path reporting 'provisioned' — the exact
 * partial-artifact class the download side already prevents via temp+rename.
 */
async function extractEngineAtomically(
  enginesDir: string,
  archivePath: string,
  binaryRelPath: string,
  extractArchive: ArchiveExtractor,
): Promise<void> {
  const topDir = binaryRelPath.split('/')[0]!; // the archive's root dir (e.g. 'piper', 'whisper')
  const finalTree = join(enginesDir, topDir);
  const tmpDir = join(enginesDir, `.extract-${Date.now().toString(36)}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    await extractArchive(archivePath, tmpDir);
    const extractedBinary = join(tmpDir, binaryRelPath);
    if (!isUsableBinary(extractedBinary)) {
      throw new Error(`extracted archive is missing a usable binary at ${binaryRelPath}`);
    }
    // Swap: move the old tree aside, rename the new one in, drop the old.
    const oldTree = `${finalTree}.old`;
    rmSync(oldTree, { recursive: true, force: true });
    if (existsSync(finalTree)) renameSync(finalTree, oldTree);
    renameSync(join(tmpDir, topDir), finalTree);
    rmSync(oldTree, { recursive: true, force: true });
  } finally {
    // Partial-extract cleanup: the temp tree never lingers.
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export type VoiceRuntimeState = 'not-provisioned' | 'partial' | 'provisioned' | 'unsupported-platform';
export interface VoiceRuntimeStatus {
  readonly platform: VoicePlatform | null;
  readonly state: VoiceRuntimeState;
  readonly tts: {
    readonly engine: 'piper';
    readonly binaryPresent: boolean;
    readonly voicePresent: boolean;
    readonly binaryPath: string;
    readonly modelPath: string;
  };
  readonly stt: {
    readonly engine: 'whisper-cpp';
    /** A pinned goodvibes whisper bundle exists for this platform. */
    readonly supported: boolean;
    readonly state: 'not-provisioned' | 'partial' | 'provisioned' | 'unsupported-platform';
    readonly binaryPresent: boolean;
    readonly modelPresent: boolean;
    readonly binaryPath: string;
    readonly modelPath: string;
    readonly reason?: string | undefined;
  };
  /** Total download size of a fresh provision, in bytes (null on unsupported platforms). */
  readonly offerBytes: number | null;
  /**
   * Present ONLY while a voice.local.install run is active: the live
   * per-component progress of that run (the daemon composition merges it in —
   * see install-progress.ts). Surfaces poll status during install to render
   * real progress instead of busy→receipt.
   */
  readonly installInProgress?: VoiceInstallProgressSnapshot | undefined;
}

/** Report whether the managed voice runtime is installed, without touching the network. */
export function localVoiceRuntimeStatus(options: { managedRoot: string; platform?: VoicePlatform | null | undefined }): VoiceRuntimeStatus {
  const platform = options.platform === undefined ? currentVoicePlatform() : options.platform;
  const paths = resolveManagedVoicePaths(options.managedRoot, platform);
  const whisper = platform ? WHISPER_ENGINES[platform] : undefined;
  const sttBinaryPresent = isUsableBinary(paths.whisperBinary);
  const sttModelPresent = fileMatchesCached(paths.whisperModel, DEFAULT_WHISPER_MODEL.bin);
  const stt: VoiceRuntimeStatus['stt'] = whisper
    ? {
        engine: 'whisper-cpp',
        supported: true,
        state: sttBinaryPresent && sttModelPresent ? 'provisioned' : (sttBinaryPresent || sttModelPresent) ? 'partial' : 'not-provisioned',
        binaryPresent: sttBinaryPresent,
        modelPresent: sttModelPresent,
        binaryPath: paths.whisperBinary,
        modelPath: paths.whisperModel,
        ...(whisper.bundle.url === null && !sttBinaryPresent
          ? { reason: `The pinned whisper.cpp ${whisper.version} bundle (sha256 ${whisper.bundle.sha256.slice(0, 12)}…) is not yet hosted. Build it byte-for-byte with scripts/build-whisper-bundle.ts and drop the archive at ${paths.whisperArchive} — it must match the pin exactly (the script produces a reproducible tarball) — or wait for a hosting release.` }
          : {}),
      }
    : {
        engine: 'whisper-cpp',
        supported: false,
        state: 'unsupported-platform',
        binaryPresent: false,
        modelPresent: false,
        binaryPath: paths.whisperBinary,
        modelPath: paths.whisperModel,
        reason: WHISPER_UNSUPPORTED_REASON,
      };
  if (!platform || !PIPER_ENGINES[platform]) {
    return {
      platform,
      state: 'unsupported-platform',
      tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: paths.piperBinary, modelPath: paths.defaultVoiceOnnx },
      stt,
      offerBytes: null,
    };
  }
  const binaryPresent = isUsableBinary(paths.piperBinary);
  // Cached verification: hashing the 63MB model on every status poll would
  // block the event loop for hundreds of ms; the cache keys on
  // (path, size, mtime) and the full hash still runs on provisioning decisions.
  const voicePresent = fileMatchesCached(paths.defaultVoiceOnnx, DEFAULT_PIPER_VOICE.onnx) && existsSync(paths.defaultVoiceJson);
  const state: VoiceRuntimeState = binaryPresent && voicePresent ? 'provisioned' : (binaryPresent || voicePresent) ? 'partial' : 'not-provisioned';
  return {
    platform,
    state,
    tts: { engine: 'piper', binaryPresent, voicePresent, binaryPath: paths.piperBinary, modelPath: paths.defaultVoiceOnnx },
    stt,
    offerBytes: piperProvisionBytes(platform),
  };
}

/**
 * Resolve managed engine binary + model for a config prefix, when the managed
 * install is present. Only TTS (piper) is managed; STT returns null (unsupported).
 */
export function resolveManagedEngine(
  prefix: 'stt' | 'tts',
  managedRoot: string,
  fileExists: (path: string) => boolean = existsSync,
): { engine: string; binary: string; modelPath: string } | null {
  const paths = resolveManagedVoicePaths(managedRoot);
  if (prefix === 'tts') {
    if (!fileExists(paths.piperBinary) || !fileExists(paths.defaultVoiceOnnx)) return null;
    return { engine: 'piper', binary: paths.piperBinary, modelPath: paths.defaultVoiceOnnx };
  }
  // STT: the goodvibes-built whisper.cpp bundle + the default ggml model.
  if (!fileExists(paths.whisperBinary) || !fileExists(paths.whisperModel)) return null;
  return { engine: 'whisper-cpp', binary: paths.whisperBinary, modelPath: paths.whisperModel };
}
