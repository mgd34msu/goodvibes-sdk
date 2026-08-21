/**
 * The typecheck gate's own failure paths.
 *
 * "tsc is clean" was cited as proof five times in one night while being wrong
 * in two independent ways: the root config never compiled `test/` at all, and a
 * `tsc --build` was seen printing more than twenty TS2307 diagnostics and still
 * exiting 0. Every assertion below drives a rejection AND its matching
 * acceptance, because a detector that only ever ran against input it accepts
 * reports "clean" forever.
 */
import { describe, expect, test } from 'bun:test';

import { readCompilerOutput, typecheckFailures } from '../scripts/typecheck-output-rule.ts';

const CLEAN_OUTPUT = [
  '[typecheck] tsc -b ...',
  'TSFILE: /repo/packages/sdk/dist/index.d.ts',
  'Found 0 errors.',
  '',
].join('\n');

const DIRTY_OUTPUT = [
  "packages/sdk/src/a.ts(1,23): error TS2307: Cannot find module 'dep' or its corresponding type declarations.",
  "packages/sdk/src/b.ts(4,9): error TS2741: Property 'x' is missing in type '{}'.",
  'Found 2 errors in 2 files.',
  '',
].join('\n');

describe('readCompilerOutput', () => {
  test('finds nothing in clean output — it can answer NO', () => {
    const verdict = readCompilerOutput(CLEAN_OUTPUT);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.reportedErrorCount).toBe(0);
  });

  test('finds every diagnostic line in dirty output', () => {
    const verdict = readCompilerOutput(DIRTY_OUTPUT);
    expect(verdict.diagnostics).toHaveLength(2);
    expect(verdict.diagnostics[0]).toContain('TS2307');
    expect(verdict.reportedErrorCount).toBe(2);
  });

  test('a bare `error TS…` with no file prefix still counts', () => {
    expect(readCompilerOutput('error TS6053: File not found.').diagnostics).toHaveLength(1);
  });

  test('does NOT fire on prose that merely mentions an error code', () => {
    // This is the over-broad direction. A gate that fires on every line
    // containing "TS" or "error" gets switched off, which fails the same way a
    // blind gate does. api-extractor.json is full of lines like the first one.
    const benign = [
      '// TS2307: Cannot find module, suppressed for optional peer deps.',
      '"TS2307": { "logLevel": "none" },',
      'error handling is described in docs/errors.md',
      'Found 0 errors.',
    ].join('\n');
    const verdict = readCompilerOutput(benign);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.reportedErrorCount).toBe(0);
  });

  test('output with no tally line at all reports null, not zero', () => {
    expect(readCompilerOutput('nothing to do').reportedErrorCount).toBeNull();
  });
});

describe('typecheckFailures', () => {
  test('exit 0 with clean output passes', () => {
    expect(typecheckFailures({ label: 'tsc', exitCode: 0, output: CLEAN_OUTPUT })).toEqual([]);
  });

  test('THE INCIDENT: exit 0 with diagnostics still fails', () => {
    const failures = typecheckFailures({ label: 'tsc', exitCode: 0, output: DIRTY_OUTPUT });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('the exit code was not evidence');
  });

  test('a non-zero exit fails even when nothing was printed', () => {
    const failures = typecheckFailures({ label: 'tsc', exitCode: 2, output: '' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('exited 2');
  });

  test('death by signal fails', () => {
    expect(typecheckFailures({ label: 'tsc', exitCode: null, output: '' })).toHaveLength(1);
  });

  test('a non-zero tally with no diagnostic lines still fails', () => {
    const failures = typecheckFailures({ label: 'tsc', exitCode: 0, output: 'Found 3 errors in 2 files.\n' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Found 3 errors');
  });

  test('both signals at once are reported once each, not doubled', () => {
    const failures = typecheckFailures({ label: 'tsc', exitCode: 2, output: DIRTY_OUTPUT });
    expect(failures).toHaveLength(2);
  });
});
