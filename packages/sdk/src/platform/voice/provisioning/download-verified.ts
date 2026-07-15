/**
 * download-verified.ts — atomic, checksum-verified download of one managed
 * voice-runtime component (engine archive or model file).
 *
 * Extends the item-5 atomic pattern (temp file in the same directory, then
 * rename) with a pinned size + sha256 gate: a byte-count or checksum mismatch
 * refuses the write and keeps NOTHING at the final path, so a corrupted or
 * tampered download can never be handed to the speech engine. Resumable by
 * re-run: an existing file whose checksum already matches is skipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface VerifiedDownloadSpec {
  readonly url: string;
  /** Expected byte count (pinned). */
  readonly bytes: number;
  /** Expected lowercase hex sha256 (pinned). */
  readonly sha256: string;
}

export interface VerifiedDownloadOptions {
  readonly spec: VerifiedDownloadSpec;
  readonly destPath: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Progress callback (best-effort). */
  readonly onProgress?: ((phase: 'skip' | 'download' | 'verify' | 'done', message?: string) => void) | undefined;
}

export type VerifiedDownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly skipped: boolean }
  | { readonly ok: false; readonly reason: 'download-failed' | 'checksum-mismatch' | 'size-mismatch'; readonly error: string };

function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

/** True when an existing file already matches the pinned size + checksum. */
export function fileMatches(path: string, spec: VerifiedDownloadSpec): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size !== spec.bytes) return false;
    return sha256Hex(readFileSync(path)) === spec.sha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Download a component to `destPath` atomically, verifying size + sha256.
 * Skips (returns skipped:true) when the file already matches — this is what
 * makes a re-run resumable. Never leaves a partial or unverified file in place.
 */
export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<VerifiedDownloadResult> {
  const { spec, destPath } = options;
  if (fileMatches(destPath, spec)) {
    options.onProgress?.('skip', `${destPath} already present and verified`);
    return { ok: true, path: destPath, bytes: spec.bytes, skipped: true };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const dir = dirname(destPath);
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.part`);
  try {
    options.onProgress?.('download', `fetching ${spec.url}`);
    const response = await doFetch(spec.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 600_000) });
    if (!response.ok) {
      return { ok: false, reason: 'download-failed', error: `HTTP ${response.status} for ${spec.url}` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== spec.bytes) {
      return { ok: false, reason: 'size-mismatch', error: `expected ${spec.bytes} bytes, got ${bytes.length} (truncated or wrong asset)` };
    }
    options.onProgress?.('verify', 'verifying checksum');
    const actual = sha256Hex(bytes);
    if (actual !== spec.sha256.toLowerCase()) {
      // Checksum mismatch: refuse and keep NOTHING.
      return { ok: false, reason: 'checksum-mismatch', error: `sha256 mismatch: expected ${spec.sha256}, got ${actual}` };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, bytes);
    if (statSync(tmpPath).size !== bytes.length) {
      unlinkSync(tmpPath);
      return { ok: false, reason: 'download-failed', error: 'temp write incomplete' };
    }
    renameSync(tmpPath, destPath);
    options.onProgress?.('done', `installed ${destPath}`);
    return { ok: true, path: destPath, bytes: bytes.length, skipped: false };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupError) {
      logger.warn('verified download partial cleanup failed', { tmpPath, error: summarizeError(cleanupError) });
    }
    return { ok: false, reason: 'download-failed', error: summarizeError(error) };
  }
}
