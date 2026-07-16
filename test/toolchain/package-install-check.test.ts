import { describe, expect, test } from 'bun:test';
import { evaluateTarballPaths, evaluateBinShim, parseNpmPack, runPackageInstallCheck, captureLogger, type PublishPackageConfig } from '@pellux/goodvibes-toolchain';
import { fakeFs, scriptedExec } from './_helpers.ts';

const config: PublishPackageConfig = {
  packageName: '@pellux/goodvibes-tui',
  defaultRegistry: 'https://registry.npmjs.org',
  requiredTarballPaths: ['package.json', 'README.md', 'bin/goodvibes'],
  forbiddenTarballPrefixes: ['.github/', 'src/test/', 'vendor/'],
  maxTarballBytes: 50 * 1024 * 1024,
};

describe('package-install-check policy', () => {
  test('passes a compliant tarball', () => {
    const r = evaluateTarballPaths(['package.json', 'README.md', 'bin/goodvibes'], 1000, config);
    expect(r.ok).toBe(true);
  });
  test('flags a missing required path', () => {
    const r = evaluateTarballPaths(['package.json', 'README.md'], 1000, config);
    expect(r.missing).toContain('bin/goodvibes');
  });
  test('flags a forbidden path', () => {
    const r = evaluateTarballPaths(['package.json', 'README.md', 'bin/goodvibes', 'vendor/x'], 1000, config);
    expect(r.forbidden).toContain('vendor/x');
  });
  test('flags an oversize tarball', () => {
    const r = evaluateTarballPaths(['package.json', 'README.md', 'bin/goodvibes'], 60 * 1024 * 1024, config);
    expect(r.oversize).toBe(true);
  });
});

describe('bin shim check', () => {
  const fs = fakeFs({ 'bin/goodvibes': '#!/usr/bin/env bun\nconsole.log(1)' }, ['bin/goodvibes']);
  test('passes an executable shim with the right shebang', () => {
    expect(evaluateBinShim(fs, 'bin/goodvibes', 'goodvibes', '#!/usr/bin/env bun').ok).toBe(true);
  });
  test('flags a non-executable shim', () => {
    const noexec = fakeFs({ 'bin/goodvibes': '#!/usr/bin/env bun\n' });
    expect(evaluateBinShim(noexec, 'bin/goodvibes', 'goodvibes', '#!/usr/bin/env bun').ok).toBe(false);
  });
});

describe('parseNpmPack + full run', () => {
  test('parses files and unpacked size', () => {
    const out = JSON.stringify([{ files: [{ path: 'package.json' }, { path: 'bin/goodvibes' }], unpackedSize: 2048 }]);
    expect(parseNpmPack(out)).toEqual({ files: ['package.json', 'bin/goodvibes'], unpackedBytes: 2048 });
  });
  test('run reports issues from a bad tarball', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: JSON.stringify([{ files: [{ path: 'package.json' }, { path: '.github/x' }], unpackedSize: 10 }]) }));
    const result = runPackageInstallCheck({ cwd: '/repo', config, exec, logger: captureLogger() });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('missing') || i.includes('forbidden'))).toBe(true);
  });
});
