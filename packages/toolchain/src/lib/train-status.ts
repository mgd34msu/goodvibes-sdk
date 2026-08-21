/**
 * train-status, one read-only table per release-train cycle showing what the
 * cycle actually involves across the family's local checkouts.
 *
 * Strictly read-only: every git/npm call this module makes is a query (no
 * push, tag, install, or write outside stdout). Decision and rendering logic
 * (classifySdkPin/deriveAction/deriveRow/render*) is pure over gathered
 * structs, so unit tests drive it without touching git or npm; gatherOneRepo
 * and gatherTrainStatus are the only impure pieces, and take their subprocess
 * runner as an injectable `Exec` (see effects.ts) so a real integration test
 * can point them at throwaway repos while stubbing out `npm view`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';

import type { Exec } from './effects.js';
import { realExec } from './effects.js';

export type RepoKind = 'sdk' | 'sdk-consumer' | 'independent';

export interface TrainStatusRepoEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: RepoKind;
  readonly releaseCommand?: string;
}

export interface TrainStatusManifest {
  readonly repos: readonly TrainStatusRepoEntry[];
}

// ---------------------------------------------------------------------------
// Manifest schema (boundary validation)
// ---------------------------------------------------------------------------

const RepoEntrySchema = z.object({
  path: z.string().min(1, 'must be a non-empty string'),
  name: z.string().min(1, 'must be a non-empty string'),
  kind: z.enum(['sdk', 'sdk-consumer', 'independent']),
  releaseCommand: z.string().min(1, 'must be a non-empty string').optional(),
}).catchall(z.unknown());

const TrainStatusManifestSchema = z.object({
  repos: z.array(RepoEntrySchema).min(1, 'must list at least one repo'),
}).catchall(z.unknown());

/** Render a `ZodError` as one line per bad field, each naming its path. */
function formatManifestError(error: z.ZodError): string {
  const problems = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${field}: ${issue.message}`;
  });
  return `train-status manifest is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`;
}

/** Parse and validate a train-status manifest from raw JSON text. Throws a clear, field-named error on a bad shape. */
export function parseTrainStatusManifest(raw: string): TrainStatusManifest {
  const value: unknown = JSON.parse(raw);
  const result = TrainStatusManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(formatManifestError(result.error));
  }
  return result.data as TrainStatusManifest;
}

// ---------------------------------------------------------------------------
// Gathered facts (pre-decision) and the decided row
// ---------------------------------------------------------------------------

export interface RepoGathered {
  readonly entry: TrainStatusRepoEntry;
  /** `n/a` for repos with no package.json (e.g. a Python repo in the family). */
  readonly version: string;
  /** The @pellux/goodvibes-sdk pin read from dependencies/devDependencies; null when absent or not an sdk-consumer. */
  readonly sdkPin: string | null;
  readonly lastTag: string | null;
  readonly commitsSinceTag: number;
  readonly unpushedCommits: number;
}

export interface RepoRow {
  readonly name: string;
  readonly kind: RepoKind;
  readonly version: string;
  /** `n/a` for kinds other than sdk-consumer. */
  readonly sdkPin: string;
  readonly lastTag: string;
  readonly commitsSinceTag: number;
  readonly unpushedCommits: number;
  readonly action: string;
  /** Set only on a gather failure (path missing / not a git repo); the row still prints. */
  readonly error?: string;
}

export const SDK_PACKAGE_NAME = '@pellux/goodvibes-sdk';

/** Render the sdk-consumer pin ⇄ latest column. `n/a` for non-consumer kinds. */
export function classifySdkPin(pin: string | null, latest: string | null, kind: RepoKind): string {
  if (kind !== 'sdk-consumer') return 'n/a';
  if (!pin) return 'unpinned';
  if (!latest) return `${pin} (latest unknown)`;
  return pin === latest ? `${pin} (current)` : `${pin} -> ${latest} (repin needed)`;
}

function needsRepin(pin: string | null, latest: string | null, kind: RepoKind): boolean {
  return kind === 'sdk-consumer' && pin !== null && latest !== null && pin !== latest;
}

/** Derive the suggested action for one repo. Pure; the manifest's releaseCommand is used verbatim when present. */
export function deriveAction(gathered: RepoGathered, latestSdkVersion: string | null): string {
  const { entry, commitsSinceTag, unpushedCommits, sdkPin } = gathered;

  if (entry.kind === 'sdk') {
    return commitsSinceTag > 0 ? 'cut vNEXT' : 'idle';
  }

  if (entry.kind === 'sdk-consumer') {
    if (needsRepin(sdkPin, latestSdkVersion, entry.kind)) {
      return `repin to ${latestSdkVersion} then release`;
    }
    return commitsSinceTag > 0 ? `release (${commitsSinceTag} unreleased)` : 'idle';
  }

  // independent
  if (commitsSinceTag > 0) {
    const suffix = entry.releaseCommand ? `: ${entry.releaseCommand}` : '';
    return `release (${commitsSinceTag} unreleased)${suffix}`;
  }
  if (unpushedCommits > 0) {
    return `push (${unpushedCommits} unpushed)`;
  }
  return 'idle';
}

/** Turn gathered facts into the printed row. Pure. */
export function deriveRow(gathered: RepoGathered, latestSdkVersion: string | null): RepoRow {
  return {
    name: gathered.entry.name,
    kind: gathered.entry.kind,
    version: gathered.version,
    sdkPin: classifySdkPin(gathered.sdkPin, latestSdkVersion, gathered.entry.kind),
    lastTag: gathered.lastTag ?? '(none)',
    commitsSinceTag: gathered.commitsSinceTag,
    unpushedCommits: gathered.unpushedCommits,
    action: deriveAction(gathered, latestSdkVersion),
  };
}

/** Build the one error row for a repo whose facts could not be gathered. Never throws. */
export function errorRow(entry: TrainStatusRepoEntry, message: string): RepoRow {
  return {
    name: entry.name,
    kind: entry.kind,
    version: 'n/a',
    sdkPin: 'n/a',
    lastTag: 'n/a',
    commitsSinceTag: 0,
    unpushedCommits: 0,
    action: `ERROR: ${message}`,
    error: message,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TABLE_HEADERS = ['REPO', 'KIND', 'VERSION', 'SDK PIN', 'LAST TAG', 'SINCE TAG', 'UNPUSHED', 'ACTION'] as const;

function rowCells(row: RepoRow): string[] {
  return [
    row.name,
    row.kind,
    row.version,
    row.sdkPin,
    row.lastTag,
    String(row.commitsSinceTag),
    String(row.unpushedCommits),
    row.action,
  ];
}

/** Repos whose action is neither idle nor an error, the "needs action" count for the summary line. */
export function countNeedingAction(rows: readonly RepoRow[]): number {
  return rows.filter((row) => !row.error && row.action !== 'idle').length;
}

/** Render the aligned plain-text table plus a one-line summary. */
export function renderTrainStatusTable(rows: readonly RepoRow[]): string {
  const headerCells = [...TABLE_HEADERS];
  const bodyCells = rows.map(rowCells);
  const widths = TABLE_HEADERS.map((_, i) => Math.max(headerCells[i]!.length, ...bodyCells.map((cells) => cells[i]!.length)));
  const renderLine = (cells: readonly string[]): string => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();

  const lines = [renderLine(headerCells), ...bodyCells.map((cells) => renderLine(cells))];
  const needAction = countNeedingAction(rows);
  lines.push('');
  lines.push(`${rows.length} repo${rows.length === 1 ? '' : 's'}, ${needAction} need action`);
  return lines.join('\n');
}

export interface TrainStatusResult {
  readonly latestSdkVersion: string | null;
  readonly rows: readonly RepoRow[];
}

/** Render the raw structured result as JSON (the `--json` output). */
export function renderTrainStatusJson(result: TrainStatusResult): string {
  const summary = { total: result.rows.length, needAction: countNeedingAction(result.rows) };
  return `${JSON.stringify({ ...result, summary }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Gather (impure: git + npm + package.json reads against the manifest's repo paths)
// ---------------------------------------------------------------------------

// Every git/npm call gets its own timeout so one unreachable remote or a stuck
// `npm view` cannot hang the whole run.
const GIT_TIMEOUT_MS = 15_000;
const NPM_TIMEOUT_MS = 20_000;

function runGit(exec: Exec, repoPath: string, args: readonly string[]) {
  return exec('git', args, { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
}

/** Read `package.json`'s version at a repo path. `n/a` when the file is absent or unparsable (e.g. a Python repo). */
export function readPackageVersion(repoPath: string): string {
  const pkgPath = resolve(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return 'n/a';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'n/a';
  } catch {
    return 'n/a';
  }
}

/** Read the @pellux/goodvibes-sdk pin from dependencies or devDependencies. Null when absent. */
export function readTrainStatusSdkPin(repoPath: string): string | null {
  const pkgPath = resolve(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const pin = pkg.dependencies?.[SDK_PACKAGE_NAME] ?? pkg.devDependencies?.[SDK_PACKAGE_NAME];
    return typeof pin === 'string' ? pin : null;
  } catch {
    return null;
  }
}

interface GitFacts {
  readonly lastTag: string | null;
  readonly commitsSinceTag: number;
  readonly unpushedCommits: number;
}

/** Last release tag, commits since it (or total commits with no tag), and unpushed commits. Tolerates no tag / no upstream. */
export function gatherGitFacts(exec: Exec, repoPath: string): GitFacts {
  const describe = runGit(exec, repoPath, ['describe', '--tags', '--abbrev=0']);
  const lastTag = describe.status === 0 && describe.stdout.trim().length > 0 ? describe.stdout.trim() : null;

  const countArgs = lastTag ? [`${lastTag}..HEAD`, '--count'] : ['HEAD', '--count'];
  const countResult = runGit(exec, repoPath, ['rev-list', ...countArgs]);
  const commitsSinceTag = countResult.status === 0 ? Number.parseInt(countResult.stdout.trim(), 10) || 0 : 0;

  const unpushedResult = runGit(exec, repoPath, ['rev-list', '@{upstream}..HEAD', '--count']);
  const unpushedCommits = unpushedResult.status === 0 ? Number.parseInt(unpushedResult.stdout.trim(), 10) || 0 : 0;

  return { lastTag, commitsSinceTag, unpushedCommits };
}

/** Fetches the latest published SDK version once for the whole run. Null when npm view fails or returns nothing. */
export type FetchLatestSdkVersion = (exec: Exec) => string | null;

export const realFetchLatestSdkVersion: FetchLatestSdkVersion = (exec) => {
  const result = exec('npm', ['view', SDK_PACKAGE_NAME, 'version'], { timeoutMs: NPM_TIMEOUT_MS });
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  return version.length > 0 ? version : null;
};

/** Gather one repo's row. Never throws: a missing path or non-git-repo path becomes a single error row. */
export function gatherOneRepo(exec: Exec, entry: TrainStatusRepoEntry, latestSdkVersion: string | null): RepoRow {
  if (!existsSync(entry.path)) {
    return errorRow(entry, `path does not exist: ${entry.path}`);
  }
  const gitCheck = runGit(exec, entry.path, ['rev-parse', '--is-inside-work-tree']);
  if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
    return errorRow(entry, `not a git repository: ${entry.path}`);
  }

  const version = readPackageVersion(entry.path);
  const sdkPin = entry.kind === 'sdk-consumer' ? readTrainStatusSdkPin(entry.path) : null;
  const { lastTag, commitsSinceTag, unpushedCommits } = gatherGitFacts(exec, entry.path);

  return deriveRow({ entry, version, sdkPin, lastTag, commitsSinceTag, unpushedCommits }, latestSdkVersion);
}

export interface GatherTrainStatusOptions {
  readonly exec?: Exec;
  /** Overridable so an integration test can skip the real npm registry call. */
  readonly fetchLatestSdkVersion?: FetchLatestSdkVersion;
}

/** Gather every repo in the manifest into the full train-status result. The only network/subprocess entry point. */
export function gatherTrainStatus(manifest: TrainStatusManifest, options: GatherTrainStatusOptions = {}): TrainStatusResult {
  const exec = options.exec ?? realExec;
  const fetchLatestSdkVersion = options.fetchLatestSdkVersion ?? realFetchLatestSdkVersion;

  // Fetched once for the whole run, not per repo, whether or not there turns
  // out to be an sdk-consumer, keeps the call graph obvious from this one line.
  const needsSdkVersion = manifest.repos.some((entry) => entry.kind === 'sdk-consumer');
  const latestSdkVersion = needsSdkVersion ? fetchLatestSdkVersion(exec) : null;

  const rows = manifest.repos.map((entry) => gatherOneRepo(exec, entry, latestSdkVersion));
  return { latestSdkVersion, rows };
}
