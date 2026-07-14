/**
 * ci-watch/auto-watch.ts — CI watches mint themselves at the push/PR seam.
 *
 * Work done through the platform that pushes a branch (or opens a PR) in a CI
 * repo creates its own watch — no ceremony. The seam is tool execution: a
 * successful exec run whose commands include `git push` or `gh pr create`
 * mints a watch for the pushed branch (fire-and-forget; the tool-result path
 * is never blocked, mirroring the code-index reindex scheduler's contract).
 * A GitService-driven push can call `onGitPushed` directly for the same mint.
 *
 * Delivery defaults to the daemon's own operator-surface channel ('web' — the
 * control-plane delivery the existing push-notification path rides), and the
 * red-run "fix this?" offer plus verdict-retirement behavior come free from
 * CiWatchService: the watch EXPIRES once its terminal verdict is delivered.
 * The scripted path (/ci watch → ci.watches.create) is untouched.
 */
import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CiWatchSubscription } from './types.js';
import type { CreateCiWatchInput } from './service.js';

/** The default delivery channel: the daemon's operator web surface (control-plane delivery). */
export const DEFAULT_AUTO_WATCH_CHANNEL = 'web';

/** A push detected in an exec command list. */
export interface DetectedCiPush {
  readonly kind: 'push' | 'pr';
  /** The pushed branch when the command names one (else the current branch is resolved). */
  readonly branch?: string | undefined;
}

const PUSH_FLAG_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--repo', '--exec']);

/**
 * Detect a CI-relevant push in one exec command line: `git push ...` or
 * `gh pr create ...`. Only simple top-level forms are matched — a compound
 * line still matches when a segment starts with the command.
 */
export function detectCiPushInCommand(command: string): DetectedCiPush | null {
  // Split compound shells conservatively; each segment is inspected alone.
  for (const segment of command.split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'create') {
      return { kind: 'pr' };
    }
    if (tokens[0] !== 'git') continue;
    const pushIndex = tokens.indexOf('push');
    if (pushIndex === -1) continue;
    // Positional args after `push`, skipping flags (and their values where known):
    // the first positional is the remote, the second the refspec/branch.
    const positionals: string[] = [];
    for (let i = pushIndex + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith('-')) {
        if (PUSH_FLAG_WITH_VALUE.has(token)) i += 1;
        continue;
      }
      positionals.push(token);
    }
    const refspec = positionals[1];
    // `HEAD:feature-x` pushes the right-hand branch; a plain branch is itself.
    const branch = refspec?.includes(':') ? refspec.split(':')[1] : refspec;
    return { kind: 'push', branch: branch || undefined };
  }
  return null;
}

/** Extract the command strings from exec-tool args ({ commands: [{cmd}] } or strings). */
export function execCommandsFromArgs(args: Record<string, unknown>): string[] {
  const commands = args.commands;
  if (!Array.isArray(commands)) return [];
  const out: string[] = [];
  for (const entry of commands) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as { cmd?: unknown }).cmd === 'string') {
      out.push((entry as { cmd: string }).cmd);
    }
  }
  return out;
}

/** Parse a git remote URL into a GitHub owner/name slug, or null when not GitHub. */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/(?:^|[/@])github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** Runs a git command in cwd and yields trimmed stdout, or null on any failure. */
function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

export interface CiWatchAutoMintDeps {
  readonly service: {
    createWatch(input: CreateCiWatchInput): Promise<CiWatchSubscription>;
    listWatches(): Promise<CiWatchSubscription[]>;
  };
  /** The working directory pushes resolve against when exec args carry none. */
  readonly workingDirectory: string;
  /** Delivery channel for minted watches; defaults to the operator web surface. */
  readonly deliveryChannel?: string | undefined;
  /** Injectable repo-slug resolver (tests); default shells `git remote get-url`. */
  readonly resolveRepoSlug?: ((cwd: string) => Promise<string | null>) | undefined;
  /** Injectable current-branch resolver (tests); default shells `git rev-parse`. */
  readonly resolveCurrentBranch?: ((cwd: string) => Promise<string | null>) | undefined;
}

/**
 * The self-minting tap. `onToolExecuted` has the exact shape of the shared
 * tool-execution observer seam; `onGitPushed` serves GitService-path callers.
 * Minting is asynchronous and best-effort — it never blocks or fails the
 * caller, and a repo that is not a GitHub remote is a silent no-op (the gh
 * status source could not watch it honestly).
 */
export class CiWatchAutoMinter {
  constructor(private readonly deps: CiWatchAutoMintDeps) {}

  /** Tool-execution observer: mints on a successful exec containing a push/PR-create. */
  onToolExecuted(toolName: string, args: Record<string, unknown>, success: boolean): void {
    if (toolName !== 'exec' || !success) return;
    for (const command of execCommandsFromArgs(args)) {
      const detected = detectCiPushInCommand(command);
      if (!detected) continue;
      const cwd = typeof args.working_dir === 'string' && args.working_dir.trim()
        ? args.working_dir
        : this.deps.workingDirectory;
      void this.mint(cwd, detected).catch((error) => {
        logger.warn('[ci-watch] auto-mint failed', { command, error: summarizeError(error) });
      });
      return; // one mint per exec call is enough
    }
  }

  /** GitService-path tap: a platform push through GitService mints the same way. */
  onGitPushed(input: { readonly cwd: string; readonly branch?: string | undefined }): void {
    void this.mint(input.cwd, { kind: 'push', branch: input.branch }).catch((error) => {
      logger.warn('[ci-watch] auto-mint failed', { cwd: input.cwd, error: summarizeError(error) });
    });
  }

  private async mint(cwd: string, detected: DetectedCiPush): Promise<CiWatchSubscription | null> {
    const repo = await (this.deps.resolveRepoSlug
      ? this.deps.resolveRepoSlug(cwd)
      : runGit(cwd, ['remote', 'get-url', 'origin']).then((url) => (url ? parseGitHubSlug(url) : null)));
    if (!repo) return null;

    const branch = detected.branch ?? await (this.deps.resolveCurrentBranch
      ? this.deps.resolveCurrentBranch(cwd)
      : runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
    if (!branch || branch === 'HEAD') return null;

    // No ceremony also means no duplicates: one live watch per repo+ref.
    const existing = await this.deps.service.listWatches();
    if (existing.some((watch) => watch.repo === repo && watch.ref === branch)) return null;

    const watch = await this.deps.service.createWatch({
      repo,
      ref: branch,
      deliveryChannel: this.deps.deliveryChannel ?? DEFAULT_AUTO_WATCH_CHANNEL,
    });
    logger.info('[ci-watch] watch self-minted at the push seam', { repo, ref: branch, id: watch.id });
    return watch;
  }
}
