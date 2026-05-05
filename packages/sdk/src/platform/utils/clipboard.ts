import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

export const MIN_IMAGE_BYTES = 100;

/**
 * ClipboardWriteFunction - Type for surface-specific clipboard write implementations.
 * Surfaces (e.g., TUI) inject their own implementation (e.g., OSC 52 for terminals).
 */
export type ClipboardWriteFunction = (text: string) => void;

const IMAGE_MIME_TYPES: { mime: string; mediaType: string }[] = [
  { mime: 'image/png', mediaType: 'image/png' },
  { mime: 'image/jpeg', mediaType: 'image/jpeg' },
  { mime: 'image/webp', mediaType: 'image/webp' },
  { mime: 'image/gif', mediaType: 'image/gif' },
];

type ClipboardAttempt = {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr?: string | undefined;
};

function bytesToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  return String(value);
}

function recordClipboardAttempt(
  attempts: ClipboardAttempt[],
  command: string,
  result: { readonly exitCode: number | null; readonly stderr?: unknown },
): void {
  if (attempts.length >= 8) return;
  const stderr = bytesToString(result.stderr).trim();
  attempts.push({
    command,
    exitCode: result.exitCode,
    stderr: stderr ? stderr.slice(0, 300) : undefined,
  });
}

function logClipboardAttempts(message: string, attempts: readonly ClipboardAttempt[]): void {
  if (attempts.length === 0) return;
  logger.debug(message, { attempts: [...attempts] });
}

/**
 * pasteFromClipboard - Attempts to read from system clipboard using platform tools.
 */
export function pasteFromClipboard(): string {
  const attempts: ClipboardAttempt[] = [];
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) then xclip (X11)
      const wl = Bun.spawnSync(['wl-paste', '--no-newline'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (wl.exitCode === 0 && wl.stdout) {
        return Buffer.from(wl.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'wl-paste', wl);
      const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-o'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (xclip.exitCode === 0 && xclip.stdout) {
        return Buffer.from(xclip.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'xclip', xclip);
    } else if (process.platform === 'darwin') {
      const pb = Bun.spawnSync(['pbpaste'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (pb.exitCode === 0 && pb.stdout) {
        return Buffer.from(pb.stdout).toString();
      }
      recordClipboardAttempt(attempts, 'pbpaste', pb);
    }
  } catch (err: unknown) {
    logger.error('Clipboard: Paste failed', { error: summarizeError(err) });
  }
  logClipboardAttempts('Clipboard text read returned no data', attempts);
  return '';
}

/**
 * pasteImageFromClipboard - Attempts to read image data from system clipboard.
 * Returns base64-encoded image data and mediaType, or null if no image is available.
 */
export function pasteImageFromClipboard(): { data: string; mediaType: string } | null {
  const attempts: ClipboardAttempt[] = [];
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const wl = Bun.spawnSync(['wl-paste', '--type', mime, '--no-newline'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
        });
        if (wl.exitCode === 0 && wl.stdout) {
          const buf = Buffer.from(wl.stdout);
          if (buf.length > MIN_IMAGE_BYTES) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
        recordClipboardAttempt(attempts, `wl-paste ${mime}`, wl);
      }
      // Try xclip (X11) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-t', mime, '-o'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
        });
        if (xclip.exitCode === 0 && xclip.stdout) {
          const buf = Buffer.from(xclip.stdout);
          if (buf.length > MIN_IMAGE_BYTES) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
        recordClipboardAttempt(attempts, `xclip ${mime}`, xclip);
      }
    } else if (process.platform === 'darwin') {
      // macOS: try pngpaste first (brew install pngpaste), then fall back to osascript
      const pp = Bun.spawnSync(['pngpaste', '-'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      if (pp.exitCode === 0 && pp.stdout) {
        const ppBuf = Buffer.from(pp.stdout);
        if (ppBuf.length > MIN_IMAGE_BYTES) {
          return { data: ppBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
      recordClipboardAttempt(attempts, 'pngpaste', pp);
      // Next try osascript, which reads clipboard as PNG hex data.
      // Output format: «data PNGf<hex>» — extract hex after 'PNGf'
      const osa = Bun.spawnSync(
        ['osascript', '-e', 'the clipboard as «class PNGf»'],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5000,
        },
      );
      if (osa.exitCode === 0 && osa.stdout) {
        const raw = Buffer.from(osa.stdout).toString('utf8').trim();
        // raw is like: «data PNGf89504e47...»
        const match = raw.match(/«data PNGf([0-9a-fA-F]+)»/);
        if (match) {
          const osaBuf = Buffer.from(match[1]!, 'hex');
          if (osaBuf.length > MIN_IMAGE_BYTES) {
            return { data: osaBuf.toString('base64'), mediaType: 'image/png' };
          }
        }
      }
      recordClipboardAttempt(attempts, 'osascript PNGf', osa);
    }
  } catch (err: unknown) {
    logger.warn('Clipboard image access failed', { error: summarizeError(err) });
  }
  logClipboardAttempts('Clipboard image read returned no data', attempts);
  return null;
}
