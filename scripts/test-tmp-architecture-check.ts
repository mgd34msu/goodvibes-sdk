/**
 * Guards the two properties that keep test/build temp directories from
 * leaking into the real `/tmp` the way they did before scripts/test.ts's
 * TMPDIR redirection existed (see that file's RUN_TMP_DIR_NAME comment for the
 * incident, ~74k leaked directories consumed every tmpfs inode on this
 * project's own host and every subsequent test failed with ENOSPC).
 *
 * This repo's fix is NOT "no test file may call mkdtempSync(tmpdir())", that
 * would fight the ~205 call sites across test/**, which are fine precisely
 * BECAUSE every entry point that runs them redirects `tmpdir()` first. The
 * two things that actually matter, and that a future change could silently
 * break, are:
 *
 *   1. Every `package.json` `scripts` entry (root or any `packages/*`) that
 *      would run the suite goes through that redirect, i.e. none of them
 *      invoke `bun test` directly. `bun run test`, `test:rn`, `test:workers`,
 *      `test:workers:wrangler` all resolve to `bun scripts/test.ts […]`; a
 *      new script that called `bun test` straight would silently reintroduce
 *      the exact failure mode this file is named for.
 *
 *   2. Every standalone script under `scripts/` that calls `tmpdir()` (a
 *      one-shot tool, not a test file, see scripts/verdaccio-dry-run.ts and
 *      scripts/build-whisper-bundle.ts) also calls the shared
 *      `sweepStaleTmpDirs()` helper (scripts/stale-tmp-sweep.ts) somewhere in
 *      the same file, so a copy orphaned by a signal-killed run gets reclaimed
 *      by the next one instead of accumulating forever. This is a static
 *      heuristic, not a guarantee the call is wired up correctly, it exists
 *      to make "I added a new mkdtemp(tmpdir()) call and forgot the sweep"
 *      loud instead of silent.
 *
 * Run as `bun scripts/test-tmp-architecture-check.ts`, wired into
 * `bun run architecture:check` alongside `test-skip:check` in
 * scripts/validate.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures: string[] = [];

// ─── 1. package.json scripts never invoke `bun test` directly ──────────────

/** Matches `bun test` as adjacent words, not `bun run test`, not `bun scripts/test.ts`. */
const DIRECT_BUN_TEST = /\bbun\s+test\b/;

function checkPackageJsonScripts(packageJsonPath: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return; // not JSON, or missing — not this check's concern
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return;
  const rel = relative(repoRoot, packageJsonPath);
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue;
    if (DIRECT_BUN_TEST.test(command)) {
      failures.push(
        `${rel}: scripts.${name} invokes \`bun test\` directly ("${command}"), route it through ` +
          `\`bun scripts/test.ts\` (or an existing wrapper script like \`test:rn\`) so TMPDIR redirection ` +
          `and the stale-run sweep apply. See scripts/test.ts's RUN_TMP_DIR_NAME comment.`,
      );
    }
  }
}

checkPackageJsonScripts(resolve(repoRoot, 'package.json'));
const packagesDir = resolve(repoRoot, 'packages');
try {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    checkPackageJsonScripts(join(packagesDir, entry.name, 'package.json'));
  }
} catch {
  // No packages/ directory, nothing to check.
}

// ─── 2. standalone scripts/*.ts that call tmpdir() also sweep stale dirs ───

/**
 * Files excluded from the "must call sweepStaleTmpDirs()" requirement below:
 * the sweep helper itself and the shared `TEST_TMP_ROOT` constant module (both
 * define the primitives, neither calls one against a fixed prefix, their
 * callers scripts/test.ts and scripts/leak-scan.ts do, and those two are not
 * excluded, so a regression there still fails this check) and this check
 * script itself (its own comments and message strings mention both
 * `tmpdir()` and `sweepStaleTmpDirs(` as plain text, which would otherwise
 * satisfy the heuristic for the wrong reason).
 */
const EXCLUDED_FROM_SWEEP_CHECK = new Set(['stale-tmp-sweep.ts', 'test-run-tmp.ts', 'test-tmp-architecture-check.ts']);

const scriptsDir = resolve(repoRoot, 'scripts');
for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  if (EXCLUDED_FROM_SWEEP_CHECK.has(entry.name)) continue;
  const path = join(scriptsDir, entry.name);
  const source = readFileSync(path, 'utf8');
  if (!/\btmpdir\(\)/.test(source)) continue; // doesn't touch the real system temp dir at all
  if (!/sweepStaleTmpDirs\(/.test(source)) {
    failures.push(
      `scripts/${entry.name}: calls tmpdir() but never calls sweepStaleTmpDirs() (from ` +
        `scripts/stale-tmp-sweep.ts) anywhere in the file, a directory this script creates under ` +
        `the real system temp dir will accumulate forever if the process is ever killed before its ` +
        `own cleanup runs. Sweep your own prefix before creating a new directory, the same way ` +
        `scripts/verdaccio-dry-run.ts and scripts/build-whisper-bundle.ts do.`,
    );
  }
}

// ─── report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`Temp-directory architecture check failed:\n\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}

console.log('test-tmp-architecture-check: OK, no direct `bun test` invocations outside scripts/test.ts, no unswept tmpdir() call sites.');
