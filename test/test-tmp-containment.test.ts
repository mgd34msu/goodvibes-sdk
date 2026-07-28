/**
 * The temp-directory containment, driven rather than inspected.
 *
 * Two earlier attempts at this leak were declared fixed after reading the
 * cleanup code, and both were wrong: `process.on('exit')` handlers do not fire
 * under `bun test` (they do under `bun run`, which is why the code reads
 * correctly), so every cleanup registered that way has been dead since it was
 * written and the suite leaked on GREEN runs. Counting directories is what
 * caught it. Every assertion here counts.
 *
 * Targets this repo's containment — `scripts/test-run-tmp.ts` (the run
 * parent's lifecycle and the env redirect) plus `scripts/stale-tmp-sweep.ts`
 * (reclaiming what a signal-killed run could not remove). Those two modules
 * are what `scripts/test.ts`, `scripts/leak-scan.ts`,
 * `scripts/build-whisper-bundle.ts`, `scripts/verdaccio-dry-run.ts` and
 * `scripts/test-tmp-architecture-check.ts` all build on, so asserting them
 * asserts the code that actually runs rather than a re-implementation of it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { sweepStaleTmpDirs } from '../scripts/stale-tmp-sweep.ts';
import {
  makeRunTmpDirName,
  RUN_TMP_PREFIX,
  RUNNER_ENV_FLAG,
  STALE_RUN_MS,
  testTmpEnv,
  withRunTmpDir,
} from '../scripts/test-run-tmp.ts';

/**
 * Scratch roots this file created, removed after each test.
 *
 * Registered at module top level on purpose. An `afterEach`/`afterAll`
 * registered lazily from inside a helper FUNCTION does not reliably attach
 * under bun's shared module cache, and registering a hook from inside an
 * already-running `beforeEach` does not scope to the current test.
 */
const scratchRoots: string[] = [];

afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `tmp-containment-${label}-`));
  scratchRoots.push(root);
  return root;
}

describe('withRunTmpDir — the lifecycle scripts/test.ts and scripts/leak-scan.ts run', () => {
  test('a run that leaks directories leaves none behind', async () => {
    const root = scratchRoot('green');
    let leakedInside = 0;
    await withRunTmpDir(root, (runTmpDir) => {
      // Exactly what the suite does, and never cleans up.
      for (let i = 0; i < 5; i += 1) mkdtempSync(join(runTmpDir, 'leaky-'));
      leakedInside = readdirSync(runTmpDir).length;
    });
    expect(leakedInside).toBe(5);
    expect(readdirSync(root)).toEqual([]);
  });

  test('a run that THROWS also leaves none behind', async () => {
    const root = scratchRoot('red');
    await expect(
      withRunTmpDir(root, (runTmpDir) => {
        mkdtempSync(join(runTmpDir, 'leaky-'));
        throw new Error('suite failed');
      }),
    ).rejects.toThrow('suite failed');
    expect(readdirSync(root)).toEqual([]);
  });

  test('the run parent exists while the callback runs — the check is not vacuous', async () => {
    const root = scratchRoot('exists');
    let seen: string | null = null;
    await withRunTmpDir(root, (runTmpDir) => {
      seen = runTmpDir;
      expect(existsSync(runTmpDir)).toBe(true);
      expect(readdirSync(root)).toHaveLength(1);
    });
    expect(seen).not.toBeNull();
    expect(existsSync(seen as unknown as string)).toBe(false);
  });

  test('the parent is named so the sweep can recognise it as ours', async () => {
    const root = scratchRoot('named');
    let seen = '';
    await withRunTmpDir(root, (runTmpDir) => {
      seen = basename(runTmpDir);
    });
    expect(seen).toStartWith(RUN_TMP_PREFIX);
  });

  test('sibling runs get distinct parents', () => {
    // Each entry point derives one name per process; two of them must never
    // collide, or two concurrent runs share a temp tree and each removes the
    // other's out from under it.
    expect(makeRunTmpDirName()).not.toBe(makeRunTmpDirName());
    expect(makeRunTmpDirName()).toStartWith(RUN_TMP_PREFIX);
  });
});

