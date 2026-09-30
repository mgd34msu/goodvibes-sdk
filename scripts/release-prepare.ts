/**
 * release:prepare, the one command that makes a version bump complete.
 *
 * Every file that is GENERATED from source, or that carries the version, is
 * rewritten here, at the bump, instead of being policed by a red CI run on
 * every push. A stale generated file is fixed by regenerating it; nothing
 * about it is a regression.
 *
 * Usage:
 *   bun run release:prepare --minor            bump 2.1.0 -> 2.2.0, then regenerate
 *   bun run release:prepare --patch | --major
 *   bun run release:prepare --version 2.2.0    bump to an exact version
 *   bun run release:prepare --no-bump          regenerate at the current version
 *   bun run release:prepare --no-bump --no-changelog
 *                                              the toolchain release-cut sync
 *                                              command (release-cut bumps the
 *                                              manifests and writes the
 *                                              changelog section itself)
 *
 * Steps, in dependency order:
 *   1. version strings: root + every workspace package.json, then
 *      packages/sdk/src/platform/version.ts (sync:version)
 *   2. changelog section scaffold for the new version, when none exists
 *   3. build (api-extractor and the bundle budgets read dist/)
 *   4. contract artifacts, foundation-io entries, OpenAPI, webui facade,
 *      Home Assistant client (refresh:contracts)
 *   5. api docs (docs:generate)
 *   6. api-extractor reports + the subpath API surface
 *   7. bundle-budget numbers (bundle-budget.ts --update)
 *   8. eval baseline (eval:baseline)
 *   9. self-check: version:check, and changelog:check unless --no-changelog
 *
 * It never commits, tags or pushes. Review `git status` / `git diff` after it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageDirs, SDK_ROOT } from './release-shared.ts';

type Bump = 'patch' | 'minor' | 'major';

const argv = process.argv.slice(2);

function usage(message: string): never {
  console.error(`[release:prepare] ${message}`);
  console.error('Usage: bun run release:prepare (--patch | --minor | --major | --version X.Y.Z | --no-bump) [--no-changelog]');
  process.exit(2);
}

export function nextVersion(current: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`current version is not X.Y.Z: ${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Rewrites only the top-level "version" field, leaving the rest of the file's bytes alone. */
export function setManifestVersionText(text: string, version: string): string {
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error('no top-level "version" field found');
  }
  return next;
}

/** Inserts `## [version] - date` above the first existing section, unless one exists. */
export function scaffoldChangelogText(changelog: string, version: string, date: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##\\s*\\[${escaped}\\]`, 'm').test(changelog)) return changelog;
  const section = `## [${version}] - ${date}\n\n### Added\n\n### Changed\n\n### Fixed\n\n`;
  const first = changelog.search(/^## /m);
  if (first === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

function run(label: string, command: string, args: readonly string[]): void {
  console.log(`\n[release:prepare] ${label}: ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: SDK_ROOT, stdio: 'inherit' });
}

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

function resolveTarget(current: string): string | null {
  if (argv.includes('--no-bump')) return null;
  const versionIdx = argv.indexOf('--version');
  if (versionIdx !== -1) {
    const exact = argv[versionIdx + 1];
    if (!exact || !/^\d+\.\d+\.\d+$/.test(exact)) usage('--version needs an exact X.Y.Z');
    return exact;
  }
  const bumps = (['patch', 'minor', 'major'] as const).filter((kind) => argv.includes(`--${kind}`));
  if (bumps.length !== 1) usage('choose exactly one of --patch, --minor, --major, --version X.Y.Z, --no-bump');
  return nextVersion(current, bumps[0]!);
}

if (import.meta.main) {
  const rootPath = resolve(SDK_ROOT, 'package.json');
  const current = readVersion(rootPath);
  const target = resolveTarget(current);
  const version = target ?? current;

  if (target !== null) {
    console.log(`[release:prepare] ${current} -> ${target}`);
    for (const path of [rootPath, ...packageDirs.map((dir) => resolve(SDK_ROOT, dir, 'package.json'))]) {
      writeFileSync(path, setManifestVersionText(readFileSync(path, 'utf8'), target));
    }
  } else {
    console.log(`[release:prepare] regenerating at ${version} (no bump)`);
  }
  run('version fallback', 'bun', ['scripts/sync-version-fallback.ts']);

  if (!argv.includes('--no-changelog')) {
    const changelogPath = resolve(SDK_ROOT, 'CHANGELOG.md');
    const before = readFileSync(changelogPath, 'utf8');
    const after = scaffoldChangelogText(before, version, new Date().toISOString().slice(0, 10));
    if (after !== before) {
      writeFileSync(changelogPath, after);
      console.log(`[release:prepare] CHANGELOG.md: scaffolded ## [${version}]; fill in the notes before tagging.`);
    }
  }

  run('build', 'bun', ['run', 'build']);
  run('contracts', 'bun', ['run', 'refresh:contracts']);
  run('api docs', 'bun', ['run', 'docs:generate']);
  run('api-extractor reports', 'bun', ['run', 'api:extract']);
  run('subpath api surface', 'bun', ['scripts/check-subpath-api-surface.ts']);
  run('bundle budgets', 'bun', ['scripts/bundle-budget.ts', '--no-build', '--update']);
  run('eval baseline', 'bun', ['scripts/eval-baseline.ts']);
  run('version consistency', 'bun', ['scripts/version-consistency-check.ts']);
  // Under --no-changelog the caller (toolchain release-cut) writes the section
  // after this command returns, so it cannot exist yet.
  if (!argv.includes('--no-changelog')) run('changelog section', 'bun', ['scripts/check-changelog.ts']);

  console.log(`\n[release:prepare] done at ${version}. Review with: git status && git diff --stat`);
}
