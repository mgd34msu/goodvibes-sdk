/**
 * SEC-04: postinstall-patch-minimatch.mjs must work without any network access.
 *
 * Strategy: Run the postinstall script with HTTPS_PROXY pointing at an
 * unreachable address. If the script makes any network call it will fail;
 * the vendored path must succeed without it.
 *
 * We also verify:
 *   - When no vulnerable minimatch exists, the script exits 0 cleanly.
 *   - When a vulnerable minimatch exists, it is patched from the vendor dir.
 *   - The vendored minimatch payload is present at scripts/vendor/minimatch/.
 *   - The patched minimatch version matches the vendored version.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const SDK_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const POSTINSTALL = join(SDK_ROOT, 'scripts', 'postinstall-patch-minimatch.mjs');
const VENDOR_DIR = join(SDK_ROOT, 'scripts', 'vendor', 'minimatch');

/** Network-blocking environment: HTTPS_PROXY points at a guaranteed-unreachable port. */
const NO_NETWORK_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HTTPS_PROXY: 'http://127.0.0.1:1',
  http_proxy: 'http://127.0.0.1:1',
  NO_PROXY: '',
};

describe('SEC-04: vendored minimatch payload is present', () => {
  test('scripts/vendor/minimatch/ exists and contains package.json', () => {
    expect(existsSync(VENDOR_DIR)).toBe(true);
    expect(existsSync(join(VENDOR_DIR, 'package.json'))).toBe(true);
  });

  test('vendored minimatch package.json has version >= 10.2.3', () => {
    const pkg = JSON.parse(readFileSync(join(VENDOR_DIR, 'package.json'), 'utf-8')) as { version: string };
    const [maj, min, patch] = pkg.version.split('.').map(Number);
    const isFixed = (maj ?? 0) > 10
      || ((maj ?? 0) === 10 && (min ?? 0) > 2)
      || ((maj ?? 0) === 10 && (min ?? 0) === 2 && (patch ?? 0) >= 3);
    expect(isFixed).toBe(true);
  });
});

describe('SEC-04: postinstall works without network', () => {
  test('runs to completion (exit 0) with no vulnerable minimatch in a clean dir', () => {
    const fakeRoot = join(tmpdir(), `gv-sec04-clean-${Date.now()}`);
    mkdirSync(join(fakeRoot, 'node_modules'), { recursive: true });

    try {
      const result = spawnSync('node', [POSTINSTALL], {
        env: { ...NO_NETWORK_ENV, INIT_CWD: fakeRoot },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
    } finally {
      try { rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('patches a vulnerable minimatch from vendor dir without network', () => {
    const fakeRoot = join(tmpdir(), `gv-sec04-patch-${Date.now()}`);
    const minimatchDir = join(fakeRoot, 'node_modules', 'minimatch');
    mkdirSync(minimatchDir, { recursive: true });

    // Plant a vulnerable minimatch
    writeFileSync(
      join(minimatchDir, 'package.json'),
      JSON.stringify({ name: 'minimatch', version: '10.0.1' }, null, 2),
    );

    try {
      const result = spawnSync('node', [POSTINSTALL], {
        env: { ...NO_NETWORK_ENV, INIT_CWD: fakeRoot },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();

      // Verify the patched version came from vendor, not network
      const patchedPkg = JSON.parse(
        readFileSync(join(minimatchDir, 'package.json'), 'utf-8'),
      ) as { version: string };

      const vendorPkg = JSON.parse(
        readFileSync(join(VENDOR_DIR, 'package.json'), 'utf-8'),
      ) as { version: string };

      expect(patchedPkg.version).toBe(vendorPkg.version);
    } finally {
      try { rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('already-patched minimatch (version >= 10.2.3) is not re-patched', () => {
    const fakeRoot = join(tmpdir(), `gv-sec04-already-${Date.now()}`);
    const minimatchDir = join(fakeRoot, 'node_modules', 'minimatch');
    mkdirSync(minimatchDir, { recursive: true });

    // Plant a non-vulnerable version
    writeFileSync(
      join(minimatchDir, 'package.json'),
      JSON.stringify({ name: 'minimatch', version: '10.2.5' }, null, 2),
    );

    try {
      const result = spawnSync('node', [POSTINSTALL], {
        env: { ...NO_NETWORK_ENV, INIT_CWD: fakeRoot },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(result.status).toBe(0);
      // Should report "no vulnerable minimatch detected"
      expect(result.stdout).toContain('no vulnerable minimatch detected');
    } finally {
      try { rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