describe('testTmpEnv — the redirect itself', () => {
  test('points all three temp variables at the run parent', () => {
    expect(testTmpEnv('/run/parent')).toEqual({ TMPDIR: '/run/parent', TMP: '/run/parent', TEMP: '/run/parent' });
  });

  test('does NOT carry the runner flag — it must survive the redirect being deleted', () => {
    // If the flag travelled inside this object, deleting the
    // `...testTmpEnv(runTmpDir)` spread from a runner would delete the flag
    // with it, and the end-to-end assertion below would take its "raw bun
    // test" branch and pass on exactly the change it exists to catch.
    expect(Object.keys(testTmpEnv('/run/parent'))).not.toContain(RUNNER_ENV_FLAG);
  });
});

describe('sweepStaleTmpDirs', () => {
  function aged(root: string, name: string, ageMs: number): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'marker'), 'x');
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
    return path;
  }

  test('reclaims an abandoned run parent', () => {
    const root = scratchRoot('stale');
    const path = aged(root, `${RUN_TMP_PREFIX}999-deadbeef`, 2 * STALE_RUN_MS);
    sweepStaleTmpDirs(root, RUN_TMP_PREFIX, STALE_RUN_MS);
    expect(existsSync(path)).toBe(false);
  });

  test('leaves a live sibling run alone — the sweep can answer NO on age', () => {
    const root = scratchRoot('fresh');
    const path = aged(root, `${RUN_TMP_PREFIX}1000-cafebabe`, 5_000);
    sweepStaleTmpDirs(root, RUN_TMP_PREFIX, STALE_RUN_MS);
    expect(existsSync(path)).toBe(true);
  });

  test('never touches a directory it does not own, at any age', () => {
    const root = scratchRoot('foreign');
    const foreign = aged(root, 'someone-elses-cache', 30 * 24 * 60 * 60 * 1000);
    const ours = aged(root, `${RUN_TMP_PREFIX}1-aaaaaaaa`, 30 * 24 * 60 * 60 * 1000);
    sweepStaleTmpDirs(root, RUN_TMP_PREFIX, STALE_RUN_MS);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  test('a missing root is not an error', () => {
    const missing = join(tmpdir(), 'tmp-containment-does-not-exist-9f3a');
    expect(existsSync(missing)).toBe(false);
    expect(() => sweepStaleTmpDirs(missing, RUN_TMP_PREFIX, STALE_RUN_MS)).not.toThrow();
  });
});

describe('end to end, under the real runner', () => {
  /**
   * When this file is executed by `bun run test` (or `scripts/leak-scan.ts`),
   * the runner has already redirected TMPDIR into a run parent. This is the
   * assertion that fails if somebody removes the redirection from either entry
   * point — the unit tests above would all still pass, because they call the
   * helper directly with a scratch root of their own.
   *
   * Under a raw `bun test` the flag is absent and there is nothing to assert;
   * the flag is what tells "no containment, none expected" apart from
   * "containment removed".
   */
  test('this process writes its temp directories into a run parent', () => {
    const underRunner = process.env[RUNNER_ENV_FLAG] === '1';
    if (!underRunner) {
      // A raw `bun test` sets neither the flag nor TMPDIR, and claims no
      // containment. Asserting the flag is genuinely absent keeps this branch
      // from being reached by a runner that kept the flag and dropped TMPDIR.
      expect(process.env[RUNNER_ENV_FLAG]).toBeUndefined();
      return;
    }
    expect(basename(tmpdir())).toStartWith(RUN_TMP_PREFIX);
    const created = mkdtempSync(join(tmpdir(), 'containment-probe-'));
    try {
      expect(created.startsWith(tmpdir())).toBe(true);
    } finally {
      rmSync(created, { recursive: true, force: true });
    }
  });
});
