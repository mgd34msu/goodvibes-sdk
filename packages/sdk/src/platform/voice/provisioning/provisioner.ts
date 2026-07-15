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
import { downloadVerifiedFile, fileMatchesCached, type VerifiedDownloadResult } from './download-verified.js';
import {
  DEFAULT_PIPER_VOICE,
  PIPER_ENGINES,
  WHISPER_UNSUPPORTED_REASON,
  currentVoicePlatform,
  piperProvisionBytes,
  type PiperEngineManifest,
  type PiperVoiceManifest,
  type VoicePlatform,
} from './manifest.js';

/** The install stamp file: records installed versions + the config keys install wrote. */
const INSTALL_STAMP_FILE = 'install-stamp.json';

/** What the last successful install put on disk (versions) and wrote to config. */
export interface VoiceInstallStamp {
  readonly engineVersion: string;
  readonly voiceId: string;
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
}

export function resolveManagedVoicePaths(managedRoot: string, platform?: VoicePlatform | null): ManagedVoicePaths {
  const enginesDir = join(managedRoot, 'engines');
  const modelsDir = join(managedRoot, 'models');
  // The binary's location inside the extracted archive comes from the PLATFORM
  // manifest entry — a platform whose tarball layout differs sets its own
  // binaryRelPath (a duplicated constant here silently broke that).
  const resolved = platform === undefined ? currentVoicePlatform() : platform;
  const binaryRelPath = (resolved ? PIPER_ENGINES[resolved]?.binaryRelPath : undefined) ?? 'piper/piper';
  return {
    managedRoot,
    enginesDir,
    modelsDir,
    piperArchive: join(enginesDir, 'piper.tar.gz'),
    piperBinary: join(enginesDir, binaryRelPath),
    defaultVoiceOnnx: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx`),
    defaultVoiceJson: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx.json`),
  };
}

/** Read the install stamp, or null when absent/corrupt. */
export function readVoiceInstallStamp(managedRoot: string): VoiceInstallStamp | null {
  try {
    const raw = readFileSync(join(managedRoot, INSTALL_STAMP_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as VoiceInstallStamp;
    if (typeof parsed.engineVersion !== 'string' || typeof parsed.voiceId !== 'string') return null;
    return { engineVersion: parsed.engineVersion, voiceId: parsed.voiceId, configWrites: parsed.configWrites ?? {} };
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
}

export type TtsProvisionState = 'provisioned' | 'unsupported-platform' | 'download-failed' | 'checksum-mismatch';
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
  readonly stt: { readonly engine: 'whisper-cpp'; readonly state: 'unsupported-platform'; readonly reason: string };
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
}

/** Provision the managed local voice runtime (piper TTS + default voice). */
export async function provisionLocalVoiceRuntime(options: VoiceProvisionOptions): Promise<VoiceProvisionResult> {
  const platform = options.platform === undefined ? currentVoicePlatform() : options.platform;
  const stt = { engine: 'whisper-cpp' as const, state: 'unsupported-platform' as const, reason: WHISPER_UNSUPPORTED_REASON };
  const emit = (component: string, phase: ProvisionPhase, message?: string): void => {
    options.onProgress?.({ component, phase, ...(message ? { message } : {}) });
  };

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
      onProgress: (phase, message) => emit(id, phase, message),
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
      await extractPiperAtomically(paths, engine.binaryRelPath, extractArchive);
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

  // Stamp the installed versions so a later manifest bump knows to replace.
  writeVoiceInstallStamp(options.managedRoot, {
    engineVersion: engine.version,
    voiceId: voice.id,
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
async function extractPiperAtomically(
  paths: ManagedVoicePaths,
  binaryRelPath: string,
  extractArchive: ArchiveExtractor,
): Promise<void> {
  const topDir = binaryRelPath.split('/')[0]!; // the archive's root dir (e.g. 'piper')
  const finalTree = join(paths.enginesDir, topDir);
  const tmpDir = join(paths.enginesDir, `.extract-${Date.now().toString(36)}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    await extractArchive(paths.piperArchive, tmpDir);
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
  readonly stt: { readonly engine: 'whisper-cpp'; readonly supported: false; readonly reason: string };
  /** Total download size of a fresh provision, in bytes (null on unsupported platforms). */
  readonly offerBytes: number | null;
}

/** Report whether the managed voice runtime is installed, without touching the network. */
export function localVoiceRuntimeStatus(options: { managedRoot: string; platform?: VoicePlatform | null | undefined }): VoiceRuntimeStatus {
  const platform = options.platform === undefined ? currentVoicePlatform() : options.platform;
  const paths = resolveManagedVoicePaths(options.managedRoot, platform);
  const stt = { engine: 'whisper-cpp' as const, supported: false as const, reason: WHISPER_UNSUPPORTED_REASON };
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
  if (prefix !== 'tts') return null;
  const paths = resolveManagedVoicePaths(managedRoot);
  if (!fileExists(paths.piperBinary) || !fileExists(paths.defaultVoiceOnnx)) return null;
  return { engine: 'piper', binary: paths.piperBinary, modelPath: paths.defaultVoiceOnnx };
}
