import { describe, expect, test } from 'bun:test';
import { getPublishedVersion, runPublishPackage, pollPropagation, captureLogger } from '@pellux/goodvibes-toolchain';
import { scriptedExec } from './_helpers.ts';

describe('publish-package idempotency', () => {
  test('getPublishedVersion returns the version when present', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: '1.10.1\n' }));
    expect(getPublishedVersion(exec, '@pellux/x', '1.10.1', 'https://registry.npmjs.org')).toBe('1.10.1');
  });
  test('getPublishedVersion returns null on a 404-ish error', () => {
    const exec = scriptedExec(() => ({ status: 1, stderr: 'E404' }));
    expect(getPublishedVersion(exec, '@pellux/x', '1.10.1', 'https://registry.npmjs.org')).toBeNull();
  });
  test('skips publish when already published', () => {
    const exec = scriptedExec((_c, args) => (args[0] === 'view' ? { status: 0, stdout: '1.10.1\n' } : { status: 0 }));
    const result = runPublishPackage({ cwd: '/repo', name: '@pellux/x', version: '1.10.1', exec, logger: captureLogger() });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
  test('publishes when not yet on the registry', () => {
    let published = false;
    const exec = scriptedExec((_c, args) => {
      if (args[0] === 'view') return { status: 1 };
      if (args[0] === 'publish') { published = true; return { status: 0 }; }
      return { status: 0 };
    });
    const result = runPublishPackage({ cwd: '/repo', name: '@pellux/x', version: '1.10.1', exec, logger: captureLogger() });
    expect(result.skipped).toBe(false);
    expect(published).toBe(true);
  });
});

describe('publish-package propagation poll', () => {
  test('resolves once the version appears', async () => {
    let calls = 0;
    const exec = scriptedExec(() => (++calls >= 3 ? { status: 0, stdout: '1.10.1\n' } : { status: 1 }));
    const result = await pollPropagation({ name: '@pellux/x', version: '1.10.1', attempts: 5, delayMs: 1, exec, sleep: async () => {}, logger: captureLogger() });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });
  test('gives up after exhausting attempts', async () => {
    const exec = scriptedExec(() => ({ status: 1 }));
    const result = await pollPropagation({ name: '@pellux/x', version: '1.10.1', attempts: 2, delayMs: 1, exec, sleep: async () => {}, logger: captureLogger() });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
  });
});
