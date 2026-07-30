/**
 * cli-paths.ts — where a daemon process reads and writes, resolved once.
 *
 * Split out of daemon/cli.ts so it can be TESTED. cli.ts ends in a top-level
 * `void main()`, so importing it to check its path math would start a daemon;
 * the resolution therefore had no test, and that is how `--daemon-home` came to
 * govern half of what it names without anyone noticing.
 *
 * ── What `--daemon-home` means ────────────────────────────────────────────
 *
 * The daemon's own STATE directory — `~/.goodvibes/daemon` by default — holding
 * operator-tokens.json, daemon-settings.json, the owner profile, the daemon
 * config tier, and the daemon-scoped secret store. Four modules already resolve
 * it that way (workspace/daemon-home.ts, config/daemon-config-tier.ts,
 * owner-profile/paths.ts, config/secrets.ts) and so do the docs.
 *
 * It is NOT the user home, and deliberately does not relocate the user and
 * project config tiers: those are addressed by `homeDir` and `workingDir`, and
 * runtime/secrets-composition.ts explains why conflating them would be wrong.
 * `describeSecretIsolation` reports which tiers an override actually moved
 * rather than implying it moved all of them.
 *
 * What WAS broken is that the resolved value reached only the identity files.
 * The ConfigManager derived its daemon tier from `homedir()` regardless, so a
 * daemon told to keep its state elsewhere still read the real home's daemon
 * settings, and the credential store stayed behind too. `daemonTierPath` here
 * is that gap closed: one resolution, handed to every consumer.
 */

import { homedir } from 'node:os';
import { daemonConfigPathForHome } from '../config/daemon-config-tier.js';
import { readDaemonSetting, resolveDaemonHomeDir } from '../workspace/daemon-home.js';

/** Every path a daemon process derives from its flags and environment. */
export interface DaemonCliPaths {
  /** The project/workspace root: logs, project settings, session state. */
  readonly workingDirectory: string;
  /** The user home the user and project config tiers resolve against. */
  readonly homeDirectory: string;
  /** The daemon's own state directory (`--daemon-home`). */
  readonly daemonHomeDir: string;
  /** The daemon config tier file inside that state directory. */
  readonly daemonTierPath: string;
}

export interface DaemonCliPathInput {
  readonly argv?: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Injected so a test can supply a fake "real home" and prove it is not read. */
  readonly homeDirectory?: string | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Parse `--flag=<value>` or `--flag <value>` from an argv array.
 * Returns undefined when the flag is not present.
 */
export function parseCliFlag(args: readonly string[], flagPrefix: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith(`${flagPrefix}=`)) return arg.slice(flagPrefix.length + 1);
    if (arg === flagPrefix) return args[index + 1];
  }
  return undefined;
}

/**
 * Resolve every path the daemon runs on, from flags, environment, and the
 * persisted daemon settings — in that precedence.
 */
export function resolveDaemonCliPaths(input: DaemonCliPathInput = {}): DaemonCliPaths {
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const daemonHomeArg = parseCliFlag(argv, '--daemon-home');
  const workingDirArg = parseCliFlag(argv, '--working-dir');

  const daemonHomeDir = resolveDaemonHomeDir({ daemonHomeArg, env });

  // Working dir: flag > env > the daemon's own persisted setting > cwd. The
  // persisted read comes from the RESOLVED daemon home, so an overridden home
  // supplies its own working directory rather than the real home's.
  const workingDirectory =
    workingDirArg ??
    env['GOODVIBES_WORKING_DIR'] ??
    readDaemonSetting(daemonHomeDir, 'runtime.workingDir') ??
    input.cwd ??
    process.cwd();

  return {
    workingDirectory,
    homeDirectory: input.homeDirectory ?? homedir(),
    daemonHomeDir,
    daemonTierPath: daemonConfigPathForHome(daemonHomeDir),
  };
}
