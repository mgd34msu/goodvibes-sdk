/**
 * setup.ts
 *
 * Worktree cold-start setup — the per-project provisioning that makes an
 * isolated/worktree agent usable instead of broken-by-default. A fresh git
 * worktree is checked out from a committed branch, so it has NONE of the
 * working tree's installed dependencies, generated code, or untracked local
 * files. This module runs configured setup commands (install, codegen) in the
 * worktree and carries over configured untracked files (globs) from the source
 * working tree, capturing honest logs and an honest terminal state.
 *
 * Honesty contract: a command that exits non-zero stops the run and yields
 * state `failed` with the failing step's captured output — never a silent
 * best-effort. No commands AND no carry-over globs configured yields `skipped`
 * (there was nothing to do), which is distinct from `succeeded` (work ran and
 * passed).
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Per-project worktree setup configuration (resolved from the daemon config). */
export interface WorktreeSetupConfig {
  /** Shell command lines to run, in order, in the new worktree (e.g. `bun install`, `bun run codegen`). */
  readonly commands: readonly string[];
  /** Globs (relative to the source working tree) of UNTRACKED files to copy into the new worktree (e.g. `.env`, `.env.*`, `config/local.json`). */
  readonly carryOverGlobs: readonly string[];
}

/** The honest terminal state of a setup run. */
export type WorktreeSetupState = 'skipped' | 'succeeded' | 'failed';

/** One step of a setup run — a single command, or the aggregate carry-over pass. */
export interface WorktreeSetupStep {
  readonly kind: 'command' | 'carry-over';
  /** The command line, or a human label for the carry-over pass. */
  readonly label: string;
  readonly ok: boolean;
  /** Process exit code for a command step; absent for carry-over. */
  readonly exitCode?: number | undefined;
  /** Captured combined stdout+stderr for a command, or the list of carried-over paths for carry-over. Bounded. */
  readonly output: string;
}

/** The full result of a setup run — persisted onto the worktree record and returned by the rerun verb. */
export interface WorktreeSetupResult {
  readonly state: WorktreeSetupState;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly steps: readonly WorktreeSetupStep[];
  /** Present only when state === 'failed': the honest reason (the failing command line, or an I/O error). */
  readonly error?: string | undefined;
}

/** Outcome of running one command: injectable so tests drive it without spawning real processes. */
export interface WorktreeCommandOutcome {
  readonly exitCode: number;
  readonly output: string;
}

/** Runs a single shell command line in `cwd`, returning its exit code and captured combined output. */
export type WorktreeCommandRunner = (commandLine: string, cwd: string) => Promise<WorktreeCommandOutcome>;

/** Lists UNTRACKED files (relative paths) in the source working tree — the carry-over candidate set. Injectable for tests. */
export type UntrackedFileLister = (sourceRoot: string) => Promise<readonly string[]>;

export interface RunWorktreeSetupOptions {
  readonly runCommand?: WorktreeCommandRunner | undefined;
  readonly listUntracked?: UntrackedFileLister | undefined;
  readonly now?: (() => number) | undefined;
}

/** Cap captured command output so a chatty install never bloats the persisted record. */
const MAX_STEP_OUTPUT_BYTES = 16_384;

function clampOutput(text: string): string {
  if (text.length <= MAX_STEP_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_STEP_OUTPUT_BYTES)}\n…[truncated ${text.length - MAX_STEP_OUTPUT_BYTES} bytes]`;
}

/** Default command runner: Bun.spawn through `sh -c`, capturing combined stdout+stderr. */
const defaultRunCommand: WorktreeCommandRunner = async (commandLine, cwd) => {
  const proc = Bun.spawn(['sh', '-c', commandLine], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: clampOutput([stdout, stderr].filter((s) => s.length > 0).join('\n')) };
};

/** Default untracked lister: `git ls-files --others --exclude-standard` in the source root. */
const defaultListUntracked: UntrackedFileLister = async (sourceRoot) => {
  const proc = Bun.spawn(['git', 'ls-files', '--others', '--exclude-standard'], {
    cwd: sourceRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return [];
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
};

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  for (const pattern of globs) {
    try {
      if (new Bun.Glob(pattern).match(path)) return true;
    } catch {
      // An invalid glob never matches (and never throws the whole run).
    }
  }
  return false;
}

/**
 * Run cold-start setup for a freshly-created worktree. Runs each command in
 * order (stopping on the first non-zero exit), then copies untracked files
 * matching the carry-over globs from `sourceRoot` into `worktreePath`.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  sourceRoot: string,
  config: WorktreeSetupConfig,
  options: RunWorktreeSetupOptions = {},
): Promise<WorktreeSetupResult> {
  const now = options.now ?? Date.now;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const listUntracked = options.listUntracked ?? defaultListUntracked;
  const startedAt = now();
  const steps: WorktreeSetupStep[] = [];

  const hasCommands = config.commands.length > 0;
  const hasGlobs = config.carryOverGlobs.length > 0;
  if (!hasCommands && !hasGlobs) {
    return { state: 'skipped', startedAt, completedAt: now(), steps: [] };
  }

  for (const commandLine of config.commands) {
    let outcome: WorktreeCommandOutcome;
    try {
      outcome = await runCommand(commandLine, worktreePath);
    } catch (err) {
      const output = summarizeError(err);
      steps.push({ kind: 'command', label: commandLine, ok: false, output: clampOutput(output) });
      logger.warn('runWorktreeSetup: command threw', { commandLine, worktreePath, error: output });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command failed to run: ${commandLine}` };
    }
    const ok = outcome.exitCode === 0;
    steps.push({ kind: 'command', label: commandLine, ok, exitCode: outcome.exitCode, output: outcome.output });
    if (!ok) {
      logger.warn('runWorktreeSetup: command exited non-zero', { commandLine, worktreePath, exitCode: outcome.exitCode });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command exited ${outcome.exitCode}: ${commandLine}` };
    }
  }

  if (hasGlobs) {
    const carriedOver: string[] = [];
    let carryError: string | undefined;
    try {
      const untracked = await listUntracked(sourceRoot);
      for (const relative of untracked) {
        if (!matchesAnyGlob(relative, config.carryOverGlobs)) continue;
        const from = join(sourceRoot, relative);
        const to = join(worktreePath, relative);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
        carriedOver.push(relative);
      }
    } catch (err) {
      carryError = summarizeError(err);
    }
    if (carryError) {
      steps.push({ kind: 'carry-over', label: 'carry over untracked files', ok: false, output: clampOutput(carryError) });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `carry-over of untracked files failed: ${carryError}` };
    }
    steps.push({ kind: 'carry-over', label: 'carry over untracked files', ok: true, output: carriedOver.join('\n') });
  }

  return { state: 'succeeded', startedAt, completedAt: now(), steps };
}

/**
 * Resolve the per-project worktree setup config from the daemon config. Reads
 * `worktree.setup.commands` (array of command lines) and
 * `worktree.setup.carryOverGlobs` (array of globs). Non-array/malformed values
 * degrade to empty (setup then `skipped`), never a throw.
 */
export function resolveWorktreeSetupConfig(get: (key: string) => unknown): WorktreeSetupConfig {
  return {
    commands: readStringArray(get('worktree.setup.commands')),
    carryOverGlobs: readStringArray(get('worktree.setup.carryOverGlobs')),
  };
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}
