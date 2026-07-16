/**
 * manifest.ts — the PINNED local-voice runtime manifest: exact versions, URLs,
 * byte sizes, and sha256 checksums for the managed engines + default models the
 * provisioner installs.
 *
 * Nothing here is fetched without a matching checksum, so a mirror swap or a
 * corrupted asset is refused rather than run. Adding a platform means pinning
 * its build here (verified against the real asset); a platform with no pinned,
 * verified build reports `unsupported` honestly instead of downloading blind.
 *
 * TTS — Piper (MIT). The official release tarball bundles the piper binary, its
 * shared libs, AND espeak-ng-data, so one archive provisions the whole engine.
 * Default voice: en_US-lessac-medium — a widely-used, well-regarded medium
 * en_US voice (good quality/size balance at ~63 MB) from rhasspy/piper-voices.
 *
 * STT — whisper.cpp (MIT). whisper.cpp publishes NO official prebuilt binary for
 * Linux/macOS in its GitHub releases (only source), and this provisioner never
 * compiles on the user's machine, so STT is reported `unsupported` with an
 * honest reason. The default model would be ggml-base.en; it is not downloaded
 * while no verified binary exists to run it.
 */
import type { VerifiedDownloadSpec } from './download-verified.js';

export type VoicePlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export function currentVoicePlatform(): VoicePlatform | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  return null;
}

/** The piper engine archive for a platform (tarball with binary + libs + espeak-ng-data). */
export interface PiperEngineManifest {
  readonly version: string;
  readonly archive: VerifiedDownloadSpec;
  /** Path of the piper binary inside the extracted archive (relative to the extract dir). */
  readonly binaryRelPath: string;
}

/** A piper voice: the onnx model plus its json config. */
export interface PiperVoiceManifest {
  readonly id: string;
  readonly onnx: VerifiedDownloadSpec;
  readonly json: VerifiedDownloadSpec;
}

/**
 * Pinned piper engine builds per platform. Only platforms with a verified,
 * checksummed build appear; others resolve to `unsupported`.
 */
export const PIPER_ENGINES: Partial<Record<VoicePlatform, PiperEngineManifest>> = {
  'linux-x64': {
    version: '2023.11.14-2',
    archive: {
      url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
      bytes: 26460462,
      sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
    },
    binaryRelPath: 'piper/piper',
  },
};

/** The single default voice provisioned for TTS. */
export const DEFAULT_PIPER_VOICE: PiperVoiceManifest = {
  id: 'en_US-lessac-medium',
  onnx: {
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    bytes: 63201294,
    sha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
  },
  json: {
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
    bytes: 4885,
    sha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
  },
};

/** Human-readable total download size for the offer (bytes). */
export function piperProvisionBytes(platform: VoicePlatform): number | null {
  const engine = PIPER_ENGINES[platform];
  if (!engine) return null;
  return engine.archive.bytes + DEFAULT_PIPER_VOICE.onnx.bytes + DEFAULT_PIPER_VOICE.json.bytes;
}

/** Why STT is not provisioned on platforms with no pinned goodvibes whisper bundle. */
export const WHISPER_UNSUPPORTED_REASON =
  'No pinned, checksum-verified whisper.cpp bundle exists for this platform (whisper.cpp publishes no official prebuilt binary, and managed provisioning never compiles on your machine). To enable local STT, install whisper.cpp yourself and set voice.local.sttEngine/sttBinary/sttModelPath.';

/**
 * The goodvibes-built whisper.cpp engine bundle for a platform. whisper.cpp
 * ships no official prebuilt binaries, so goodvibes builds them reproducibly
 * (scripts/build-whisper-bundle.ts, static ggml, stripped) and pins the
 * artifact here. `bundle.url` is null until the artifact is hosted by the
 * release pipeline — the byte count and sha256 are ALWAYS pinned, so a
 * sideloaded bundle (dropped at the managed archive path) verifies against
 * the same pin and installs identically.
 */
export interface WhisperEngineManifest {
  readonly version: string;
  readonly bundle: { readonly url: string | null; readonly bytes: number; readonly sha256: string };
  /** Path of the whisper-cli binary inside the extracted archive. */
  readonly binaryRelPath: string;
}

/** A whisper ggml model (hosted on Hugging Face — real, stable URLs). */
export interface WhisperModelManifest {
  readonly id: string;
  readonly bin: VerifiedDownloadSpec;
}

/**
 * Pinned goodvibes whisper.cpp builds per platform. Built from the v-tagged
 * whisper.cpp source with static ggml; the pin below is the exact artifact
 * produced (and smoke-verified: `whisper-cli -m ggml-base.en.bin -f jfk.wav`
 * transcribes correctly) by scripts/build-whisper-bundle.ts on linux-x64.
 */
export const WHISPER_ENGINES: Partial<Record<VoicePlatform, WhisperEngineManifest>> = {
  'linux-x64': {
    version: '1.8.2',
    bundle: {
      // Hosted by the release pipeline; until then a sideloaded bundle matching
      // this pin installs identically (see provisioner.ts).
      url: null,
      bytes: 1121557,
      sha256: '80948cd00eed6b43fc7bc307424713a4b4890bc1aec11bdc560aba9357834ac5',
    },
    binaryRelPath: 'whisper/whisper-cli',
  },
};

/** The default STT model: base.en — the standard quality/size balance (~148MB). */
export const DEFAULT_WHISPER_MODEL: WhisperModelManifest = {
  id: 'ggml-base.en',
  bin: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    bytes: 147964211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  },
};
