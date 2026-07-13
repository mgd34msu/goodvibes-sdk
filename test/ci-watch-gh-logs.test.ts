/**
 * gh-source fetchFailureLogs seeds REAL failing-job log text — not a pointer.
 *
 * A fake `gh` executable on PATH serves canned API responses: the check-runs
 * listing (whose ids double as Actions job ids) and each job's raw log. The
 * brief must contain the actual failure text, tail-bounded; a per-job log
 * fetch failure degrades to an honest pointer line for that job only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGhCliCiSource } from '../packages/sdk/src/platform/ci-watch/gh-source.ts';

let scratch: string;
let originalPath: string;

const FAKE_GH = `#!/bin/sh
case "$*" in
  *pulls/7*)
    echo "abc123"
    ;;
  *check-runs*)
    echo '[{"id":111,"name":"build","status":"completed","conclusion":"failure","html_url":"u1"},{"id":999,"name":"broken-log","status":"completed","conclusion":"failure"},{"id":222,"name":"lint","status":"completed","conclusion":"success"}]'
    ;;
  *actions/jobs/111/logs*)
    echo "setup ok"
    echo "running build"
    echo "ERROR: build exploded at src/main.ts:42"
    ;;
  *actions/jobs/888/logs*)
    i=0
    while [ $i -lt 2500 ]; do
      echo "log line $i"
      i=$((i+1))
    done
    ;;
  *actions/jobs/*)
    echo "no log for you" >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const ghPath = join(scratch, 'gh');
  writeFileSync(ghPath, FAKE_GH);
  chmodSync(ghPath, 0o755);
  originalPath = process.env.PATH ?? '';
  process.env.PATH = `${scratch}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(scratch, { recursive: true, force: true });
});

describe('gh-source failing-job logs', () => {
  test('the brief contains the ACTUAL failing log text, per failing job', async () => {
    const source = createGhCliCiSource();
    const brief = await source.fetchFailureLogs!({ repo: 'o/r', prNumber: 7, jobNames: ['build'] });
    expect(brief).toContain('CI failed for o/r (PR #7).');
    expect(brief).toContain('Failing jobs: build.');
    expect(brief).toContain('--- build (log tail) ---');
    expect(brief).toContain('ERROR: build exploded at src/main.ts:42');
  });

  test('a per-job log fetch failure degrades to an honest pointer line for that job only', async () => {
    const source = createGhCliCiSource();
    const brief = await source.fetchFailureLogs!({ repo: 'o/r', prNumber: 7, jobNames: ['build', 'broken-log'] });
    // The healthy job's real log is still seeded...
    expect(brief).toContain('ERROR: build exploded at src/main.ts:42');
    // ...while the broken one reports its fetch failure with the expansion pointer.
    expect(brief).toContain('broken-log: log fetch failed');
    expect(brief).toContain('gh run view --log-failed');
  });

  test('an oversized log is tail-bounded on a line boundary, keeping the end (where the failure lives)', async () => {
    const scratch2 = mkdtempSync(join(tmpdir(), 'fake-gh2-'));
    try {
      // A second fake gh whose check-run id maps to the huge log.
      const ghPath = join(scratch2, 'gh');
      writeFileSync(ghPath, FAKE_GH.replace('"id":111', '"id":888'));
      chmodSync(ghPath, 0o755);
      const saved = process.env.PATH ?? '';
      process.env.PATH = `${scratch2}:${saved}`;
      try {
        const source = createGhCliCiSource();
        const brief = await source.fetchFailureLogs!({ repo: 'o/r', prNumber: 7, jobNames: ['build'] });
        expect(brief).toContain('truncated to the last');
        expect(brief).toContain('log line 2499');
        expect(brief).not.toContain('log line 0\n');
        // Bounded: the whole brief stays well under the raw ~30KB log.
        expect(brief.length).toBeLessThan(20_000);
      } finally {
        process.env.PATH = saved;
      }
    } finally {
      rmSync(scratch2, { recursive: true, force: true });
    }
  });
});
