/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from './error-display.js';
import { logger } from './logger.js';

/**
 * notifyCompletion - Emit terminal bell and/or desktop notification on turn completion.
 * Notification errors are reported and never crash the app.
 *
 * @param title     - Notification title
 * @param message   - Notification body
 * @param durationMs - Turn duration in milliseconds
 */
/** Escape a string for safe interpolation into an AppleScript string literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function trimNotificationOutput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function spawnNotification(command: string[]): void {
  try {
    const proc = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const stderr = new Response(proc.stderr).text();
    void Promise.all([proc.exited, stderr])
      .then(([exitCode, stderrText]) => {
        if (exitCode !== 0) {
          logger.warn('Completion notification command failed', {
            command: command[0],
            exitCode,
            stderr: trimNotificationOutput(stderrText),
          });
        }
      })
      .catch((error: unknown) => {
        logger.warn('Completion notification failed', {
          error: summarizeError(error),
        });
      });
  } catch (error) {
    logger.warn('Completion notification failed', {
      error: summarizeError(error),
    });
  }
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
    if (process.platform === 'linux') {
      spawnNotification(['notify-send', title, message]);
    } else if (process.platform === 'darwin') {
      const safeTitle = escapeAppleScript(title);
      const safeMessage = escapeAppleScript(message);
      spawnNotification(['osascript', '-e', `display notification "${safeMessage}" with title "${safeTitle}"`]);
    }
  }
}
