/**
 * Coverage-gap smoke test — platform/git
 * Verifies that GitService executes observable behavior when called.
 * Closes coverage gap: platform/git
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { GitService } from '../packages/sdk/src/platform/git/service.js';

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
