/**
 * daemon home settings must write credential-bearing files at 0600.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeDaemonSetting,
} from '../packages/sdk/src/platform/workspace/daemon-home.js';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-sec02-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('daemon home credential file permissions', () => {
  let base: string;

  beforeEach(() => { base = tempDir('sec02'); });
  afterEach(() => { cleanup(base); });

  test('writeDaemonSetting daemon-settings.json created with mode 0600', () => {
    const daemonHome = join(base, 'daemon-home');
    mkdirSync(daemonHome, { recursive: true });

    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/some/path');

    const settingsPath = join(daemonHome, 'daemon-settings.json');
    const mode = statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('writeDaemonSetting mode stays 0600 on subsequent updates', () => {
    const daemonHome = join(base, 'daemon-home-update');
    mkdirSync(daemonHome, { recursive: true });

    writeDaemonSetting(daemonHome, 'key1', 'val1');
    writeDaemonSetting(daemonHome, 'key2', 'val2');

    const settingsPath = join(daemonHome, 'daemon-settings.json');
    const mode = statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

});
