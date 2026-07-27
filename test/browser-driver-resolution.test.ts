import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import {
  DRIVER_VERSION,
  driverSearchDirectories,
  managedDriverRoot,
} from '../packages/sdk/src/platform/browser/browser-provision-io.js';
import { browserHostScriptPath } from '../packages/sdk/src/platform/browser/browser-host-client.js';
import {
  browserProfileRoot,
  browserScreenshotRoot,
} from '../packages/sdk/src/platform/browser/browser-sessions.js';

const sdkPackageDir = join(import.meta.dir, '..', 'packages', 'sdk');

describe('driver resolution for a compiled binary', () => {
  /**
   * A compiled binary has no node_modules and no package.json, so it cannot
   * look up which driver it needs. The version is a constant in the source, and
   * this keeps it honest against the dependency the package actually declares.
   *
   * The agent asserted this against its own package.json. The SDK is where the
   * dependency now lives, so the SDK's manifest is what it must agree with —
   * and it is declared optional, alongside every other heavy runtime the SDK
   * loads only when a capability is used.
   */
  test('the pinned driver version matches the declared dependency', () => {
    const manifest = JSON.parse(readFileSync(join(sdkPackageDir, 'package.json'), 'utf8')) as {
      readonly optionalDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies?.['playwright-core']).toBe(DRIVER_VERSION);
  });

  test('the search looks beside the executable before anywhere else', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    const executableDirectory = dirname(process.execPath);
    expect(directories[0]).toBe(join(executableDirectory, 'playwright-core'));
    expect(directories).toContain(join(executableDirectory, 'vendor', 'playwright-core'));
  });

  test('the search includes the surface-owned driver directory', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    expect(directories).toContain(join(managedDriverRoot('/home/someone', 'test-surface'), 'node_modules', 'playwright-core'));
  });

  test('an explicit override is searched first', () => {
    const previous = process.env.GOODVIBES_PLAYWRIGHT_CORE;
    process.env.GOODVIBES_PLAYWRIGHT_CORE = '/opt/driver';
    try {
      expect(driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' })[0]).toBe('/opt/driver');
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_PLAYWRIGHT_CORE;
      else process.env.GOODVIBES_PLAYWRIGHT_CORE = previous;
    }
  });

  test('the managed driver directory sits under the surface storage root', () => {
    expect(managedDriverRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/driver');
    // And a different surface on the same machine gets its own, rather than
    // reaching into another product's storage.
    expect(managedDriverRoot('/home/someone', 'daemon')).toBe('/home/someone/.goodvibes/daemon/browser/driver');
  });
});

describe('surface-owned browser storage', () => {
  test('profiles and screenshots live under the surface-scoped storage root', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/profiles');
    expect(browserScreenshotRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/screenshots');
  });

  test('neither writes into the user\'s project directory', () => {
    for (const path of [browserProfileRoot('/home/someone', 'agent'), browserScreenshotRoot('/home/someone', 'agent')]) {
      expect(path.startsWith('/home/someone/.goodvibes/')).toBe(true);
    }
  });

  test('two surfaces never share a browser profile directory', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).not.toBe(browserProfileRoot('/home/someone', 'daemon'));
  });
});

describe('the node-hosted browser host', () => {
  test('its script ships with the source and is found on disk', () => {
    const path = browserHostScriptPath();
    expect(path.endsWith('browser-host.mjs')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('connectOverCDP');
  });

  test('the host never closes a browser it attached to', () => {
    const source = readFileSync(browserHostScriptPath(), 'utf8');
    // The release handler drops the connection; nothing calls browser.close().
    expect(source).toContain('state.browser = null');
    expect(source).not.toContain('browser.close()');
  });

  /**
   * The agent asserted the script sat beside `dist/goodvibes-agent`. The SDK
   * equivalent is that the published package carries it: tsc emits only what it
   * compiles, so without the prepare step this hand-written .mjs would exist in
   * src and be absent from dist, and every attach would fail on a machine that
   * installed the package.
   */
  test('the package build stages the host script into dist', () => {
    const prepare = readFileSync(join(import.meta.dir, '..', 'scripts', 'prepare-sdk-package.ts'), 'utf8');
    expect(prepare).toContain('platform/browser/browser-host.mjs');
    const manifest = JSON.parse(readFileSync(join(sdkPackageDir, 'package.json'), 'utf8')) as {
      readonly files?: readonly string[];
    };
    expect(manifest.files).toContain('dist');
  });
});
