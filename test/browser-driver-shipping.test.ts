import { afterAll, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractTarGzEntry,
  extractTarGzTree,
  readTarGzEntries,
} from '../packages/sdk/src/platform/browser/browser-driver-archive.js';
import {
  driverRemediation,
  shippedDriverPath,
} from '../packages/sdk/src/platform/browser/browser-driver-remediation.js';
import type {
  BrowserDriverInstallKind,
  BrowserDriverInstallProfile,
} from '../packages/sdk/src/platform/browser/browser-driver-remediation.js';
import {
  DRIVER_REQUIRED_FILES,
  driverSearchDirectories,
  findDriverDirectory,
  managedDriverRoot,
} from '../packages/sdk/src/platform/browser/browser-provision-io.js';
import {
  describeProvisionWork,
  ensureBrowserBinary,
  installRuntimeCandidates,
  installRuntimeCandidatesFor,
} from '../packages/sdk/src/platform/browser/browser-provisioning.js';
import type {
  BrowserProvisionIo,
  CommandOutcome,
} from '../packages/sdk/src/platform/browser/browser-types.js';

/**
 * The browser-driver failure that shipped once, pinned so it cannot ship again.
 *
 * Three independent defects had to line up to produce it, and each is covered
 * here separately because fixing any one of them alone leaves the capability
 * broken:
 *
 *   1. the driver never reached the release asset, so a downloaded binary had
 *      none beside it;
 *   2. resolution accepted an incomplete driver directory, so a partial copy
 *      shadowed a good one and self-provisioning could never take effect;
 *   3. the remediation told a binary user to install the npm package.
 *
 * The half of that story that is about ONE product's release assets, its
 * archive manifest, its capability probe, its install-kind detector, stays
 * with that product, because the SDK ships no release and has no installer.
 * What is here is the platform half: the archive reader, the resolver, the
 * install-runtime candidates, self-provisioning, and the SHAPE of a remediation
 * message against a product-supplied install profile.
 */

/** The driver directory name the resolver looks for beside an executable. */
const DRIVER_DIR_NAME = 'playwright-core';

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Builds a ustar tar.gz in memory, so no test shells out to `tar`. */
function buildTarGz(entries: readonly { path: string; data?: string; mode?: number; directory?: boolean }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(entry.data ?? '', 'utf-8');
    header.write(entry.path.slice(0, 100), 0, 'utf-8');
    header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 'utf-8');
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write((entry.directory === true ? 0 : body.length).toString(8).padStart(11, '0') + '\0', 124, 'utf-8');
    header.write('00000000000\0', 136);
    header.write(entry.directory === true ? '5' : '0', 156, 'utf-8');
    header.write('ustar\0', 257, 'utf-8');
    header.write('00', 263, 'utf-8');
    // Checksum: sum of all header bytes with the checksum field read as spaces.
    header.write('        ', 148, 8, 'utf-8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf-8');
    blocks.push(header);
    if (entry.directory !== true && body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(gzipSync(Buffer.concat(blocks)));
}

function driverArchive(): Buffer {
  return buildTarGz([
    { path: `${DRIVER_DIR_NAME}/`, directory: true },
    { path: `${DRIVER_DIR_NAME}/package.json`, data: JSON.stringify({ name: 'playwright-core', version: '1.62.0' }) },
    { path: `${DRIVER_DIR_NAME}/index.js`, data: 'module.exports = {};\n' },
    { path: `${DRIVER_DIR_NAME}/cli.js`, data: '#!/usr/bin/env node\n', mode: 0o755 },
    { path: `${DRIVER_DIR_NAME}/lib/xdg-open`, data: '#!/bin/sh\n', mode: 0o755 },
  ]);
}

