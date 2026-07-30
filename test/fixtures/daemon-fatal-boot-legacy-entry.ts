/**
 * daemon-fatal-boot-legacy-entry.ts — the fatal tail as it shipped, on purpose.
 *
 * The control for the compiled-binary disclosure test. This is the shape the
 * released daemon entrypoint actually used: report the failure to the activity
 * LOGGER, flush it, and exit. No file descriptor is ever written.
 *
 * Compiled and run, it produces zero bytes on stdout and zero bytes on stderr —
 * which is precisely what an operator saw for 77 crash-loops, and precisely
 * what a source-level test cannot observe, because under `bun` a logger with a
 * destination is perfectly capable of printing.
 *
 * Its only job is to hold that baseline still, so the fixed entry's output is
 * measured against a real one rather than an assumption, and so anyone who
 * returns the fatal path to a log-only report fails a test instead of shipping
 * silence.
 */

import { join } from 'node:path';
import { resolveDaemonCliPaths } from '../../packages/sdk/src/platform/daemon/cli-paths.ts';
import { configureActivityLogger, flushActivityLogSync, logger } from '../../packages/sdk/src/platform/utils/logger.ts';
import { summarizeError } from '../../packages/sdk/src/platform/utils/error-display.ts';

async function main(): Promise<void> {
  const { workingDirectory, daemonTierPath } = resolveDaemonCliPaths();
  configureActivityLogger(join(workingDirectory, '.goodvibes', 'logs'));
  // The same class of failure the daemon dies of, raised WITHOUT going through
  // the settings screen — whose own disclosure is the fix under test and must
  // not be what makes the control speak.
  throw new Error(`Daemon config load failed for ${daemonTierPath}: JSON Parse error: Expected '}'`);
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', { error: summarizeError(error) });
  flushActivityLogSync();
  process.exit(1);
});
