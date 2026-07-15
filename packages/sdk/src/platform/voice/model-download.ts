/**
 * model-download.ts — atomic download of a local voice model (piper/kokoro
 * .onnx voices and their .json configs).
 *
 * The incident: a voice model download was interrupted, leaving a TRUNCATED
 * .onnx at the final path, which was then fed straight to piper — which aborted
 * (an onnxruntime load failure) on the malformed model. The fix is atomicity +
 * verification: fetch into a temp file in the SAME directory, verify the byte
 * count against Content-Length (when the server sent one) and against a
 * non-trivial floor + expected magic, then rename into place. A partial download
 * is never visible at the final path, and a failed download is cleaned up and
 * reported honestly — never silently left half-written.
 *
 * The `renameSync` is atomic because the temp file shares the destination's
 * directory (and thus filesystem); a cross-device rename would not be atomic.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Minimum plausible size for a real voice model; a truncated download or an HTML error page is far smaller. */
const DEFAULT_MIN_BYTES = 4096;

export interface VoiceModelDownloadOptions {
  /** The URL to fetch the model from. */
  readonly url: string;
  /** The final on-disk path (e.g. .../en_US-glados-high.onnx). */
  readonly destPath: string;
  /** Injectable fetch (real fetch by default; tests pass a mock). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Reject downloads smaller than this many bytes (default 4096). */
  readonly minBytes?: number | undefined;
  /** Abort the download after this many ms (default 120000). */
  readonly timeoutMs?: number | undefined;
  /**
   * Verify the ONNX protobuf magic (first byte 0x08 — the ir_version field tag).
   * Defaults to true when destPath ends in `.onnx`. Set false for `.json` configs.
   */
  readonly expectOnnxMagic?: boolean | undefined;
}

export type VoiceModelDownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

function looksLikeHtml(bytes: Uint8Array): boolean {
  // Skip leading whitespace, then check for a '<' — a rate-limit/error page
  // served with 200 is the classic "downloaded 900 bytes of HTML" corruption.
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  return i < bytes.length && bytes[i] === 0x3c; // '<'
}

/**
 * Download a voice model atomically with verification. Never leaves a partial
 * file at `destPath`; returns a structured result rather than throwing.
 */
export async function downloadVoiceModel(options: VoiceModelDownloadOptions): Promise<VoiceModelDownloadResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const minBytes = Math.max(1, options.minBytes ?? DEFAULT_MIN_BYTES);
  const expectOnnx = options.expectOnnxMagic ?? options.destPath.endsWith('.onnx');
  const dir = dirname(options.destPath);
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.part`);

  try {
    const response = await doFetch(options.url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      return { ok: false, error: `voice model download failed: HTTP ${response.status} for ${options.url}` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    // Content-Length cross-check: a stream cut short (the incident) yields fewer
    // bytes than the server promised.
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const expected = Number(contentLengthHeader);
      if (Number.isFinite(expected) && expected > 0 && bytes.length !== expected) {
        return { ok: false, error: `voice model download truncated: got ${bytes.length} bytes, Content-Length said ${expected}` };
      }
    }

    // Non-trivial floor: a truncated download or an HTML error page is tiny.
    if (bytes.length < minBytes) {
      return { ok: false, error: `voice model download too small: ${bytes.length} bytes (< ${minBytes}); likely truncated or an error page` };
    }
    if (looksLikeHtml(bytes)) {
      return { ok: false, error: 'voice model download looks like an HTML page, not a model file (server returned an error page with status 200?)' };
    }
    if (expectOnnx && bytes[0] !== 0x08) {
      return { ok: false, error: `voice model download is not a valid ONNX model (first byte 0x${(bytes[0] ?? 0).toString(16)}, expected 0x08); likely truncated or corrupt` };
    }

    // Write to a temp file in the SAME directory so the rename is atomic.
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, bytes);

    // Guard against a short write before we make the file visible.
    const written = statSync(tmpPath).size;
    if (written !== bytes.length) {
      unlinkSync(tmpPath);
      return { ok: false, error: `voice model temp write incomplete: wrote ${written} of ${bytes.length} bytes` };
    }

    renameSync(tmpPath, options.destPath);
    logger.info('voice model downloaded', { path: options.destPath, bytes: bytes.length });
    return { ok: true, path: options.destPath, bytes: bytes.length };
  } catch (error) {
    // Clean up any partial temp file — a failed download never lingers.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupError) {
      logger.warn('voice model partial cleanup failed', { tmpPath, error: summarizeError(cleanupError) });
    }
    return { ok: false, error: `voice model download error: ${summarizeError(error)}` };
  }
}