describe('the driver archive provisioning downloads', () => {
  test('carries every file the resolver refuses to accept a driver without', () => {
    const archive = driverArchive();
    for (const required of DRIVER_REQUIRED_FILES) {
      expect(extractTarGzEntry(archive, `${DRIVER_DIR_NAME}/${required}`), `${required} must be in the archive`).not.toBeNull();
    }
  });

  test('extracts to the exact directory the runtime searches, with the executable bit preserved', () => {
    const installDir = scratch('gv-extract');
    extractTarGzTree(driverArchive(), join(installDir, DRIVER_DIR_NAME), {});

    const driverDir = join(installDir, DRIVER_DIR_NAME, DRIVER_DIR_NAME);
    // stripComponents defaults to 0, so the archive's own prefix is kept here;
    // the download path strips it. Assert the payload.
    expect(existsSync(join(driverDir, 'cli.js'))).toBe(true);
    // cli.js is executed to install a browser; a non-executable copy is useless.
    expect(statSync(join(driverDir, 'cli.js')).mode & 0o111).not.toBe(0);
    expect(statSync(join(driverDir, 'package.json')).mode & 0o111).toBe(0);
  });

  test('stripComponents lands the driver directly where the binary looks for it', () => {
    const installDir = scratch('gv-strip');
    const target = join(installDir, DRIVER_DIR_NAME);
    extractTarGzTree(driverArchive(), target, { stripComponents: 1 });

    expect(existsSync(join(target, 'cli.js'))).toBe(true);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    // And the FIRST place the runtime looks is that same directory name beside
    // the running executable, which is what a release asset, an installer, and
    // an update swap all extract into.
    expect(driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: installDir })[0])
      .toBe(join(dirname(process.execPath), DRIVER_DIR_NAME));
  });

  test('an archive entry that would escape the destination is refused, not sanitised', () => {
    const hostile = buildTarGz([{ path: '../escaped.js', data: 'nope' }]);
    const target = scratch('gv-escape');
    expect(() => extractTarGzTree(hostile, join(target, 'inner'), {})).toThrow(/escapes the destination/);
    expect(existsSync(join(target, 'escaped.js'))).toBe(false);
  });

  test('an absolute archive entry is refused', () => {
    const hostile = buildTarGz([{ path: '/etc/goodvibes-escape', data: 'nope' }]);
    expect(() => extractTarGzTree(hostile, scratch('gv-abs'), {})).toThrow(/absolute path/);
  });

  test('a corrupt archive fails loudly rather than reading as empty', () => {
    expect(() => [...readTarGzEntries(Buffer.from('not a gzip stream'))]).toThrow();
  });
});

describe('resolving a driver that is not an installed module', () => {
  test('a partial driver beside the binary does not shadow a good one elsewhere', () => {
    // The search stops at the first match, so an incomplete candidate that
    // still counted as a driver made the good one unreachable, and no amount
    // of self-provisioning could recover, because the broken one kept winning.
    const installDir = scratch('gv-shadow');
    const partial = join(installDir, 'partial', DRIVER_DIR_NAME);
    const complete = join(installDir, 'complete', DRIVER_DIR_NAME);
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'package.json'), '{"name":"playwright-core"}');
    writeFileSync(join(partial, 'index.js'), 'module.exports = {};');
    extractTarGzTree(driverArchive(), complete, { stripComponents: 1 });

    const resolved = findDriverDirectory(undefined, [partial, complete]);
    expect(resolved).toBe(complete);
  });

  test('a directory holding only a manifest is not a driver', () => {
    const half = join(scratch('gv-half'), DRIVER_DIR_NAME);
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, 'package.json'), '{"name":"playwright-core"}');

    expect(findDriverDirectory(undefined, [half])).toBeNull();
  });

  test('the beside-the-executable candidates do not depend on knowing a surface', () => {
    // Only the managed driver directory is surface-scoped. A caller with no
    // surface, a probe, a diagnostic, must still see the driver staged next
    // to the binary, or browser control reads as absent in exactly the shipped
    // artifact the search exists for.
    const withoutSurface = driverSearchDirectories();
    expect(withoutSurface[0]).toBe(join(dirname(process.execPath), DRIVER_DIR_NAME));
    expect(withoutSurface).toContain(join(dirname(process.execPath), 'vendor', DRIVER_DIR_NAME));
    expect(withoutSurface).toContain(join(dirname(process.execPath), 'node_modules', DRIVER_DIR_NAME));
    // And nothing surface-scoped leaks in when no surface was named.
    expect(withoutSurface.some((path) => path.includes(join('.goodvibes')))).toBe(false);
  });

  test('a driver missing its CLI is rejected, because cli.js is what installs a browser', () => {
    const noCli = join(scratch('gv-nocli'), DRIVER_DIR_NAME);
    mkdirSync(noCli, { recursive: true });
    writeFileSync(join(noCli, 'package.json'), '{"name":"playwright-core","version":"1.62.0"}');
    writeFileSync(join(noCli, 'index.js'), 'module.exports = {};');

    expect(findDriverDirectory(undefined, [noCli])).toBeNull();
    // And the rule is published, so a product's own capability probe can declare
    // exactly what the resolver enforces instead of a weaker rule that drifts.
    expect(DRIVER_REQUIRED_FILES).toEqual(['package.json', 'index.js', 'cli.js']);
  });
});

