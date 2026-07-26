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
  // npm 12 emits an object keyed by package name. Reading [0] off it yields an
  // empty file list, which reported EVERY required path as missing — a healthy
  // package failing its own install gate. Both shapes must parse identically.
  test('parses the npm 12 object-keyed shape identically to the array shape', () => {
    const out = JSON.stringify({
      '@pellux/goodvibes-tui': { files: [{ path: 'package.json' }, { path: 'bin/goodvibes' }], unpackedSize: 2048 },
    });
    expect(parseNpmPack(out)).toEqual({ files: ['package.json', 'bin/goodvibes'], unpackedBytes: 2048 });
  });
  test('falls back to size when unpackedSize is absent', () => {
    const out = JSON.stringify([{ files: [{ path: 'package.json' }], size: 512 }]);
    expect(parseNpmPack(out)).toEqual({ files: ['package.json'], unpackedBytes: 512 });
  });
  test('throws on a shape carrying no pack result rather than reporting an empty package', () => {
    expect(() => parseNpmPack(JSON.stringify({ warning: 'nothing to pack' }))).toThrow(/unrecognized JSON shape/);
  });
  test('a run against the object-keyed shape passes the same policy the array shape passes', () => {
    const exec = scriptedExec(() => ({
      status: 0,
      stdout: JSON.stringify({
        '@pellux/goodvibes-tui': {
          files: [{ path: 'package.json' }, { path: 'README.md' }, { path: 'bin/goodvibes' }],
          unpackedSize: 10,
        },
      }),
    }));
    const result = runPackageInstallCheck({ cwd: '/repo', config, exec, logger: captureLogger() });
    expect(result.issues.filter((issue) => issue.includes('missing required tarball path'))).toEqual([]);
  });
  test('run reports issues from a bad tarball', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: JSON.stringify([{ files: [{ path: 'package.json' }, { path: '.github/x' }], unpackedSize: 10 }]) }));
    const result = runPackageInstallCheck({ cwd: '/repo', config, exec, logger: captureLogger() });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('missing') || i.includes('forbidden'))).toBe(true);
  });
});
