/**
 * release-cut — local release preparation ONLY.
 *
 * Per the CI/CD design's principle 4 (CI owns validation), this tool never
 * re-runs gates. It: guards a clean tree on the release branch, bumps the
 * version across the root and configured manifests, runs the repo's version-
 * sync commands, prepends a CHANGELOG section, commits, and creates an
 * annotated tag. Validation happened on the push CI run; the tag is cut from an
 * already-green tree and verified by-reference downstream.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Exec, Logger } from './effects.js';
import { realExec, consoleLogger } from './effects.js';
import type { ReleaseCutConfig } from '../config.js';

export type BumpKind = 'patch' | 'minor' | 'major';

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse an exact X.Y.Z string; throws on anything else. */
export function parseSemver(version: string): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Not an exact X.Y.Z version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Compute the next version for a bump kind. */
export function nextVersion(current: string, kind: BumpKind): string {
  const { major, minor, patch } = parseSemver(current);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Render a CHANGELOG section heading for a version. */
export function changelogHeading(version: string, style: 'bracket' | 'plain', date: string): string {
  return style === 'bracket' ? `## [${version}] - ${date}` : `## ${version} - ${date}`;
}

/** Build a full CHANGELOG section body from a heading and notes/commit lines. */
export function buildChangelogSection(version: string, style: 'bracket' | 'plain', date: string, bodyLines: readonly string[]): string {
  const lines = bodyLines.length > 0 ? bodyLines : ['- Release maintenance.'];
  return `${changelogHeading(version, style, date)}\n\n### Changes\n\n${lines.join('\n')}\n`;
}

/**
 * Insert a new section into changelog text. `top` prepends above the first
 * `## ` heading; `first-separator` inserts after the first `---` line.
 */
export function insertChangelogSection(changelog: string, section: string, marker: 'first-separator' | 'top'): string {
  if (marker === 'first-separator') {
    const idx = changelog.indexOf('\n---\n');
    if (idx === -1) throw new Error('CHANGELOG has no "---" separator to insert after.');
    const cut = idx + '\n---\n'.length;
    return `${changelog.slice(0, cut)}\n${section}\n${changelog.slice(cut).replace(/^\n+/, '')}`;
  }
  const firstHeading = changelog.search(/^## /m);
  if (firstHeading === -1) return `${changelog.trimEnd()}\n\n${section}\n`;
  return `${changelog.slice(0, firstHeading)}${section}\n\n${changelog.slice(firstHeading)}`;
}

export interface ReleaseCutOptions {
  readonly cwd: string;
  readonly bump: BumpKind;
  readonly config: ReleaseCutConfig;
  readonly notes?: readonly string[];
  readonly date?: string;
  readonly dryRun?: boolean;
  readonly exec?: Exec;
  readonly logger?: Logger;
}

export interface ReleaseCutResult {
  readonly version: string;
  readonly tag: string;
  readonly committed: boolean;
}

function setManifestVersion(path: string, version: string): void {
  const text = readFileSync(path, 'utf8');
  const manifest = JSON.parse(text) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function requireClean(exec: Exec, cwd: string, branch: string): void {
  const status = exec('git', ['status', '--porcelain'], { cwd });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim().length > 0) {
    throw new Error(`Working tree is not clean:\n${status.stdout.trim()}`);
  }
  const current = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (current.stdout.trim() !== branch) {
    throw new Error(`Release cut must run on '${branch}' (on '${current.stdout.trim()}').`);
  }
}

/**
 * Perform a release cut. Uses real fs writes + the injected exec (git) against
 * `cwd`; tests drive it against a temp-dir git fixture.
 */
export function runReleaseCut(options: ReleaseCutOptions): ReleaseCutResult {
  const exec = options.exec ?? realExec;
  const logger = options.logger ?? consoleLogger;
  const { cwd, config } = options;
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  requireClean(exec, cwd, config.branch);

  const rootManifestPath = resolve(cwd, 'package.json');
  const current = (JSON.parse(readFileSync(rootManifestPath, 'utf8')) as { version: string }).version;
  const version = nextVersion(current, options.bump);
  const tag = `v${version}`;
  logger.info(`[release-cut] ${current} -> ${version} (${options.bump})`);

  if (options.dryRun) {
    logger.info(`[release-cut] dry-run: would bump, changelog, commit, and tag ${tag}`);
    return { version, tag, committed: false };
  }

  setManifestVersion(rootManifestPath, version);
  for (const rel of config.versionFiles) {
    setManifestVersion(resolve(cwd, rel), version);
  }

  for (const cmd of config.syncCommands) {
    const [bin, ...args] = cmd;
    if (!bin) continue;
    const res = exec(bin, args, { cwd });
    if (res.status !== 0) throw new Error(`version-sync command failed: ${cmd.join(' ')}\n${res.stderr}`);
  }

  const changelogPath = resolve(cwd, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const section = buildChangelogSection(version, config.changelogHeading, date, options.notes ?? []);
  writeFileSync(changelogPath, insertChangelogSection(changelog, section, config.changelogInsertMarker));

  const add = exec('git', ['add', ...config.commitPaths], { cwd });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = exec('git', ['commit', '-m', `chore: release ${version}`], { cwd });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  const tagRes = exec('git', ['tag', '-a', tag, '-m', `release ${version}`], { cwd });
  if (tagRes.status !== 0) throw new Error(`git tag failed: ${tagRes.stderr}`);

  logger.info(`[release-cut] committed and tagged ${tag}. Push with: git push && git push origin ${tag}`);
  return { version, tag, committed: true };
}
