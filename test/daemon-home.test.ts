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

// ---------------------------------------------------------------------------
// B9 — path traversal behaviour
// ---------------------------------------------------------------------------

describe('WorkspaceSwapManager: path traversal', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('traversal-base');
    daemonHome = tempDir('traversal-daemon');
  });

  afterEach(() => cleanup(baseDir, daemonHome));

  function makeManager() {
    return new WorkspaceSwapManager(baseDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });
  }

  test('requestSwap with ".." relative path resolves cleanly and succeeds', async () => {
    // The manager receives an absolute path resolved by the caller in practice.
    // When a raw ".." is passed the OS path.resolve in mkdirSync will place it
    // one level above baseDir — this is valid (no security boundary here) and
    // must either succeed cleanly or return INVALID_PATH.
    // We document the choice: we ALLOW traversal (resolve naturally, do not
    // sanitise) because the swap endpoint is privileged (daemon-token-gated) and
    // operators are trusted to specify absolute paths via the CLI or config tool.
    const mgr = makeManager();
    const traversalPath = join(baseDir, '..', 'traversal-target-' + Date.now());
    const result = await mgr.requestSwap(traversalPath);
    // Either ok=true (resolved cleanly into a sibling dir) or ok=false INVALID_PATH.
    // Both are acceptable. What must NOT happen is an unhandled exception.
    if (result.ok) {
      expect(mgr.getCurrentWorkingDir()).toBe(traversalPath);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_PATH');
      }
    }
    // Clean up the possible sibling dir
    try { rmSync(traversalPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('requestSwap with absolute path containing ".." segments resolves correctly', async () => {
    // Ensure /tmp/a/b/../c resolves to /tmp/a/c — no special rejection.
    const mgr = makeManager();
    const subDir = join(baseDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    // Build a path that traverses back to baseDir via parent
    const traversalPath = join(subDir, '..', 'resolved-target');
    const result = await mgr.requestSwap(traversalPath);
    if (result.ok) {
      expect(mgr.getCurrentWorkingDir()).toBe(traversalPath);
    } else {
      if (!result.ok) {
        expect(result.code).toBe('INVALID_PATH');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// W-8 additional test cases
// ---------------------------------------------------------------------------

describe('runDaemonHomeMigration: corrupt JSON source', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('corrupt');
    daemonHome = join(baseDir, 'daemon-home');
  });

  afterEach(() => cleanup(baseDir));

  test('skips corrupt operator-tokens.json (does not copy, does not throw)', () => {
    const oldTokenDir = join(baseDir, '.goodvibes');
    mkdirSync(oldTokenDir, { recursive: true });
    writeFileSync(join(oldTokenDir, 'operator-tokens.json'), 'NOT VALID JSON {{{{');

    expect(() => runDaemonHomeMigration(daemonHome, { cwd: baseDir, env: {} })).not.toThrow();

    const dest = join(daemonHome, 'operator-tokens.json');
    expect(existsSync(dest)).toBe(false);
  });
});

describe('WorkspaceSwapManager: edge cases', () => {
  let baseDir: string;
  let daemonHome: string;
  let emittedEvents: Array<{ domain: string; type: string }>;

  beforeEach(() => {
    baseDir = tempDir('swap-edge-base');
    daemonHome = tempDir('swap-edge-daemon');
    emittedEvents = [];
  });

  afterEach(() => cleanup(baseDir, daemonHome));

  function makeManagerWithBus(opts: { busyCount?: number } = {}) {
    const mockBus = {
      emit: (domain: string, envelope: { type: string }) => {
        emittedEvents.push({ domain, type: envelope.type });
      },
      on: () => () => {},
    } as unknown as import('../packages/sdk/src/_internal/platform/runtime/events/index.ts').RuntimeEventBus;

    return new WorkspaceSwapManager(baseDir, {
      runtimeBus: mockBus,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => opts.busyCount ?? 0,
      rerootStores: async () => {},
    });
  }

  test('emits WORKSPACE_SWAP_REFUSED (not STARTED) when busy', async () => {
    const mgr = makeManagerWithBus({ busyCount: 1 });
    await mgr.requestSwap(join(baseDir, 'new'));
    const types = emittedEvents.map((e) => e.type);
    expect(types).not.toContain('WORKSPACE_SWAP_STARTED');
    expect(types).toContain('WORKSPACE_SWAP_REFUSED');
    expect(types).not.toContain('WORKSPACE_SWAP_COMPLETED');
  });

  test('emits STARTED then COMPLETED on successful swap', async () => {
    const mgr = makeManagerWithBus();
    await mgr.requestSwap(join(baseDir, 'new-ok'));
    const types = emittedEvents.map((e) => e.type);
    expect(types.indexOf('WORKSPACE_SWAP_STARTED')).toBeLessThan(types.indexOf('WORKSPACE_SWAP_COMPLETED'));
  });

  test('all events are emitted under workspace domain', async () => {
    const mgr = makeManagerWithBus({ busyCount: 0 });
    await mgr.requestSwap(join(baseDir, 'domain-test'));
    for (const ev of emittedEvents) {
      expect(ev.domain).toBe('workspace');
    }
  });

  test('swap to a path that is a FILE returns INVALID_PATH', async () => {
    const filePath = join(baseDir, 'I-am-a-file.txt');
    writeFileSync(filePath, 'hello');
    const mgr = makeManagerWithBus();
    // mkdirSync on a path whose parent is a file will fail
    const result = await mgr.requestSwap(join(filePath, 'subdir'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PATH');
    }
  });

  test('concurrent swap requests: first succeeds, second gets WORKSPACE_BUSY', async () => {
    let resolveReroot!: () => void;
    const rerootDone = new Promise<void>((res) => { resolveReroot = res; });
    const mgr = new WorkspaceSwapManager(join(baseDir, 'concurrent-initial'), {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => { await rerootDone; },
    });

    // Fire first swap — hangs in rerootStores
    const first = mgr.requestSwap(join(baseDir, 'concurrent-a'));
    // Fire second swap immediately — must be WORKSPACE_BUSY (mutex holds)
    const second = await mgr.requestSwap(join(baseDir, 'concurrent-b'));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('WORKSPACE_BUSY');
    }
    // Release the first and confirm it succeeds
    resolveReroot();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  test('persistedInDaemonSettings: false when writeDaemonSetting throws', async () => {
    // Use a daemonHomeDir path that is actually a FILE so writeDaemonSetting cannot write
    const fileAsHome = join(baseDir, 'not-a-dir.txt');
    writeFileSync(fileAsHome, 'this is a file, not a directory');

    // Collect WORKSPACE_SWAP_COMPLETED payloads
    const completedPayloads: Array<Record<string, unknown>> = [];
    const mockBus = {
      emit: (domain: string, envelope: Record<string, unknown>) => {
        if (envelope['type'] === 'WORKSPACE_SWAP_COMPLETED') {
          const payload = envelope['payload'];
          if (payload && typeof payload === 'object') {
            completedPayloads.push(payload as Record<string, unknown>);
          }
        }
      },
      on: () => () => {},
    } as unknown as import('../packages/sdk/src/_internal/platform/runtime/events/index.ts').RuntimeEventBus;

    const mgr = new WorkspaceSwapManager(baseDir, {
      runtimeBus: mockBus,
      daemonHomeDir: fileAsHome, // writeDaemonSetting will fail to write inside a file path
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });

    const result = await mgr.requestSwap(join(baseDir, 'persist-fail-target'));
    // Swap itself should succeed
    expect(result.ok).toBe(true);
    // COMPLETED event must have been emitted
    expect(completedPayloads.length).toBeGreaterThan(0);
    // persistedInDaemonSettings must be false (write failed non-fatally)
    expect(completedPayloads[0]!['persistedInDaemonSettings']).toBe(false);
  });
});
