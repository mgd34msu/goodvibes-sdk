/**
 * in-process-bundling-guard.test.ts
 *
 * No test file bundles inside the test process.
 *
 * The whole suite runs as ONE `bun test` process across 795 files. A bundler
 * invoked inside it is not a function call that either returns or throws — it
 * is work the test process has to carry, and when it does not settle there is
 * nothing left that can notice. That is not hypothetical: three cases in
 * test/browser-scoped-entrypoints.test.ts called `Bun.build` in-process and
 * awaited it with no ceiling, and CI produced both halves of the failure —
 * one run charged each of the three the runner's full 60 000 ms per-test
 * budget, and an earlier run of the same commit went completely silent for
 * fifteen minutes until the job timeout killed it, leaving bun processes for
 * the runner's orphan sweep. Neither run said what it was waiting for.
 *
 * The shape that is allowed instead is the one that file now uses: spawn the
 * bundler as a child process, bound the wait, and kill the child on every path
 * out — including the timeout and a failed assertion. Then a stuck bundle
 * costs seconds and names itself, and nothing it started can outlive the test.
 *
 * This guard is a source scan because the defect is invisible at runtime on a
 * healthy host: the in-process version passed locally, every time, for as long
 * as it existed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const TEST_ROOT = resolve(import.meta.dir);
const SELF = resolve(import.meta.path);

/** Every `.ts` file under test/, this guard's own source excepted. */
function testSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      testSources(path, found);
      continue;
    }
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
    if (path === SELF) continue;
    found.push(path);
  }
  return found;
}

describe('the test process never runs a bundler inside itself', () => {
  test('no file under test/ calls Bun.build', () => {
    const sources = testSources(TEST_ROOT);
    // The scan is only worth anything if it actually read the suite.
    expect(sources.length).toBeGreaterThan(700);

    const offenders = sources
      .filter((path) => readFileSync(path, 'utf-8').includes('Bun.build('))
      .map((path) => relative(TEST_ROOT, path));

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `these files bundle inside the test process, which can wedge the whole run: ${offenders.join(', ')}. `
          + 'Spawn the bundler as a child process with a ceiling and kill it in a finally — see '
          + 'bundleEntrypoint in test/browser-scoped-entrypoints.test.ts.',
    ).toEqual([]);
  });
});
