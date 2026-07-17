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

describe('publish-package tarball mode', () => {
  test('publishes the tarball path (npm argv carries the .tgz), skipping the pack', () => {
    let publishArgs: readonly string[] | null = null;
    const exec = scriptedExec((_c, args) => {
      if (args[0] === 'view') return { status: 1 }; // not yet published
      if (args[0] === 'publish') { publishArgs = args; return { status: 0 }; }
      return { status: 0 };
    });
    const result = runPublishPackage({
      cwd: '/repo',
      name: '@pellux/agent',
      version: '1.12.3',
      tarballPath: 'release-tarball/agent.tgz',
      fileExists: () => true,
      exec,
      logger: captureLogger(),
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(publishArgs).not.toBeNull();
    expect(publishArgs!).toContain('release-tarball/agent.tgz');
    // npm never packs in tarball mode.
    expect(publishArgs!).not.toContain('pack');
  });

  test('rejects a missing tarball file without publishing', () => {
    let publishCalled = false;
    const exec = scriptedExec((_c, args) => {
      if (args[0] === 'publish') publishCalled = true;
      return { status: 0 };
    });
    const result = runPublishPackage({
      cwd: '/repo',
      name: '@pellux/agent',
      version: '1.12.3',
      tarballPath: 'release-tarball/missing.tgz',
      fileExists: () => false,
      exec,
      logger: captureLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('tarball not found');
    expect(publishCalled).toBe(false);
  });

  test('rejects a non-.tgz tarball path', () => {
    const result = runPublishPackage({
      cwd: '/repo',
      name: '@pellux/agent',
      version: '1.12.3',
      tarballPath: 'release-tarball/agent.zip',
      fileExists: () => true,
      exec: scriptedExec(() => ({ status: 0 })),
      logger: captureLogger(),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('.tgz');
  });

  test('dry-run verifies the tarball exists but does not publish', () => {
    let publishCalled = false;
    const exec = scriptedExec((_c, args) => {
      if (args[0] === 'publish' || args[0] === 'pack') publishCalled = true;
      return { status: 0 };
    });
    const result = runPublishPackage({
      cwd: '/repo',
      name: '@pellux/agent',
      version: '1.12.3',
      tarballPath: 'release-tarball/agent.tgz',
      dryRun: true,
      fileExists: () => true,
      exec,
      logger: captureLogger(),
    });
    expect(result.ok).toBe(true);
    expect(publishCalled).toBe(false);
  });

  test('skips when the tarball version is already published', () => {
    let publishCalled = false;
    const exec = scriptedExec((_c, args) => {
      if (args[0] === 'view') return { status: 0, stdout: '1.12.3\n' };
      if (args[0] === 'publish') { publishCalled = true; return { status: 0 }; }
      return { status: 0 };
    });
    const result = runPublishPackage({
      cwd: '/repo',
      name: '@pellux/agent',
      version: '1.12.3',
      tarballPath: 'release-tarball/agent.tgz',
      fileExists: () => true,
      exec,
      logger: captureLogger(),
    });
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(publishCalled).toBe(false);
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
