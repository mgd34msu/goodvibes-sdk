/**
 * The daemon's update source and the files a daemon update owns, after the
 * daemon became its own product with its own repository.
 *
 * Two things have to hold for an already-installed daemon to hand itself over
 * to the new release line without anyone touching the machine:
 *
 *   1. The shipped default of `update.releasesUrl` names the daemon's own
 *      repository, so the hourly loop resolves its next tag from there.
 *   2. A daemon update no longer claims the terminal app binary sitting beside
 *      it. A daemon-repository release publishes no `goodvibes-<os>-<arch>`
 *      asset, so a daemon that still listed it would look for a file that does
 *      not exist — and would be overwriting a product that updates itself from
 *      a different repository on a different version line.
 */
import { describe, expect, test } from 'bun:test';
import { updateConfigDefaults, updateConfigSettings } from '../packages/sdk/src/platform/config/schema-domain-update.js';
import { resolveDaemonInstalledFiles } from '../packages/sdk/src/platform/daemon/auto-updater.js';
import type { UpdateFileIo } from '../packages/sdk/src/platform/runtime/self-update.js';

const DAEMON_REPO_LATEST = 'https://github.com/mgd34msu/goodvibes-daemon/releases/latest';

/** An in-memory filesystem view: every listed path exists, nothing else does. */
function presentFiles(paths: readonly string[]): UpdateFileIo {
  const present = new Set(paths);
  return {
    writeFile: () => {},
    rename: () => {},
    chmod: () => {},
    exists: (path) => present.has(path),
    mkdir: () => {},
  };
}

describe('daemon update source', () => {
  test('the shipped default resolves the daemon repository, not the terminal app repository', () => {
    expect(updateConfigDefaults.update.releasesUrl).toBe(DAEMON_REPO_LATEST);
  });

  test('the settings definition carries the same default as the defaults object', () => {
    const definition = updateConfigSettings.find((setting) => setting.key === 'update.releasesUrl');
    expect(definition).toBeDefined();
    expect(definition?.default).toBe(DAEMON_REPO_LATEST);
  });
});

describe('the files a daemon update owns', () => {
  const execPath = '/home/someone/.local/bin/goodvibes-daemon';
  const appPath = '/home/someone/.local/bin/goodvibes';
  const addonPath = '/home/someone/.local/bin/lib/sqlite-vec-linux-x64/vec0.so';

  test('the terminal app binary beside the daemon is left alone even when it is installed', () => {
    const files = resolveDaemonInstalledFiles({
      execPath,
      platform: 'linux',
      arch: 'x64',
      io: presentFiles([execPath, appPath, addonPath]),
    });
    expect(files.map((file) => file.path)).not.toContain(appPath);
    expect(files.map((file) => file.label)).not.toContain('app binary');
  });

  test('the daemon binary and the vector addon beside it are still owned', () => {
    const files = resolveDaemonInstalledFiles({
      execPath,
      platform: 'linux',
      arch: 'x64',
      io: presentFiles([execPath, appPath, addonPath]),
    });
    expect(files).toEqual([
      { label: 'daemon binary', path: execPath, assetName: 'goodvibes-daemon-linux-x64', executable: true },
      { label: 'vector addon', path: addonPath, assetName: 'sqlite-vec-linux-x64.so', executable: false },
    ]);
  });

  test('an install with no addon on disk owns the daemon binary alone', () => {
    const files = resolveDaemonInstalledFiles({
      execPath,
      platform: 'linux',
      arch: 'x64',
      io: presentFiles([execPath, appPath]),
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.label).toBe('daemon binary');
  });

  // The install script puts all three products in one directory, so every
  // sibling binary is present on a real box. The set is the daemon's own files
  // and nothing else: each product updates itself from its own repository, and
  // an all-or-nothing set that names a sibling's asset fails every check
  // forever once that asset is not published alongside the daemon's.
  test('no sibling product binary is claimed, whichever ones are installed beside it', () => {
    const siblings = [
      '/home/someone/.local/bin/goodvibes',
      '/home/someone/.local/bin/goodvibes-agent',
      '/home/someone/.local/bin/goodvibes-webui',
    ];
    const files = resolveDaemonInstalledFiles({
      execPath,
      platform: 'linux',
      arch: 'x64',
      io: presentFiles([execPath, addonPath, ...siblings]),
    });
    expect(files.map((file) => file.path)).toEqual([execPath, addonPath]);
    for (const sibling of siblings) {
      expect(files.map((file) => file.path), sibling).not.toContain(sibling);
    }
  });

  test('the same set holds on every platform/arch the daemon publishes for', () => {
    for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']] as const) {
      const files = resolveDaemonInstalledFiles({
        execPath,
        platform,
        arch,
        io: presentFiles([execPath, appPath]),
      });
      expect(files.map((file) => file.label), `${platform}/${arch}`).toEqual(['daemon binary']);
    }
  });

  // An addon that is not installed is not a missing asset — it is a machine
  // that never had one. It must not appear in the set, because a set naming an
  // asset that will not be downloaded fails the whole all-or-nothing pass.
  test('an absent optional addon leaves the set applicable rather than bricked', () => {
    const withAddon = resolveDaemonInstalledFiles({
      execPath, platform: 'linux', arch: 'x64', io: presentFiles([execPath, addonPath]),
    });
    const withoutAddon = resolveDaemonInstalledFiles({
      execPath, platform: 'linux', arch: 'x64', io: presentFiles([execPath]),
    });
    expect(withAddon.map((file) => file.assetName)).toEqual(['goodvibes-daemon-linux-x64', 'sqlite-vec-linux-x64.so']);
    expect(withoutAddon.map((file) => file.assetName)).toEqual(['goodvibes-daemon-linux-x64']);
    // Every entry in either set names a real asset: nothing in the set is
    // unresolvable, which is what an all-or-nothing download requires.
    for (const file of [...withAddon, ...withoutAddon]) {
      expect(file.assetName, file.label).not.toBeNull();
    }
  });

  // A platform the daemon publishes no assets for: the addon is skipped and the
  // daemon binary carries a null assetName, which resolveTargets reads as "no
  // update to apply here" rather than downloading something that is not there.
  test('a platform with no published assets yields no downloadable target', () => {
    const files = resolveDaemonInstalledFiles({
      execPath, platform: 'win32', arch: 'x64', io: presentFiles([execPath, appPath, addonPath]),
    });
    expect(files.map((file) => file.label)).toEqual(['daemon binary']);
    expect(files[0]?.assetName).toBeNull();
  });
});