describe('the browser install step on a machine with no interpreter', () => {
  test('the running executable is always a candidate, so an install never needs bun or node on PATH', () => {
    const candidates = installRuntimeCandidates();
    expect(candidates[0]?.command).toBe(process.execPath);
    // Under `bun test` the running executable IS an interpreter, so it needs no
    // marker; a compiled binary needs BUN_BE_BUN to act as one. Either way the
    // artifact's own executable is tried before anything on PATH.
    expect(candidates.map((candidate) => candidate.command)).toContain('bun');
    expect(candidates.map((candidate) => candidate.command)).toContain('node');
  });

  test('a compiled binary runs the install CLI through its own embedded runtime', () => {
    // Pinned as a value rather than only observed at runtime: a compiled binary
    // has no `bun` and no `node` beside it, and without this the managed browser
    // download is unreachable on a binary-only machine.
    const compiled = installRuntimeCandidatesFor('/home/someone/.local/bin/some-product');
    expect(compiled[0]).toEqual({ command: '/home/someone/.local/bin/some-product', env: { BUN_BE_BUN: '1' } });

    const interpreter = installRuntimeCandidatesFor('/usr/local/bin/bun');
    expect(interpreter[0]).toEqual({ command: '/usr/local/bin/bun', env: {} });
  });

  test('a missing interpreter is recognized as missing, and the next candidate is tried', async () => {
    // Bun reports a missing program as `Executable not found in $PATH: "bun"`,
    // never as ENOENT. Matching ENOENT alone stopped the loop on the first
    // candidate and reported "install exited with code null", which names
    // nothing the owner can act on.
    const tried: string[] = [];
    const io = stubIo({
      resolveDriver: () => ({
        available: true,
        packageDirectory: '/drv',
        cliPath: '/drv/cli.js',
        version: '1.62.0',
        error: null,
      }),
      expectedExecutablePath: () => '/cache/chromium-1234/chrome-linux64/chrome',
      pathExists: () => false,
      directoryWritable: () => true,
      systemBrowserCandidates: () => [],
      runCommand: async (command) => {
        tried.push(command);
        return {
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: `Executable not found in $PATH: "${command}"`,
        };
      },
    });

    const report = await ensureBrowserBinary(io, {});

    expect(tried.length, 'every candidate must be tried, not just the first').toBeGreaterThan(1);
    expect(report.ok).toBe(false);
    expect(report.problem).not.toContain('exited with code null');
    expect(report.problem).toContain('is not available');
  });
});

/**
 * A stand-in product's install facts.
 *
 * The agent's version of these tests asserted its own release asset names and
 * its own `bun add -g @pellux/goodvibes-agent`. Those are facts about a
 * product, and the SDK has none, so the profile is supplied here and what is
 * asserted is that each install kind is answered with ITS OWN fix and never
 * another's, which is the defect these tests exist for.
 */
const PRODUCT: BrowserDriverInstallProfile = {
  detectInstallKind: (execPath: string): BrowserDriverInstallKind => {
    const segments = execPath.split(/[\\/]/);
    const execName = (segments[segments.length - 1] ?? '').toLowerCase();
    if (execName === 'bun' || execName === 'bun.exe') return 'source';
    if (segments.includes('node_modules')) return 'global-package';
    return 'binary';
  },
  archiveName: 'browser-driver.tar.gz',
  directoryName: DRIVER_DIR_NAME,
  releasesUrl: 'https://example.invalid/releases/latest',
  installerCommand: 'curl -fsSL https://example.invalid/install.sh | sh',
  globalPackageCommand: 'bun add -g @example/product',
  sourceInstallCommand: 'bun install',
};

