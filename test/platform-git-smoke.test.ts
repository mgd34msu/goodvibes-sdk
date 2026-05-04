/**
 * Coverage-gap smoke test — platform/git
 * Verifies that GitService loads and exposes the expected API surface.
 * Closes coverage gap: platform/git (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { GitService } from '../packages/sdk/src/platform/git/service.js';

describe('platform/git — module load smoke', () => {
  test('GitService is a constructor', () => {
    expect(typeof GitService).toBe('function');
  });

  test('GitService prototype has expected instance methods', () => {
    const proto = GitService.prototype;
    expect(typeof proto.status).toBe('function');
    expect(typeof proto.branch).toBe('function');
    expect(typeof proto.commit).toBe('function');
    expect(typeof proto.getCwd).toBe('function');
    expect(typeof proto.dispose).toBe('function');
  });

  test('GitService has expected static methods', () => {
    expect(typeof GitService.isGitRepo).toBe('function');
    expect(typeof GitService.getRepoRoot).toBe('function');
    expect(typeof GitService.initRepo).toBe('function');
  });
});
