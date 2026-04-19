import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDaemonHomeDir,
  runDaemonHomeMigration,
  readDaemonSetting,
  writeDaemonSetting,
} from '../packages/sdk/src/_internal/platform/workspace/daemon-home.ts';
import { WorkspaceSwapManager } from '../packages/sdk/src/_internal/platform/workspace/workspace-swap-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// resolveDaemonHomeDir
// ---------------------------------------------------------------------------

describe('resolveDaemonHomeDir', () => {
  test('uses daemonHomeArg when provided', () => {
    const arg = '/custom/daemon/home';
    expect(resolveDaemonHomeDir({ daemonHomeArg: arg })).toBe(arg);
  });

  test('uses GOODVIBES_DAEMON_HOME env when daemonHomeArg is absent', () => {
    const envPath = '/env/daemon/home';
    expect(resolveDaemonHomeDir({ env: { GOODVIBES_DAEMON_HOME: envPath } })).toBe(envPath);
  });

  test('prefers daemonHomeArg over env var', () => {
    const arg = '/cli/path';
    const env = { GOODVIBES_DAEMON_HOME: '/env/path' };
    expect(resolveDaemonHomeDir({ daemonHomeArg: arg, env })).toBe(arg);
  });

  test('falls back to ~/.goodvibes/daemon when nothing is configured', () => {
    const result = resolveDaemonHomeDir({ env: {} });
    // Should end with .goodvibes/daemon
    expect(result.endsWith('.goodvibes/daemon') || result.endsWith('.goodvibes\\daemon')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDaemonHomeMigration
// ---------------------------------------------------------------------------

describe('runDaemonHomeMigration', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('base');
    daemonHome = join(baseDir, 'daemon-home');
  });

  afterEach(() => {
    cleanup(baseDir);
  });

  test('freshInstall=true when daemon home does not exist yet', () => {
    const result = runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} });
    expect(result.freshInstall).toBe(true);
    expect(result.daemonHomeDir).toBe(daemonHome);
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('freshInstall=false when daemon home already exists', () => {
    mkdirSync(daemonHome, { recursive: true });
    const result = runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} });
    expect(result.freshInstall).toBe(false);
  });

  test('creates daemon home directory during migration', () => {
    // auth-users.json legacy source is at homedir()/.goodvibes/tui — not controllable in unit tests.
    // We verify: migration creates the daemon home dir and returns freshInstall=true.
    expect(existsSync(daemonHome)).toBe(false);
    runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} });
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('migrates operator-tokens.json from old workspace cwd (non-destructive)', () => {
    const oldTokenDir = join(baseDir, '.goodvibes');
    mkdirSync(oldTokenDir, { recursive: true });
    const tokenContent = JSON.stringify({ tokens: ['tok1'] });
    writeFileSync(join(oldTokenDir, 'operator-tokens.json'), tokenContent);

    runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} });

    const dest = join(daemonHome, 'operator-tokens.json');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe(tokenContent);

    // Original still present (non-destructive)
    expect(existsSync(join(oldTokenDir, 'operator-tokens.json'))).toBe(true);
  });

  test('skips migration when source files do not exist (no error)', () => {
    // No old files anywhere; should not throw
    expect(() => runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readDaemonSetting / writeDaemonSetting
// ---------------------------------------------------------------------------

describe('daemon settings read/write', () => {
  let daemonHome: string;

  beforeEach(() => {
    daemonHome = tempDir('settings');
  });

  afterEach(() => {
    cleanup(daemonHome);
  });

  test('returns undefined for unknown key', () => {
    expect(readDaemonSetting(daemonHome, 'no.such.key')).toBeUndefined();
  });

  test('round-trips a setting', () => {
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/some/path');
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe('/some/path');
  });

  test('overwrites an existing setting', () => {
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/old');
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/new');
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe('/new');
  });
});

// ---------------------------------------------------------------------------
// WorkspaceSwapManager
// ---------------------------------------------------------------------------

describe('WorkspaceSwapManager', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('swap-base');
    daemonHome = tempDir('swap-daemon');
  });

  afterEach(() => {
    cleanup(baseDir, daemonHome);
  });

  function makeManager(opts: { busyCount?: number; rerootFails?: boolean } = {}) {
    return new WorkspaceSwapManager(baseDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => opts.busyCount ?? 0,
      rerootStores: async () => {
        if (opts.rerootFails) throw new Error('store reroot failed');
      },
    });
  }

  test('getCurrentWorkingDir returns initial dir', () => {
    const mgr = makeManager();
    expect(mgr.getCurrentWorkingDir()).toBe(baseDir);
  });

  test('swap succeeds when no sessions are busy', async () => {
    const mgr = makeManager();
    const newDir = join(baseDir, 'new-workspace');
    const result = await mgr.requestSwap(newDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previous).toBe(baseDir);
      expect(result.current).toBe(newDir);
    }
    expect(mgr.getCurrentWorkingDir()).toBe(newDir);
  });

  test('swap is refused (WORKSPACE_BUSY) when sessions have pending input', async () => {
    const mgr = makeManager({ busyCount: 2 });
    const result = await mgr.requestSwap(join(baseDir, 'new'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WORKSPACE_BUSY');
      expect(result.retryAfter).toBe(5);
    }
    // Working dir unchanged
    expect(mgr.getCurrentWorkingDir()).toBe(baseDir);
  });

  test('swap returns INVALID_PATH when empty string given', async () => {
    const mgr = makeManager();
    const result = await mgr.requestSwap('  ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PATH');
    }
  });

  test('swap returns INVALID_PATH when rerootStores throws', async () => {
    const mgr = makeManager({ rerootFails: true });
    const result = await mgr.requestSwap(join(baseDir, 'new-workspace'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PATH');
    }
  });

  test('persists new workingDir to daemon settings on success', async () => {
    const mgr = makeManager();
    const newDir = join(baseDir, 'persisted-workspace');
    const result = await mgr.requestSwap(newDir);
    expect(result.ok).toBe(true);
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe(newDir);
  });
});
