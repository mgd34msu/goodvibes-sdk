/**
 * reachability-check.ts — the boot-time answer to "is this the build you are
 * actually reaching, and is it the current one".
 *
 * It wires the real host inputs (a process's executable, the real PATH,
 * existsSync/realpathSync, and a bounded `<path> --version` spawn) into the pure
 * scan in path-shadow.ts and the pure wording in reachability-notice.ts, and
 * hands back lines. WHERE those lines go — a system-message router, stdout
 * before the alternate screen, a log — is the product's, because only the
 * product knows what it has to print with at that moment.
 *
 * Cost discipline, because this runs on every start:
 *   - the first scan is existence-only: no process is spawned while there is
 *     nothing to report, which is the overwhelmingly common case;
 *   - versions are probed only after a shadow has already been found, and only
 *     with `--version`, bounded by a short timeout;
 *   - the latest-release lookup only happens when it can actually change what
 *     the user should do: a package-managed or source install (which will never
 *     swap itself), or an install that has just been found unreachable. A
 *     healthy binary install has already been brought to the latest release by
 *     the launch auto-updater, so asking again would be a network round trip
 *     that can only confirm what just happened.
 *
 * Every failure is swallowed. A reachability check must never block or crash
 * boot.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  BINARY_INSTALL_COMMAND,
  detectInstallKind,
  fallbackUpdateCommand,
} from './install-kind.js';
import { scanCommandShadows, splitPathEntries, type ShadowScanResult } from './path-shadow.js';
import { buildReachabilityNotices, type ReachabilityNotice } from './reachability-notice.js';

/** The commands one install of this platform places side by side in a directory. */
export const INSTALLED_COMMANDS = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'] as const;

/** How long a `<path> --version` probe may take before it is abandoned. */
const VERSION_PROBE_TIMEOUT_MS = 3000;
/** How long the latest-release lookup may take before startup moves on without it. */
export const LATEST_LOOKUP_TIMEOUT_MS = 2500;

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    // Any execute bit is enough: the shell searches for an executable file,
    // and which bit applies depends on ownership we are not going to compute.
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Runs `<path> --version` and returns its first line. Never inherits stdio, so
 * a binary that tries to draw a terminal cannot disturb this one.
 */