describe('remediation matches how the product was actually installed', () => {
  test('a binary install is told to get the driver that ships with the release, never to install the package', () => {
    const message = driverRemediation(PRODUCT, { execPath: '/home/someone/.local/bin/some-product' });
    expect(message).toContain(PRODUCT.archiveName);
    expect(message).toContain(PRODUCT.releasesUrl);
    expect(message).toContain(`/home/someone/.local/bin/${DRIVER_DIR_NAME}`);
    // The exact instruction that silently switched a binary install to a
    // package install.
    expect(message).not.toContain(PRODUCT.globalPackageCommand);
  });

  test('a package install is told to reinstall the package', () => {
    const message = driverRemediation(PRODUCT, {
      execPath: '/home/someone/.bun/install/global/node_modules/@example/product/bin/product',
    });
    expect(message).toContain(PRODUCT.globalPackageCommand);
    expect(message).not.toContain(PRODUCT.archiveName);
  });

  test('a source checkout is told to install dependencies', () => {
    const message = driverRemediation(PRODUCT, { execPath: '/usr/local/bin/bun' });
    expect(message).toContain('bun install');
    expect(message).not.toContain('bun add -g');
  });

  test('the path named in the advice is the path the driver actually goes to', () => {
    const execPath = '/home/someone/.local/bin/some-product';
    const staged = shippedDriverPath(PRODUCT, { execPath });
    expect(staged).toBe(`/home/someone/.local/bin/${DRIVER_DIR_NAME}`);
    expect(driverRemediation(PRODUCT, { execPath })).toContain(staged);
  });
});

