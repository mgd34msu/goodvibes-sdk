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
 * @param options   - Optional overrides (see {@link NotifyOptions}).
 */
/** Escape a string for safe interpolation into an AppleScript string literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface NotifyOptions {
  /**
   * Bypass test suppression for this call. Intended only for tests that
   * exercise the notification shell-out layer itself (e.g. asserting the
   * notify-send/osascript invocation or the terminal bell byte). Every
   * other caller should leave this unset.
   */
  force?: boolean;
}

/**
 * True when this call must not reach an external side effect: real desktop
 * notifications (notify-send/osascript) and real webhook HTTP deliveries must
 * never fire from an automated test run and spam whoever's desktop or endpoint
 * the tests happen to execute on.
 *
 * Note this governs only the external shell-out/HTTP layer. The in-process
 * terminal bell (a single \x07 byte written to this process's own stdout) has
 * no external side effect and is NOT gated by this — see {@link notifyCompletion}.
 *
 * Suppressed when either:
 *   - `NODE_ENV === 'test'` (set automatically by `bun test`), or
 *   - `GOODVIBES_SUPPRESS_NOTIFY` is set to a truthy value (explicit
 *     override for harnesses that don't run under NODE_ENV=test).
 *
 * `options.force: true` bypasses suppression entirely — the one sanctioned
 * escape hatch, for tests that specifically exercise this shell-out layer.
 */
export function isNotifySuppressed(force?: boolean): boolean {
  if (force) return false;
  if (process.env.NODE_ENV === 'test') return true;
  const override = process.env.GOODVIBES_SUPPRESS_NOTIFY;
  if (override && override !== '0' && override.toLowerCase() !== 'false') return true;
  return false;
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

export function notifyCompletion(title: string, message: string, durationMs: number, options?: NotifyOptions): void {
  // Terminal bell for responses > 5s.
  // Surface-specific: this writes directly to stdout and is only meaningful
  // in a terminal context. Host surfaces that manage their own output stream
  // should inject this behaviour via a callback rather than calling it here.
  //
  // The bell is an in-process byte write with no external side effect, so it
  // is emitted even under test suppression — only the real desktop-notification
  // spawn below is suppressed. (This is the notify-guard scope fix: silencing a
  // test run must not silence the terminal bell, which several host surfaces
  // assert as product behaviour.)
  if (durationMs > 5000) {
    process.stdout.write('\x07');
  }

  // Desktop notification for responses > 30s. Real notify-send/osascript
  // spawns must never fire from an automated test run — suppressed under
  // NODE_ENV=test / GOODVIBES_SUPPRESS_NOTIFY, with `force` as the opt-back-in
  // for tests that exercise this shell-out layer itself.
  if (durationMs > 30000) {
    if (isNotifySuppressed(options?.force)) {
      logger.debug('Completion desktop notification suppressed under test', { title, durationMs });
      return;
    }
    if (process.platform === 'linux') {
      spawnNotification(['notify-send', title, message]);
    } else if (process.platform === 'darwin') {
      const safeTitle = escapeAppleScript(title);
      const safeMessage = escapeAppleScript(message);
      spawnNotification(['osascript', '-e', `display notification "${safeMessage}" with title "${safeTitle}"`]);
    }
  }
}
