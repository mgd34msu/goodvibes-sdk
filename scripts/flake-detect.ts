/**
 * flake-detect.ts
 *
 * Flake detection CI gate: runs `bun run test` N times and verifies that all
 * runs produce identical pass/fail results. Fails if any test flips between
 * passing and failing across runs, indicating non-determinism.
 *
 * Usage:
 *   bun run flake:check
 *   bun scripts/flake-detect.ts
 *
 * Configuration (environment variables):
 *   FLAKE_RUNS        — number of test runs (default: 5)
 *   FLAKE_TIMEOUT_MS  — per-run timeout in ms (default: 600000 = 10 min)
 *
 * Note: CI runs this as a separate gate with FLAKE_RUNS=3. Local default is 5.
 * This detects non-determinism only; use `bun test --coverage` to find
 * unexercised subsystems.
 *
 * Exit 0 when all runs agree. Exit 1 with a flake report if any run differs.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── Configuration ──────────────────────────────────────────────────────────

const N = (() => {
  const env = process.env['FLAKE_RUNS'];
  if (env !== undefined) {
    if (!/^\d+$/.test(env.trim())) {
      console.error(`[flake-detect] ERROR: FLAKE_RUNS must be a positive integer, got: ${env}`);
      process.exit(1);
    }
    const n = Number.parseInt(env, 10);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`[flake-detect] ERROR: FLAKE_RUNS must be a positive integer, got: ${env}`);
      process.exit(1);
    }
    return n;
  }
  return 5;
})();

// ─── Types ──────────────────────────────────────────────────────────────────

interface RunResult {
  run: number;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function runTests(runIndex: number): RunResult {
  const start = Date.now();
  const result = spawnSync('bun', ['run', 'test'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Give each run a generous timeout so slow CI machines don't false-positive
    // as flakes. Configurable via FLAKE_TIMEOUT_MS (default: 10 min).
    timeout: (() => {
      const envMs = process.env['FLAKE_TIMEOUT_MS'];
      if (envMs !== undefined) {
        const ms = parseInt(envMs, 10);
        if (!Number.isInteger(ms) || ms < 1000) {
          console.error(`[flake-detect] ERROR: FLAKE_TIMEOUT_MS must be >= 1000, got: ${envMs}`);
          process.exit(1);
        }
        return ms;
      }
      return 10 * 60 * 1000;
    })(),
    maxBuffer: 50 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const exitCode = result.status ?? 1;
  return {
    run: runIndex,
    exitCode,
    passed: exitCode === 0,
    durationMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`\nflake-detect: running test suite ${N} time(s) to detect non-determinism…\n`);

const results: RunResult[] = [];

for (let i = 1; i <= N; i++) {
  process.stdout.write(`  Run ${i}/${N}… `);
  const r = runTests(i);
  results.push(r);
  const status = r.passed ? 'PASS' : 'FAIL';
  console.log(`${status}  (exit ${r.exitCode}, ${formatDuration(r.durationMs)})`);
}

console.log('');

// ─── Analysis ───────────────────────────────────────────────────────────────

const passCount  = results.filter((r) => r.passed).length;
const failCount  = results.filter((r) => !r.passed).length;
const allPass    = failCount === 0;
const allFail    = passCount === 0;
const isFlaky    = !allPass && !allFail;

console.log(`flake-detect: summary`);
console.log(`  Total runs : ${N}`);
console.log(`  Passed     : ${passCount}`);
console.log(`  Failed     : ${failCount}`);
console.log('  Coverage   : run `bun test --coverage` when reviewing untested subsystem inventory');

if (allPass) {
  console.log(`\nflake-detect: OK — all ${N} runs passed. No flakiness detected.`);
  process.exit(0);
}

if (allFail) {
  // Consistently failing — this is a real failure, not a flake.
  console.error(`\nflake-detect: FAIL — all ${N} runs failed consistently.`);
  console.error('This is a deterministic failure, not a flake. Fix the failing tests first.\n');
  // Write full output to flake-output.log for CI artifact upload.
  const r1 = results[0];
  const logLines: string[] = [`flake-detect: deterministic failure — all ${N} runs failed\n`];
  if (r1 && r1.stdout) {
    logLines.push('--- stdout (run 1) ---\n', r1.stdout, '\n');
  }
  if (r1 && r1.stderr) {
    logLines.push('--- stderr (run 1) ---\n', r1.stderr, '\n');
  }
  // flake-output.log lands in repo root (CWD). .gitignore covers *.log so it
  // never leaks to source. ci.yml artifact uploader reads it from this path.
  writeFileSync('flake-output.log', logLines.join(''), 'utf8');
  // Also print last portion to console for inline log visibility.
  if (r1 && r1.stdout) {
    console.error('--- stdout (run 1) ---');
    console.error(r1.stdout.slice(-4000));
  }
  if (r1 && r1.stderr) {
    console.error('--- stderr (run 1) ---');
    console.error(r1.stderr.slice(-2000));
  }
  process.exit(1);
}

// isFlaky
console.error(`\nflake-detect: FLAKE DETECTED — test results were not consistent across ${N} runs.\n`);
console.error('Flaky runs:');
for (const r of results) {
  console.error(`  Run ${r.run}: ${r.passed ? 'PASS' : 'FAIL'}  (exit ${r.exitCode})`);
}

// Print output from the first failing run for diagnosis.
const firstFail = results.find((r) => !r.passed);
if (firstFail) {
  console.error('\n--- stdout (first failing run) ---');
  console.error(firstFail.stdout.slice(-4000));
  if (firstFail.stderr) {
    console.error('--- stderr (first failing run) ---');
    console.error(firstFail.stderr.slice(-2000));
  }
}

console.error(
  '\nNon-deterministic tests must be fixed before merging.\n' +
  'Common causes: shared global state, time-dependent assertions, filesystem races,\n' +
  'random seed without fixed seed, or test ordering assumptions.\n',
);
process.exit(1);
