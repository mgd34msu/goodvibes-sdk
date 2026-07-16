/**
 * sha256sums — generate and verify a SHA256SUMS manifest over release assets.
 *
 * Emits the standard `<hex>  <name>` format (two spaces, coreutils-compatible).
 * A missing asset is a hard failure — a release must never ship an unlisted or
 * absent binary.
 */

export interface Sha256Entry {
  /** Name recorded in the manifest (typically the asset basename). */
  readonly name: string;
  /** Absolute or root-relative path to hash. */
  readonly path: string;
}

/** Reads a file's bytes; returns null when the file is absent. */
export type ReadBytes = (path: string) => Uint8Array | null;
/** Computes a lowercase hex sha256 of bytes. */
export type HashBytes = (bytes: Uint8Array) => string;

export interface Sha256SumsResult {
  readonly ok: boolean;
  /** Manifest text (only meaningful when ok). */
  readonly manifest: string;
  /** Entries whose file was missing. */
  readonly missing: readonly string[];
}

/**
 * Produce a SHA256SUMS manifest. Every entry must resolve to bytes; any missing
 * file yields ok=false and is listed in `missing`.
 */
export function generateSha256Sums(entries: readonly Sha256Entry[], readBytes: ReadBytes, hashBytes: HashBytes): Sha256SumsResult {
  const missing: string[] = [];
  const lines: string[] = [];
  for (const entry of entries) {
    const bytes = readBytes(entry.path);
    if (bytes === null) {
      missing.push(entry.name);
      continue;
    }
    lines.push(`${hashBytes(bytes)}  ${entry.name}`);
  }
  if (missing.length > 0) {
    return { ok: false, manifest: '', missing };
  }
  return { ok: true, manifest: `${lines.join('\n')}\n`, missing: [] };
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Names whose recomputed hash differs from the manifest. */
  readonly mismatched: readonly string[];
  /** Names present in the manifest but absent on disk. */
  readonly missing: readonly string[];
}

/** Parse a manifest into name→hash pairs. */
export function parseSha256Manifest(manifest: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of manifest.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) map.set(match[2], match[1]);
  }
  return map;
}

/** Verify assets against a manifest by recomputing each hash. */
export function verifySha256Sums(manifest: string, readBytes: ReadBytes, hashBytes: HashBytes): VerifyResult {
  const expected = parseSha256Manifest(manifest);
  const mismatched: string[] = [];
  const missing: string[] = [];
  for (const [name, hash] of expected) {
    const bytes = readBytes(name);
    if (bytes === null) {
      missing.push(name);
      continue;
    }
    if (hashBytes(bytes) !== hash) mismatched.push(name);
  }
  return { ok: mismatched.length === 0 && missing.length === 0, mismatched, missing };
}
