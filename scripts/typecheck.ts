/**
 * typecheck.ts — the typecheck gate, wrapped so a failure fails.
 *
 * Runs every TypeScript project this repository owns and judges each run by its
 * OUTPUT as well as its exit code. See typecheck-output-rule.ts for why the
 * exit code alone is not evidence.
 *
 * Output is captured rather than piped. `tsc -b 2>&1 | head` — the shape that
 * makes this easy to get wrong by accident — reports `head`'s exit status, so
 * the compiler's verdict is discarded before anyone reads it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { typecheckFailures, type CommandResult } from './typecheck-output-rule.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

interface Project {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

const PROJECTS: readonly Project[] = [
  // The composite solution. tsconfig.json references every package AND
  // tsconfig.tests.json, so this is the run that covers test/ and scripts/ —
  // it did not before, because the root is `files: []` and the tests project
  // was not a reference.
  // `--force` is load-bearing, not belt-and-braces. `tsc -b` skips a project it
  // considers up to date, and up-to-date-ness is decided from input mtimes:
  // reproduced in a scratch solution, editing a source to introduce a TS2322
  // and then restoring its mtime makes `tsc -b` exit 0 AND PRINT NOTHING, while
  // `tsc -p` on the same tree reports the error and exits 1. A restored CI
  // cache, a checkout that preserves mtimes, or a worktree switch all produce
  // that state. `tsc -b --force` reports it and exits 2.
  {
    label: 'tsc -b --force (solution, incl. test/ and scripts/)',
    command: 'bunx',
    args: ['tsc', '-b', '--force', 'tsconfig.json', '--pretty', 'false'],
  },
  // The type-test project is standalone (it uses `paths` remapping and emits
  // nothing), so `tsc -b` does not reach it.
  {
    label: 'tsc -p tsconfig.type-tests.json',
    command: 'node',
    args: ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.type-tests.json', '--pretty', 'false'],
  },
];

const results: CommandResult[] = [];
for (const project of PROJECTS) {
  console.log(`[typecheck] ${project.label} ...`);
  const run = spawnSync(project.command, [...project.args], {
    cwd: SDK_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) {
    console.error(`[typecheck] ${project.label}: could not run — ${run.error.message}`);
    process.exit(1);
  }
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (output.trim().length > 0) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  results.push({ label: project.label, exitCode: run.status, output });
}

const failures = results.flatMap((result) => typecheckFailures(result));
if (failures.length > 0) {
  console.error('');
  console.error('typecheck FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[typecheck] OK — ${results.length} project(s), no diagnostics, all exited 0.`);
