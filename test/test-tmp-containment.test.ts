/**
 * The temp-directory containment, driven rather than inspected.
 *
 * Two earlier attempts at this leak were declared fixed after reading the
 * cleanup code, and both were wrong: `process.on('exit')` handlers do not fire
 * under `bun test` (they do under `bun run`, which is why the code reads
 * correctly), so every cleanup registered that way has been dead since it was
 * written and the suite leaked on GREEN runs. Counting directories is what
 * caught it. Every assertion here counts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  RUN_TMP_PREFIX,
  RUNNER_ENV_FLAG,
  isRunTmpDirName,
  runTmpDirPath,
  sweepStaleRunDirs,
  withRunTmpDir,
} from '../scripts/test-tmp-root.ts';

/**
 * Scratch roots this file created, removed after each test.
 *
 * Registered at module top level on purpose. An `afterEach`/`afterAll`
 * registered lazily from inside a helper FUNCTION does not reliably attach
 * under bun's shared module cache, and registering a hook from inside an
 * already-running `beforeEach` does not scope to the current test — that was
 * tried at ~115 call sites and produced ENOENT failures.
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

describe('withRunTmpDir', () => {
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

  test('sibling runs get distinct parents', () => {
    const root = scratchRoot('siblings');
    expect(runTmpDirPath(root, 111)).not.toBe(runTmpDirPath(root, 111));
    expect(basename(runTmpDirPath(root, 111))).toStartWith(RUN_TMP_PREFIX);
  });
});

describe('sweepStaleRunDirs', () => {
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
    const path = aged(root, `${RUN_TMP_PREFIX}999-deadbeef`, 2 * 60 * 60 * 1000);
    expect(sweepStaleRunDirs(root)).toEqual([`${RUN_TMP_PREFIX}999-deadbeef`]);
    expect(existsSync(path)).toBe(false);
  });

  test('leaves a live sibling run alone — the sweep can answer NO on age', () => {
    const root = scratchRoot('fresh');
    const path = aged(root, `${RUN_TMP_PREFIX}1000-cafebabe`, 5_000);
    expect(sweepStaleRunDirs(root)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('never touches a directory it does not own, at any age', () => {
    const root = scratchRoot('foreign');
    const foreign = aged(root, 'someone-elses-cache', 30 * 24 * 60 * 60 * 1000);
    const ours = aged(root, `${RUN_TMP_PREFIX}1-aaaaaaaa`, 30 * 24 * 60 * 60 * 1000);
    expect(sweepStaleRunDirs(root)).toEqual([`${RUN_TMP_PREFIX}1-aaaaaaaa`]);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  test('a missing root is not an error', () => {
    expect(sweepStaleRunDirs(join(tmpdir(), 'tmp-containment-does-not-exist-9f3a'))).toEqual([]);
  });

  test('isRunTmpDirName distinguishes both ways', () => {
    expect(isRunTmpDirName(`${RUN_TMP_PREFIX}12-ab`)).toBe(true);
    expect(isRunTmpDirName('goodvibes-something-else')).toBe(false);
  });
});

describe('end to end, under the real runner', () => {
  /**
   * When this file is executed by `bun run test`, the runner has already
   * redirected TMPDIR into a run parent. This is the assertion that fails if
   * somebody removes the redirection from scripts/test.ts — the unit tests
   * above would all still pass, because they call the helper directly.
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
