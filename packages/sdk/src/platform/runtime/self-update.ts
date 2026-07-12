/**
 * The platform's one binary-update mechanism: download, checksum-verify,
 * atomic swap with a kept previous version, and one-command rollback.
 *
 * Every consumer (the daemon's hourly auto-updater here; interactive
 * client-side update commands in consuming apps) shares these semantics:
 *   - release assets are named `goodvibes[-daemon]-{linux|macos}-{x64|arm64}`,
 *     verified against SHA256SUMS.txt; an artifact with NO manifest entry is
 *     as unverified as a mismatching one — both refuse to install;
 *   - ALL artifacts download and verify BEFORE any file is touched, so a
 *     failure never leaves a mismatched pair installed;
 *   - every swap writes beside the target then renames over it (atomic on
 *     the same filesystem; a running process keeps its old inode) and parks
 *     the outgoing file at `<path>.previous`;
 *   - rollback EXCHANGES each file with its kept `.previous` counterpart in
 *     three same-directory renames — one command back, one more forward.
 *
 * All I/O (fetch, filesystem) is injectable so the policy is provable under
 * test without a network or a real install.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Version + release-tag logic
// ---------------------------------------------------------------------------

export function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}

/**
 * Compares two version strings component-wise as dotted non-negative
 * integers (a leading "v" is ignored, matching the "vX.Y.Z" release tag
 * format). Returns -1/0/1 for a<b / a==b / a>b. Non-numeric or missing
 * components are treated as 0, so "1.2" and "1.2.0" compare equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const partsA = normalizeVersion(a).split('.');
  const partsB = normalizeVersion(b).split('.');
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const x = Number.parseInt(partsA[i] ?? '0', 10) || 0;
    const y = Number.parseInt(partsB[i] ?? '0', 10) || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Extracts the release tag from a GitHub "/releases/latest" redirect
 * Location header (everything after the final slash of the redirect target).
 */
export function parseReleaseTagFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const segments = location.split('/').filter((segment) => segment.length > 0);
  const tag = segments[segments.length - 1];
  return tag && tag.length > 0 ? tag : null;
}

/** Minimal fetch shape so tests inject a stub instead of the real network. */
export interface UpdateFetchLike {
  (url: string, init?: { method?: string; redirect?: 'manual' | 'follow' | 'error' }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/**
 * Resolves the latest release tag via a HEAD request with redirects NOT
 * followed, reading the tag out of the redirect Location header. Throws if
 * no tag can be resolved — callers must not silently fall back to
 * "already current".
 */
export async function resolveLatestReleaseTag(fetchImpl: UpdateFetchLike, releasesLatestUrl: string): Promise<string> {
  const response = await fetchImpl(releasesLatestUrl, { method: 'HEAD', redirect: 'manual' });
  const location = response.headers.get('location');
  const tag = parseReleaseTagFromLocation(location)
    ?? (response.url !== releasesLatestUrl ? parseReleaseTagFromLocation(response.url) : null);
  if (!tag) {
    throw new Error(`could not resolve the latest release tag from ${releasesLatestUrl} (no redirect Location header)`);
  }
  return tag;
}

// ---------------------------------------------------------------------------
// Release-artifact naming + checksum verification
// ---------------------------------------------------------------------------

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt';

export interface ReleaseArtifactNames {
  readonly app: string;
  readonly daemon: string;
}

/** Release-asset platform tag as used in artifact filenames ("linux" | "macos"). */
const PLATFORM_TAGS: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
};

export function resolveArtifactNames(platform: string, arch: string): ReleaseArtifactNames | null {
  const platformTag = PLATFORM_TAGS[platform];
  if (!platformTag || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = `${platformTag}-${arch}`;
  return {
    app: `goodvibes-${suffix}`,
    daemon: `goodvibes-daemon-${suffix}`,
  };
}

export interface SqliteVecAsset {
  /** Release asset filename, e.g. `sqlite-vec-linux-x64.so`. */
  readonly assetName: string;
  /** Directory name the loader resolves, e.g. `sqlite-vec-linux-x64`. */
  readonly dirName: string;
  /** File the loader opens inside that directory, e.g. `vec0.so`. */
  readonly fileName: string;
}

/**
 * Names the sqlite-vec native addon for a platform/arch. Unlike the binaries
 * (whose release tag maps darwin to "macos"), the addon keeps the Node-style
 * platform tag because that is exactly what the extension loader resolves at
 * `<execDir>/lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>`.
 */
export function resolveSqliteVecAsset(platform: string, arch: string): SqliteVecAsset | null {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = platform === 'darwin' ? 'dylib' : 'so';
  const dirName = `sqlite-vec-${platform}-${arch}`;
  return {
    assetName: `${dirName}.${suffix}`,
    dirName,
    fileName: `vec0.${suffix}`,
  };
}

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    checksums.set(match[2]!, match[1]!.toLowerCase());
  }
  return checksums;
}

/**
 * Verify a downloaded artifact's checksum against the parsed manifest.
 * An artifact with no entry in the manifest is a hard failure, identical
 * in severity to a mismatching entry — never treated as "unverifiable, so
 * skip the check". Throws naming the artifact and the manifest.
 */