/** Minimal IO that never touches the network, the filesystem, or a process. */
function stubIo(overrides: Partial<BrowserProvisionIo> = {}): BrowserProvisionIo {
  const ok: CommandOutcome = { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
  return {
    resolveDriver: () => ({ available: false, packageDirectory: null, cliPath: null, version: null, error: 'no driver' }),
    expectedExecutablePath: () => null,
    browsersPath: () => join(tmpdir(), `gv-browsers-${Math.random().toString(36).slice(2)}`),
    pathExists: () => false,
    isExecutableFile: () => false,
    directoryWritable: () => true,
    removePath: () => undefined,
    runCommand: async () => ok,
    systemBrowserCandidates: () => [],
    now: () => 0,
    ...overrides,
  };
}

describe('the self-provision fallback', () => {
  test('is attempted before the driver is ever reported missing', async () => {
    let attempted = false;
    const io = stubIo({
      installDriver: async () => {
        attempted = true;
        return { code: 1, stdout: '', stderr: 'registry unreachable', timedOut: false, spawnError: null };
      },
      managedDriverRoot: () => '/tmp/gv-managed',
    });

    const report = await ensureBrowserBinary(io, {});

    expect(attempted, 'provisioning must be tried before reporting the driver missing').toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failure).toBe('driver-missing');
    // The report says it tried and what stopped it, not merely "missing".
    expect(report.problem).toContain('could not be installed automatically');
    expect(report.problem).toContain('registry unreachable');
    expect(report.steps.some((step) => step.step === 'install-driver')).toBe(true);
  });

  test('reports the install-kind-aware fix when provisioning genuinely cannot work', async () => {
    const io = stubIo({
      installDriver: async () => ({ code: 1, stdout: '', stderr: 'offline', timedOut: false, spawnError: null }),
      managedDriverRoot: () => '/tmp/gv-managed',
      driverFix: () => driverRemediation(PRODUCT, { execPath: '/home/someone/.local/bin/some-product' }),
    });

    const report = await ensureBrowserBinary(io, {});

    expect(report.fix).toContain(PRODUCT.archiveName);
    expect(report.fix).not.toContain(PRODUCT.globalPackageCommand);
  });

  test('a driver installed by the fallback is then used, not re-reported as missing', async () => {
    let installed = false;
    const io = stubIo({
      installDriver: async () => {
        installed = true;
        return { code: 0, stdout: 'downloaded playwright-core@1.62.0 from the npm registry', stderr: '', timedOut: false, spawnError: null };
      },
      managedDriverRoot: () => '/tmp/gv-managed',
      resolveDriver: () => installed
        ? { available: true, packageDirectory: '/tmp/gv-managed', cliPath: '/tmp/gv-managed/cli.js', version: '1.62.0', error: null }
        : { available: false, packageDirectory: null, cliPath: null, version: null, error: 'no driver' },
      // A system browser is present, so provisioning can complete without a download.
      systemBrowserCandidates: () => ['/usr/bin/chromium'],
      isExecutableFile: () => true,
      pathExists: () => true,
      runCommand: async () => ({ code: 0, stdout: 'Chromium 148', stderr: '', timedOut: false, spawnError: null }),
    });

    const report = await ensureBrowserBinary(io, {});

    expect(installed).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.driverVersion).toBe('1.62.0');
  });

  test('a reporting call installs no driver, and says that is why none is there', async () => {
    // `status` is a read-only action everywhere it is gated, and the CLI help
    // says it installs nothing. It reached this policy with allowDownload:false
    // and the driver install ran anyway, fetching a package from the registry
    // and writing it into the owner's home on what the owner was told was a
    // look-only call.
    let installAttempted = false;
    const io = stubIo({
      installDriver: async () => {
        installAttempted = true;
        return { code: 0, stdout: 'downloaded', stderr: '', timedOut: false, spawnError: null };
      },
      managedDriverRoot: () => '/tmp/gv-managed',
      resolveDriver: () => ({ available: false, packageDirectory: null, cliPath: null, version: null, error: 'no driver' }),
    });

    const report = await ensureBrowserBinary(io, { allowDownload: false });

    expect(installAttempted, 'a reporting call must not install a driver').toBe(false);
    expect(report.ok).toBe(false);
    expect(report.failure).toBe('driver-not-installed-yet');
    // And it must not claim installing was tried and failed.
    expect(report.problem).not.toContain('could not be installed');
    expect(report.problem).toContain('installs nothing');
    expect(report.steps.some((step) => step.step === 'install-driver')).toBe(false);
    expect(report.steps.some((step) => step.step === 'install-driver-skipped')).toBe(true);
  });

  test('a skipped driver install never reads as setup that ran', async () => {
    // describeProvisionWork turns ok install steps into a "first browser call
    // installed the driver" receipt for the model. A skip is not an install.
    const io = stubIo({
      installDriver: async () => ({ code: 0, stdout: 'downloaded', stderr: '', timedOut: false, spawnError: null }),
      managedDriverRoot: () => '/tmp/gv-managed',
      resolveDriver: () => ({ available: false, packageDirectory: null, cliPath: null, version: null, error: 'no driver' }),
    });

    const report = await ensureBrowserBinary(io, { allowDownload: false });

    expect(describeProvisionWork(report)).toBe(null);
  });

  test('setup that actually ran is reported back to the caller', () => {
    const receipt = describeProvisionWork({
      ok: true,
      source: 'managed-download',
      executablePath: '/x',
      browsersPath: '/y',
      driverVersion: '1.62.0',
      steps: [
        { step: 'install-driver', detail: 'installed', ok: true, elapsedMs: 1200 },
        { step: 'install-browser', detail: 'downloaded', ok: true, elapsedMs: 7000 },
      ],
      failure: null,
      problem: null,
      fix: null,
    });
    expect(receipt).toContain('installed the browser driver');
    expect(receipt).toContain('downloaded the browser');
  });

  test('a call that had nothing to do reports no setup', () => {
    const receipt = describeProvisionWork({
      ok: true,
      source: 'managed-cache',
      executablePath: '/x',
      browsersPath: '/y',
      driverVersion: '1.62.0',
      steps: [{ step: 'cached-browser', detail: 'ok', ok: true, elapsedMs: 10 }],
      failure: null,
      problem: null,
      fix: null,
    });
    expect(receipt).toBeNull();
  });
});

describe('the managed driver location', () => {
  test('is inside the surface-owned storage for the home it was given', () => {
    const root = managedDriverRoot('/home/someone', 'agent');
    expect(root).toBe(join('/home/someone', '.goodvibes', 'agent', 'browser', 'driver'));
    expect(driverSearchDirectories({ surfaceRoot: 'agent', homeDirectory: '/home/someone' }))
      .toContain(join(root, 'node_modules', DRIVER_DIR_NAME));
  });
});

// Scratch cleanup is deliberate rather than left to the OS: these tests create
// real directories, and a stale-tmp problem is exactly what they add up to.
afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
