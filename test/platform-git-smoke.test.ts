/**
 * Coverage-gap smoke test — platform/git
 * Verifies that GitService executes observable behavior when called.
 * Closes coverage gap: platform/git
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { GitService, conflictPathsFromMergeOutput } from '../packages/sdk/src/platform/git/service.js';

const CWD = resolve(import.meta.dir, '..');

describe('platform/git — behavior smoke', () => {
  test('GitService.isGitRepo returns true for the SDK repo', async () => {
    const result = await GitService.isGitRepo(CWD);
    expect(result).toBe(true);
  });

  test('new GitService(CWD).getCwd() returns the working directory', () => {
    const svc = new GitService(CWD);
    expect(svc.getCwd()).toBe(CWD);
  });

  test('GitService.getRepoRoot returns a non-empty string for the SDK repo', async () => {
    const root = await GitService.getRepoRoot(CWD);
    expect(typeof root).toBe('string');
    expect((root as string).length).toBeGreaterThan(0);
  });
});

// The conflicted-file list is structured data a resolution session seeds from,
// so every entry must be a BARE repo-relative path on every git version. The
// raw merge-failure message has two real shapes depending on the
// git/simple-git output pairing; both are pinned here as recorded fixtures so
// the parse never depends on the host's git version.
describe('platform/git — merge-conflict path extraction (both raw output shapes)', () => {
  test("git's own informational lines: `CONFLICT (content): Merge conflict in <path>`", () => {
    const raw = [
      'Auto-merging shared.txt',
      'CONFLICT (content): Merge conflict in shared.txt',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(conflictPathsFromMergeOutput(raw)).toEqual(['shared.txt']);
  });

  test("git library merge-summary rendering: `CONFLICTS: <path>:<reason>` loses the reason suffix", () => {
    // Recorded from a CI runner where the merge rejection stringifies the
    // parsed summary: each entry is the conflict's `file:reason` pair. The
    // reason suffix must never leak into the path list.
    expect(conflictPathsFromMergeOutput('CONFLICTS: shared.txt:content')).toEqual(['shared.txt']);
  });

  test('merge-summary rendering with several conflicts and compound reasons', () => {
    expect(conflictPathsFromMergeOutput('CONFLICTS: src/a.ts:content, docs/b.md:add/add, c.txt:modify/delete'))
      .toEqual(['src/a.ts', 'docs/b.md', 'c.txt']);
  });

  test('multiple informational CONFLICT lines each yield their bare path', () => {
    const raw = [
      'Auto-merging src/a.ts',
      'CONFLICT (content): Merge conflict in src/a.ts',
      'Auto-merging docs/b.md',
      'CONFLICT (content): Merge conflict in docs/b.md',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(conflictPathsFromMergeOutput(raw)).toEqual(['src/a.ts', 'docs/b.md']);
  });

  test('a message with no conflict lines yields an empty list', () => {
    expect(conflictPathsFromMergeOutput('fatal: not something we handle')).toEqual([]);
  });
});