export function verifyChecksum(
  artifactName: string,
  actual: string,
  expected: string | undefined,
  manifestName: string = CHECKSUM_MANIFEST_NAME,
): void {
  if (expected === undefined) {
    throw new Error(`no checksum entry for ${artifactName} in ${manifestName} — refusing to install an unverified binary`);
  }
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Atomic swap with kept previous + one-command rollback
// ---------------------------------------------------------------------------

/**
 * Suffix under which every swap keeps the file it replaced, right beside the
 * live one. This is what makes rollback a one-command operation instead of a
 * re-download: the version that ran before the last update is always still
 * on disk at `<path>.previous`.
 */
export const PREVIOUS_FILE_SUFFIX = '.previous';

/** Injectable filesystem surface for the swap/rollback policy. */
export interface UpdateFileIo {
  writeFile(path: string, data: Buffer): void;
  rename(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
}

export const realUpdateFileIo: UpdateFileIo = {
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
  chmod: (path, mode) => chmodSync(path, mode),
  exists: (path) => existsSync(path),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
};

/**
 * Writes the new file beside the target, then renames over it — an atomic
 * replace on the same filesystem, so a currently-running process that
 * already opened the old file keeps its old inode instead of executing a
 * half-written file. Before the replace, the outgoing file is parked at
 * `<path>.previous` (overwriting any older parked copy).
 */
export function swapFileAtomically(
  targetPath: string,
  buffer: Buffer,
  options: { executable: boolean; io?: UpdateFileIo; platform?: NodeJS.Platform },
): void {
  const io = options.io ?? realUpdateFileIo;
  const platform = options.platform ?? process.platform;
  io.mkdir(dirname(targetPath));
  const tempPath = `${targetPath}.update-download`;
  io.writeFile(tempPath, buffer);
  if (platform !== 'win32') {
    io.chmod(tempPath, options.executable ? 0o755 : 0o644);
  }
  if (io.exists(targetPath)) {
    io.rename(targetPath, `${targetPath}${PREVIOUS_FILE_SUFFIX}`);
  }
  io.rename(tempPath, targetPath);
}

export interface UpdateTarget {
  /** Human label for receipts and errors, e.g. "daemon binary". */
  readonly label: string;
  /** Absolute path the artifact installs to. */
  readonly path: string;
  /** Release asset name to download and verify for this target. */
  readonly assetName: string;
  /** Whether the installed file needs the execute bit. */
  readonly executable: boolean;
}

export interface ApplyVerifiedUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  /** Release download base, e.g. `https://github.com/<owner>/<repo>/releases/download/<tag>`. */
  readonly downloadBaseUrl: string;
  readonly targets: readonly UpdateTarget[];
  readonly io?: UpdateFileIo;
  readonly platform?: NodeJS.Platform;
}

async function downloadBuffer(fetchImpl: UpdateFetchLike, url: string): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Downloads the checksum manifest and every target artifact, verifies ALL of
 * them, and only then swaps each into place with a kept previous copy. A
 * checksum failure on any artifact means zero files are touched.
 */
export async function applyVerifiedUpdate(options: ApplyVerifiedUpdateOptions): Promise<void> {
  const manifestUrl = `${options.downloadBaseUrl}/${CHECKSUM_MANIFEST_NAME}`;
  const manifestResponse = await options.fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`download failed (${manifestResponse.status}) for ${manifestUrl}`);
  }
  const checksums = parseChecksumFile(await manifestResponse.text());

  const verified: Array<{ target: UpdateTarget; buffer: Buffer }> = [];
  for (const target of options.targets) {
    const buffer = await downloadBuffer(options.fetchImpl, `${options.downloadBaseUrl}/${target.assetName}`);
    verifyChecksum(target.assetName, sha256(buffer), checksums.get(target.assetName));
    verified.push({ target, buffer });
  }

  // All downloads verified before any write — an update must not apply partially.
  for (const { target, buffer } of verified) {
    swapFileAtomically(target.path, buffer, {
      executable: target.executable,
      ...(options.io ? { io: options.io } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
  }
}

export interface RollbackTarget {
  readonly label: string;
  readonly path: string;
}

export interface RollbackResult {
  /** Targets whose kept previous version is now live. */
  readonly restored: readonly RollbackTarget[];
  /** Targets with no kept previous version, left untouched. */
  readonly skipped: readonly RollbackTarget[];
}

/**
 * One-command rollback: every target with a kept `.previous` counterpart is
 * EXCHANGED with it — the previous version becomes live, and the version
 * being rolled back is itself kept at `.previous`, so a second rollback
 * rolls forward again. Three same-directory renames per file (atomic on
 * POSIX), never a copy; nothing is downloaded.
 */
export function rollbackKeptPrevious(
  targets: readonly RollbackTarget[],
  io: UpdateFileIo = realUpdateFileIo,
): RollbackResult {
  const restored: RollbackTarget[] = [];
  const skipped: RollbackTarget[] = [];
  for (const target of targets) {
    const previousPath = `${target.path}${PREVIOUS_FILE_SUFFIX}`;
    if (!io.exists(previousPath)) {
      skipped.push(target);
      continue;
    }
    if (io.exists(target.path)) {
      const parkingPath = `${target.path}.rollback-exchange`;
      io.rename(target.path, parkingPath);
      io.rename(previousPath, target.path);
      io.rename(parkingPath, previousPath);
    } else {
      io.rename(previousPath, target.path);
    }
    restored.push(target);
  }
  return { restored, skipped };
}
