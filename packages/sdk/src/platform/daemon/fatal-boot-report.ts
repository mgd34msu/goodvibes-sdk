/**
 * fatal-boot-report.ts — saying why, on a stream, before the process stops.
 *
 * ── The failure this exists to close ──────────────────────────────────────
 *
 * The shipped daemon died mute. Measured, against the released 1.27.0 binary in
 * an isolated home, with an unparseable `daemon/settings.json`: exit code 1,
 * **zero bytes on stdout, zero bytes on stderr, and no activity log written at
 * all**. The same source, run under `bun`, printed the reason loudly. So every
 * source-level test in this repository passed while every shipped build was
 * silent, and an operator's only signal was that everything had stopped.
 *
 * The mechanism was not buffering and not a bypassed handler. It was simpler:
 * the daemon entrypoint that actually ships writes the reason to the activity
 * LOGGER and then exits, and at that point in boot the logger has no
 * destination yet — so the line goes nowhere and no stream is ever touched.
 * A `logger.error` is not a disclosure. Only a write to a file descriptor is.
 *
 * ── Why `writeSync(2, …)` and not `process.stderr.write` ──────────────────
 *
 * Because the fatal path must not depend on anything a host can replace or
 * defer. `process.stderr.write` is a property on a mutable global: a surface
 * that intercepts terminal output to keep a rendered screen clean replaces it
 * (goodvibes-tui does exactly this in `runtime/terminal-output-guard.ts`), and
 * a replaced writer that records instead of printing turns a fatal error into
 * silence. It is also a stream, so a write issued immediately before
 * `process.exit()` can still be in flight when the process stops existing.
 *
 * `writeSync(2, …)` is neither. It is a direct write to the file descriptor the
 * service journal is attached to, it has completed when it returns, and no
 * amount of monkey-patching upstream can intercept it. That is the whole
 * property this module exists to provide, and it is why every early-exit site
 * in the daemon boot path routes through here.
 */

import { writeSync } from 'node:fs';
import { summarizeError } from '../utils/error-display.js';
import { flushActivityLogSync, logger } from '../utils/logger.js';

/** stdout and stderr, as the file descriptors they actually are. */
const STDOUT_FD = 1;
const STDERR_FD = 2;

function writeLineToFd(fd: number, line: string): void {
  try {
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // A closed or unwritable descriptor must never turn a diagnostic into a
    // second failure. There is nothing further to fall back to: this IS the
    // fallback.
  }
}

/**
 * Write one line to stderr synchronously, immune to a replaced
 * `process.stderr` and to exit-time truncation. Use this for anything that
 * gates a process exit.
 */
export function writeFatalLine(line: string): void {
  writeLineToFd(STDERR_FD, line);
}

/**
 * The stdout twin, for output that must survive an exit that follows it —
 * `--install-service` prints the unit path and the follow-up commands and then
 * exits immediately, which is the same race.
 */
export function writeExitingStdoutLine(line: string): void {
  writeLineToFd(STDOUT_FD, line);
}

/**
 * Report a fatal boot failure everywhere it can be found, then leave the exit
 * to the caller.
 *
 * The stream write happens FIRST and synchronously. The activity log is
 * attempted after, because it is the part that can fail — it needs a
 * configured destination, a writable directory, and a flush — and the
 * guarantee this function makes is the stream line, not the log line.
 */
export function reportFatalBootFailure(error: unknown, context = 'goodvibes daemon host'): void {
  const summary = summarizeError(error);
  writeFatalLine(`${context} failed: ${summary}`);
  if (error instanceof Error && error.stack) writeFatalLine(error.stack);
  try {
    logger.error(`${context} failed`, { error: summary });
    flushActivityLogSync();
  } catch {
    // The reason is already on stderr, which is the guarantee. A log that
    // cannot be written must not escalate into a different failure.
  }
}
