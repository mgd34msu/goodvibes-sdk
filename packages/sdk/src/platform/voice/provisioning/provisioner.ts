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
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { downloadVerifiedFile, fileMatches, type VerifiedDownloadResult } from './download-verified.js';
import {
  DEFAULT_PIPER_VOICE,
  PIPER_ENGINES,
  WHISPER_UNSUPPORTED_REASON,
  currentVoicePlatform,
  piperProvisionBytes,
  type VoicePlatform,
} from './manifest.js';

/** The piper binary path inside the extracted archive, relative to the engines dir. */
const PIPER_BINARY_REL = 'piper/piper';

export interface ManagedVoicePaths {
  readonly managedRoot: string;
  readonly enginesDir: string;
  readonly modelsDir: string;
  readonly piperArchive: string;
  readonly piperBinary: string;
  readonly defaultVoiceOnnx: string;
  readonly defaultVoiceJson: string;
}

export function resolveManagedVoicePaths(managedRoot: string): ManagedVoicePaths {
  const enginesDir = join(managedRoot, 'engines');
  const modelsDir = join(managedRoot, 'models');
  return {
    managedRoot,
    enginesDir,
    modelsDir,
    piperArchive: join(enginesDir, 'piper.tar.gz'),
    piperBinary: join(enginesDir, PIPER_BINARY_REL),
    defaultVoiceOnnx: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx`),
    defaultVoiceJson: join(modelsDir, `${DEFAULT_PIPER_VOICE.id}.onnx.json`),
  };
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
}

/** Provision the managed local voice runtime (piper TTS + default voice). */
export async function provisionLocalVoiceRuntime(options: VoiceProvisionOptions): Promise<VoiceProvisionResult> {
  const platform = options.platform === undefined ? currentVoicePlatform() : options.platform;
  const stt = { engine: 'whisper-cpp' as const, state: 'unsupported-platform' as const, reason: WHISPER_UNSUPPORTED_REASON };
  const emit = (component: string, phase: ProvisionPhase, message?: string): void => {
    options.onProgress?.({ component, phase, ...(message ? { message } : {}) });
  };

  const engine = platform ? PIPER_ENGINES[platform] : undefined;
  if (!platform || !engine) {
    emit('piper-engine', 'error', 'no pinned piper build for this platform');
    return {
      platform,
      tts: { engine: 'piper', state: 'unsupported-platform', reason: `No pinned, checksum-verified piper build for platform "${platform ?? `${process.platform}/${process.arch}`}".` },
      stt,
      components: [],
    };
  }

  const paths = resolveManagedVoicePaths(options.managedRoot);
  const components: VoiceComponentOutcome[] = [];
  const extractArchive = options.extractArchive ?? defaultExtractor;

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
  const onnx = await download('piper-voice-onnx', DEFAULT_PIPER_VOICE.onnx, paths.defaultVoiceOnnx);
  const jsonCfg = onnx.ok ? await download('piper-voice-json', DEFAULT_PIPER_VOICE.json, paths.defaultVoiceJson) : null;

  // 2. Piper engine archive.
  const archive = onnx.ok && jsonCfg?.ok ? await download('piper-engine', engine.archive, paths.piperArchive) : null;

  // Collect the first hard failure for an honest terminal state.
  const failed = [onnx, jsonCfg, archive].find((r) => r && !r.ok) as Extract<VerifiedDownloadResult, { ok: false }> | undefined;
  if (failed) {
    const state: TtsProvisionState = failed.reason === 'checksum-mismatch' ? 'checksum-mismatch' : 'download-failed';
    emit('piper-engine', 'error', failed.error);
    return { platform, tts: { engine: 'piper', state, reason: failed.error }, stt, components };
  }

  // 3. Extract the engine (skip if the binary is already present).
  if (!existsSync(paths.piperBinary)) {
    try {
      emit('piper-engine', 'extract', 'extracting piper engine');
      await extractArchive(paths.piperArchive, paths.enginesDir);
    } catch (error) {
      const message = summarizeError(error);
      emit('piper-engine', 'error', message);
      components.push({ id: 'piper-engine-extract', state: 'failed', error: message });
      return { platform, tts: { engine: 'piper', state: 'download-failed', reason: `piper extract failed: ${message}` }, stt, components };
    }
  }
  if (!existsSync(paths.piperBinary)) {
    const message = `piper binary not found at ${paths.piperBinary} after extraction`;
    emit('piper-engine', 'error', message);
    return { platform, tts: { engine: 'piper', state: 'download-failed', reason: message }, stt, components };
  }

  emit('piper-engine', 'done', 'local voice runtime provisioned');
  return {
    platform,
    tts: { engine: 'piper', state: 'provisioned', binaryPath: paths.piperBinary, modelPath: paths.defaultVoiceOnnx },
    stt,
    components,
  };
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
  const paths = resolveManagedVoicePaths(options.managedRoot);
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
  const binaryPresent = existsSync(paths.piperBinary);
  const voicePresent = fileMatches(paths.defaultVoiceOnnx, DEFAULT_PIPER_VOICE.onnx) && existsSync(paths.defaultVoiceJson);
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
