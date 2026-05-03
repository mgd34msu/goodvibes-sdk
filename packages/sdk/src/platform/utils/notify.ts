/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from './error-display.js';
import { logger } from './logger.js';

/**
 * notifyCompletion - Emit terminal bell and/or desktop notification on turn completion.
 * Non-fatal: notification errors are reported and never crash the app.
 *
 * @param title     - Notification title
 * @param message   - Notification body
 * @param durationMs - Turn duration in milliseconds
 */
/** Escape a string for safe interpolation into an AppleScript string literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function notifyCompletion(title: string, message: string, durationMs: number): void {
  // Terminal bell for responses > 5s.
  // Surface-specific: this writes directly to stdout and is only meaningful
  // in a terminal context. Host surfaces that manage their own output stream
  // should inject this behaviour via a callback rather than calling it here.
  if (durationMs > 5000) {
    process.stdout.write('\x07');
  }

  // Desktop notification for responses > 30s
  if (durationMs > 30000) {
    try {
      if (process.platform === 'linux') {
        Bun.spawn(['notify-send', title, message], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      } else if (process.platform === 'darwin') {
        const safeTitle = escapeAppleScript(title);
        const safeMessage = escapeAppleScript(message);
        Bun.spawn(
          ['osascript', '-e', `display notification "${safeMessage}" with title "${safeTitle}"`],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        );
      }
    } catch (error) {
      logger.debug('Completion notification failed', {
        error: summarizeError(error),
      });
    }
  }
}
