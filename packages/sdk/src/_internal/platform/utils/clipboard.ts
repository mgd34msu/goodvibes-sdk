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

/**
 * pasteFromClipboard - Attempts to read from system clipboard using platform tools.
 */
export function pasteFromClipboard(): string {
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) then xclip (X11)
      const wl = Bun.spawnSync(['wl-paste', '--no-newline'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (wl.exitCode === 0 && wl.stdout) {
        return Buffer.from(wl.stdout).toString();
      }
      const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-o'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (xclip.exitCode === 0 && xclip.stdout) {
        return Buffer.from(xclip.stdout).toString();
      }
    } else if (process.platform === 'darwin') {
      const pb = Bun.spawnSync(['pbpaste'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (pb.exitCode === 0 && pb.stdout) {
        return Buffer.from(pb.stdout).toString();
      }
    }
  } catch (err: unknown) {
    logger.error('Clipboard: Paste failed', { error: summarizeError(err) });
  }
  return '';
}

/**
 * pasteImageFromClipboard - Attempts to read image data from system clipboard.
 * Returns base64-encoded image data and mediaType, or null if no image is available.
 */
export function pasteImageFromClipboard(): { data: string; mediaType: string } | null {
  try {
    if (process.platform === 'linux') {
      // Try wl-paste (Wayland) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const wl = Bun.spawnSync(['wl-paste', '--type', mime, '--no-newline'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: 3000,
        });
        if (wl.exitCode === 0 && wl.stdout) {
          const buf = Buffer.from(wl.stdout);
          if (buf.length > MIN_IMAGE_BYTES) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
      }
      // Try xclip (X11) for each supported MIME type
      for (const { mime, mediaType } of IMAGE_MIME_TYPES) {
        const xclip = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-t', mime, '-o'], {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: 3000,
        });
        if (xclip.exitCode === 0 && xclip.stdout) {
          const buf = Buffer.from(xclip.stdout);
          if (buf.length > MIN_IMAGE_BYTES) {
            return { data: buf.toString('base64'), mediaType };
          }
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS: try pngpaste first (brew install pngpaste), then fall back to osascript
      const pp = Bun.spawnSync(['pngpaste', '-'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 3000,
      });
      if (pp.exitCode === 0 && pp.stdout) {
        const ppBuf = Buffer.from(pp.stdout);
        if (ppBuf.length > MIN_IMAGE_BYTES) {
          return { data: ppBuf.toString('base64'), mediaType: 'image/png' };
        }
      }
      // Fallback: osascript — reads clipboard as PNG hex data
      // Output format: «data PNGf<hex>» — extract hex after 'PNGf'
      const osa = Bun.spawnSync(
        ['osascript', '-e', 'the clipboard as «class PNGf»'],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: 5000,
        },
      );
      if (osa.exitCode === 0 && osa.stdout) {
        const raw = Buffer.from(osa.stdout).toString('utf8').trim();
        // raw is like: «data PNGf89504e47...»
        const match = raw.match(/«data PNGf([0-9a-fA-F]+)»/);
        if (match) {
          const osaBuf = Buffer.from(match[1], 'hex');
          if (osaBuf.length > MIN_IMAGE_BYTES) {
            return { data: osaBuf.toString('base64'), mediaType: 'image/png' };
          }
        }
      }
    }
  } catch (err: unknown) {
    logger.debug('Clipboard image access failed', { error: summarizeError(err) });
  }
  return null;
}
