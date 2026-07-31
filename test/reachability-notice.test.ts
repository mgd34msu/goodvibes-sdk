/**
 * reachability-notice.test.ts — the startup reachability notice: does a build
 * say so when the shell reaches a different copy, and when it is behind the
 * current release?
 *
 * Both failure modes look identical from the outside — an old build answering
 * as if it were the new one — which is how a leftover earlier-PATH copy can
 * keep answering while the maintained install is dutifully upgraded. Every
 * host touch is injected via scanCommandShadows: no PATH is read, no file is
 * stat'ed, no process is spawned.
 */
import { describe, expect, test } from 'bun:test';
import { buildReachabilityNotices, reachabilityNoticeLines } from '@pellux/goodvibes-terminal-shell';
import { scanCommandShadows } from '@pellux/goodvibes-sdk/platform/runtime/path-shadow';

const HOME = '/home/owner';
const INSTALL_DIR = `${HOME}/.local/bin`;
const BUN_BIN = `${HOME}/.bun/bin`;
const BUN_PACKAGE = `${HOME}/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes`;

interface FakeHost {
  readonly files: Record<string, { readonly link?: string; readonly version?: string }>;
}

function hostIo(host: FakeHost) {
  return {
    isExecutableFile: (path: string) => Object.hasOwn(host.files, path),
    realPath: (path: string) => host.files[path]?.link ?? path,
    probeVersion: (path: string) => host.files[path]?.version,
  };
}

describe('a shadowed maintained install', () => {
  test('names both copies, both versions, and the exact fix', () => {
    const host: FakeHost = {
      files: {
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
      },
    };
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [BUN_BIN, '/usr/bin', INSTALL_DIR],
      homeDir: HOME,
      ...hostIo(host),
    });

    const notices = buildReachabilityNotices({
      scan,
      runningVersion: '1.25.0',
      latestVersion: '1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    });

    expect(notices.some((notice) => notice.kind === 'shadowed')).toBe(true);
    const text = reachabilityNoticeLines(notices).join('\n');
    expect(text).toContain(`${BUN_BIN}/goodvibes`);
    expect(text).toContain('version 1.18.1');
    expect(text).toContain(`${INSTALL_DIR}/goodvibes`);
    expect(text).toContain('version 1.25.0');
    expect(text).toContain('bun remove -g @pellux/goodvibes-tui');
  });

  test('reports both problems at once when the build is also behind', () => {
    const host: FakeHost = {
      files: {
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.21.0' },
      },
    };
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [BUN_BIN, INSTALL_DIR],
      homeDir: HOME,
      ...hostIo(host),
    });

    const notices = buildReachabilityNotices({
      scan,
      runningVersion: '1.21.0',
      latestVersion: 'v1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    });

    expect(notices.map((notice) => notice.kind)).toEqual(['shadowed', 'behind']);
    const text = reachabilityNoticeLines(notices).join('\n');
    expect(text).toContain('This build is v1.21.0. The current release is v1.25.0');
    expect(text).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
  });
});

describe('an installed binary nobody can reach by name', () => {
  test('a binary whose directory is missing from PATH is reported as not-on-path', () => {
    const host: FakeHost = { files: { [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' } } };
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: ['/usr/bin'],
      homeDir: HOME,
      ...hostIo(host),
    });

    const notices = buildReachabilityNotices({
      scan,
      runningVersion: '1.25.0',
      latestVersion: '1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    });

    expect(notices.map((notice) => notice.kind)).toContain('not-on-path');
    expect(reachabilityNoticeLines(notices).join('\n')).toContain('not on your PATH');
  });
});

describe('the healthy case says nothing', () => {
  test('one copy, first on PATH, current version, produces zero notices', () => {
    const host: FakeHost = { files: { [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' } } };
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [INSTALL_DIR, '/usr/bin'],
      homeDir: HOME,
      ...hostIo(host),
    });

    expect(buildReachabilityNotices({
      scan,
      runningVersion: '1.25.0',
      latestVersion: '1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    })).toEqual([]);
  });
});

describe('being behind is stated plainly, and only when it is known', () => {
  test('an unknown latest version says nothing rather than guessing', () => {
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [INSTALL_DIR],
      homeDir: HOME,
      isExecutableFile: (path) => path === `${INSTALL_DIR}/goodvibes`,
      realPath: (path) => path,
    });
    expect(buildReachabilityNotices({
      scan,
      runningVersion: '1.18.1',
      latestVersion: undefined,
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    })).toEqual([]);
  });

  test('a build ahead of the published release is not called behind', () => {
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [INSTALL_DIR],
      homeDir: HOME,
      isExecutableFile: (path) => path === `${INSTALL_DIR}/goodvibes`,
      realPath: (path) => path,
    });
    expect(buildReachabilityNotices({
      scan,
      runningVersion: '1.26.0',
      latestVersion: '1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    })).toEqual([]);
  });

  test('a package-managed install that cannot swap itself is told it is behind, with its own command', () => {
    const host: FakeHost = {
      files: {
        [BUN_PACKAGE]: { version: 'goodvibes 1.18.1' },
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
      },
    };
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [BUN_BIN, '/usr/bin'],
      homeDir: HOME,
      ...hostIo(host),
    });

    const notices = buildReachabilityNotices({
      scan,
      runningVersion: '1.18.1',
      latestVersion: 'v1.25.0',
      updateCommand: 'bun add -g @pellux/goodvibes-tui',
    });

    const text = reachabilityNoticeLines(notices).join('\n');
    expect(text).toContain('This build is v1.18.1. The current release is v1.25.0');
    expect(text).toContain('genuinely absent from this build');
    expect(text).toContain('bun add -g @pellux/goodvibes-tui');
  });
});
