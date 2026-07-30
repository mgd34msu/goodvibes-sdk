/**
 * daemon-fatal-boot-entry.ts — the daemon's boot-and-fail path, compilable.
 *
 * This exists to be built with `bun build --compile` and RUN, because the
 * defect it guards is invisible to a source-level test. The released daemon
 * binary died on this path with zero bytes on stdout and zero bytes on stderr,
 * while the identical source run under `bun` printed the reason loudly.
 *
 * It imports the real `ConfigManager` and the real `reportFatalBootFailure`,
 * and mirrors daemon/cli.ts's tail exactly — the ingestion refusal comes out of
 * the shipped screen, and the fatal report comes out of the shipped reporter.
 * Nothing about the failure path is re-implemented here; if this entry stays
 * silent, so does the daemon.
 *
 * The real daemon entrypoint cannot itself be compiled inside this repository:
 * `knowledge/html-readability.ts` statically imports `jsdom`, which is an
 * optionalDependency, so a compiled build of daemon/cli.ts dies at module init
 * on a missing package before any of this code runs. That is worth fixing on
 * its own and is noted in the report; it is not what this fixture is for.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../packages/sdk/src/platform/config/manager.ts';
import { resolveDaemonCliPaths } from '../../packages/sdk/src/platform/daemon/cli-paths.ts';
import { reportFatalBootFailure } from '../../packages/sdk/src/platform/daemon/fatal-boot-report.ts';
import { configureActivityLogger } from '../../packages/sdk/src/platform/utils/logger.ts';

async function main(): Promise<void> {
  const { workingDirectory, homeDirectory, daemonTierPath } = resolveDaemonCliPaths();
  configureActivityLogger(join(workingDirectory, '.goodvibes', 'logs'));
  const config = new ConfigManager({
    workingDir: workingDirectory,
    homeDir: homeDirectory,
    surfaceRoot: 'goodvibes',
    daemonTierPath,
  });
  // Proves the flag actually governs: which daemon tier answered, and what the
  // resolved value of a key planted only in the REAL home would be.
  process.stdout.write(`BOOTED daemonTierPath=${daemonTierPath} realHome=${homedir()}\n`);
  process.stdout.write(`RESOLVED controlPlane.port=${String(config.get('controlPlane.port'))}\n`);
  process.stdout.write(`QUARANTINE=${JSON.stringify(config.getIngestionQuarantine().map((n) => `${n.action}:${n.key}`))}\n`);
}

void main().catch((error) => {
  reportFatalBootFailure(error);
  process.exit(1);
});
