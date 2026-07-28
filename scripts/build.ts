/**
 * build.ts — rebuild every workspace package's dist.
 *
 * ## Why the output tree is never deleted up front
 *
 * This used to `rm -rf` every `packages/*` dist directory before running tsc.
 * The intent was only to drop ORPHANS — outputs left behind by a source file
 * that has since been renamed or deleted — but the cost was a window, minutes
 * long on a cold build, in which the SDK's compiled output did not exist.
 *
 * That window is not private to this repository. A consumer checkout dev-linked
 * to this one (goodvibes-tui does exactly that) resolves every
 * `@pellux/goodvibes-*` import through this tree, so for the length of a
 * rebuild it could resolve NONE of them. Whole test files died at import with
 * "Cannot find module", and typechecks failed on imports that were perfectly
 * correct — always transiently, always passing on a lone re-run, which is the
 * hardest possible failure to attribute. It was seen live: an SDK build running
 * in one terminal turned a consumer's typecheck red in another.
 *
 * So the tree stays in place. `tsc -b --force` rewrites every output it owns,
 * so a file is only ever replaced, never briefly absent. Orphans are then
 * removed in one sub-second pass, using the emitted-file list tsc itself
 * reports — not a heuristic about timestamps, and not a guess.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const PACKAGES_ROOT = resolve(SDK_ROOT, 'packages');

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    cwd: SDK_ROOT,
    stdio: 'inherit',
  });
}

/**
 * Run tsc and return every file it emitted, absolute.
 *
 * `--listEmittedFiles` prints one `TSFILE: <path>` line per output. Captured
 * rather than inherited so the list can be read; the lines are echoed on so a
 * build still looks the same to whoever is watching it.
 */
function buildAndListEmitted(): Set<string> {
  // tsconfig.build.json, not the root solution: the root also references
  // tsconfig.tests.json, which emits nothing and whose diagnostics belong to
  // `bun run typecheck`. A red test tree must not stop the packages building.
  const stdout = execFileSync('bunx', ['tsc', '-b', '--force', 'tsconfig.build.json', '--listEmittedFiles'], {
    cwd: SDK_ROOT,
    encoding: 'utf8',
    // Errors still go straight to the terminal; only stdout is captured.
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const emitted = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('TSFILE:')) {
      emitted.add(resolve(SDK_ROOT, trimmed.slice('TSFILE:'.length).trim()));
      continue;
    }
    if (trimmed.length > 0) console.log(trimmed);
  }
  return emitted;
}

/** Every file currently under a package's dist, absolute. */
function distFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no dist yet — a first build
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    walk(resolve(PACKAGES_ROOT, entry.name, 'dist'));
  }
  return found;
}

/**
 * Delete outputs tsc did not just emit.
 *
 * This is what the up-front wipe was actually for. Doing it AFTER the build,
 * against tsc's own list, removes exactly the same files without ever leaving
 * the tree incomplete. A build that emitted nothing is treated as a signal to
 * prune nothing, because that means the list could not be read and deleting on
 * an empty list would delete everything.
 */
function pruneOrphanedDistFiles(emitted: ReadonlySet<string>): void {
  if (emitted.size === 0) {
    console.log('build: tsc reported no emitted files — skipping the orphan sweep');
    return;
  }
  let removed = 0;
  for (const file of distFiles()) {
    if (emitted.has(file)) continue;
    // Only files tsc itself produces are orphan candidates. Everything else in
    // dist belongs to a later step — prepare:sdk writes the contract artifacts
    // there — and deleting those just to have them rewritten seconds later
    // reintroduces, in miniature, the very gap this rewrite removed.
    if (!TSC_OUTPUT_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    // Nor anything written since this build started, for the same reason.
    try {
      if (statSync(file).mtimeMs > buildStartedAt) continue;
    } catch {
      continue;
    }
    rmSync(file, { force: true });
    removed += 1;
    console.log(`build: pruned orphaned output ${relative(SDK_ROOT, file)}`);
  }
  if (removed === 0) console.log('build: no orphaned outputs to prune');
}

/** What `tsc` emits, and therefore the only thing the orphan sweep may delete. */
const TSC_OUTPUT_SUFFIXES = ['.js', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts', '.js.map', '.d.ts.map'];

let buildStartedAt = 0;

await withWorkspaceLock('build', () => {
  run('bun', ['run', 'sync:version']);
  buildStartedAt = Date.now();
  const emitted = buildAndListEmitted();
  pruneOrphanedDistFiles(emitted);
  run('bun', ['run', 'prepare:sdk']);
});