export function probeVersionLine(path: string): string | undefined {
  try {
    const result = spawnSync(path, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.error || typeof result.stdout !== 'string') return undefined;
    return result.stdout.split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * The PATH directory that provides THIS running executable, which is the
 * position everything else is measured against.
 *
 * Preferred answer: the first PATH entry whose `<dir>/<command>` resolves,
 * through symlinks, to this same file. That is exactly "where the shell would
 * find me", and it is right for a linked package install as well as a
 * standalone binary.
 *
 * Fallback, for a standalone binary only: the directory the executable sits in.
 * That directory being absent from PATH is itself worth reporting — an
 * installed binary nobody can reach by name. For a package-managed install the
 * executable lives inside node_modules, which is never on PATH and never meant
 * to be, so there is nothing honest to say and the check stays silent.
 */
export function resolveSelfDirectory(input: {
  readonly execPath: string;
  readonly command: string;
  readonly pathEntries: readonly string[];
  readonly realPath: (path: string) => string;
  readonly isExecutableFile: (path: string) => boolean;
}): string | undefined {
  const self = input.realPath(input.execPath);
  for (const directory of input.pathEntries) {
    const candidate = join(directory, input.command);
    if (!input.isExecutableFile(candidate)) continue;
    if (input.realPath(candidate) === self) return directory;
  }
  if (detectInstallKind(input.execPath) === 'binary') return dirname(self);
  return undefined;
}

/** Which of the installed commands actually sit in this directory. */
function commandsPresentIn(directory: string, exists: (path: string) => boolean): string[] {
  return INSTALLED_COMMANDS.filter((command) => exists(join(directory, command)));
}

export interface ReachabilityCheckResult {
  readonly notices: readonly ReachabilityNotice[];
  readonly scan?: ShadowScanResult | undefined;
}

export interface ReachabilityCheckInput {
  readonly execPath: string;
  readonly pathValue: string | undefined;
  readonly homeDir: string;
  readonly runningVersion: string;
  readonly commandName?: string | undefined;
  /**
   * The calling product's package name, used only to name the upgrade command
   * for a package-managed install. A binary install is placed by the platform
   * installer; a package-managed one is the user's package manager to move.
   */
  readonly packageName: string;
  /** Resolves the newest released version, or undefined when it cannot be determined. */
  readonly resolveLatest: () => Promise<string | undefined>;
  // The host touches, injectable so a test drives a whole scenario with fake
  // paths and never spawns anything. Production passes none of these.
  readonly isExecutableFile?: ((path: string) => boolean) | undefined;
  readonly realPath?: ((path: string) => string) | undefined;
  readonly probeVersion?: ((path: string) => string | undefined) | undefined;
}

/**
 * The whole check, with the network lookup injected so tests never reach it.
 * Returns the notices to print; an empty list is the healthy case.
 */
export async function runReachabilityCheck(input: ReachabilityCheckInput): Promise<ReachabilityCheckResult> {
  const command = input.commandName ?? basename(input.execPath);
  const pathEntries = splitPathEntries(input.pathValue);
  const installKind = detectInstallKind(input.execPath);
  const fileIsExecutable = input.isExecutableFile ?? isExecutableFile;
  const resolvePath = input.realPath ?? safeRealPath;
  const versionProbe = input.probeVersion ?? probeVersionLine;

  // A source checkout is not an install: there is no maintained copy to be
  // shadowed and no release to be behind.
  if (installKind === 'source') return { notices: [] };

  const selfDirectory = resolveSelfDirectory({
    execPath: input.execPath,
    command,
    pathEntries,
    realPath: resolvePath,
    isExecutableFile: fileIsExecutable,
  });
  if (!selfDirectory) return { notices: [] };

  const commands = commandsPresentIn(selfDirectory, fileIsExecutable);
  const base = {
    commands: commands.length > 0 ? commands : [command],
    installDir: selfDirectory,
    pathEntries,
    homeDir: input.homeDir,
    isExecutableFile: fileIsExecutable,
    realPath: resolvePath,
  };

  // Existence-only first: nothing is spawned while there is nothing to report.
  const cheapScan = scanCommandShadows(base);
  const scan = cheapScan.hasProblem
    ? scanCommandShadows({ ...base, probeVersion: versionProbe })
    : cheapScan;

  const latestVersion = scan.hasProblem || installKind !== 'binary'
    ? await input.resolveLatest()
    : undefined;

  return {
    scan,
    notices: buildReachabilityNotices({
      scan,
      runningVersion: input.runningVersion,
      latestVersion,
      updateCommand: installKind === 'binary'
        ? BINARY_INSTALL_COMMAND
        : fallbackUpdateCommand(installKind, input.packageName),
    }),
  };
}

/**
 * Bound a latest-release lookup so a slow network cannot hold up boot: whatever
 * the lookup has not answered within `timeoutMs` is treated as unknown, which
 * reachability-notice.ts renders as silence rather than a guess.
 */
export async function boundedLatestRelease(
  lookup: () => Promise<string | undefined>,
  timeoutMs: number = LATEST_LOOKUP_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const timed = await Promise.race([
      lookup(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return timed ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the check and hand every line to `emit`, in the order it should be read.
 * Returns the lines emitted so a caller that printed them before its alternate
 * screen took over can re-surface them afterwards. Swallows everything — a
 * reachability check must never block or crash boot.
 */
export async function announceReachability(
  input: ReachabilityCheckInput,
  emit: (line: string) => void,
): Promise<readonly string[]> {
  const lines: string[] = [];
  try {
    const result = await runReachabilityCheck(input);
    for (const notice of result.notices) {
      for (const line of notice.lines) {
        lines.push(line);
        emit(line);
      }
    }
  } catch {
    // Best-effort — a reachability check must never block or crash boot.
  }
  return lines;
}
