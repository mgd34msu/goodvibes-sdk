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
});
