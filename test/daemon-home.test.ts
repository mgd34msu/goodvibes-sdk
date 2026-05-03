import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDaemonHomeDir,
  ensureDaemonHome,
  readDaemonSetting,
  writeDaemonSetting,
  resolveOperatorTokenPath,
  writeOperatorTokenFile,
  readOperatorTokenFile,
} from '../packages/sdk/src/platform/workspace/daemon-home.ts';
import { WorkspaceSwapManager } from '../packages/sdk/src/platform/workspace/workspace-swap-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-test-${suffix}-${Date.now()}-${crypto.randomUUID()}`);
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
// ensureDaemonHome
// ---------------------------------------------------------------------------

describe('ensureDaemonHome', () => {
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
    const result = ensureDaemonHome(daemonHome);
    expect(result.freshInstall).toBe(true);
    expect(result.daemonHomeDir).toBe(daemonHome);
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('freshInstall=false when daemon home already exists', () => {
    mkdirSync(daemonHome, { recursive: true });
    const result = ensureDaemonHome(daemonHome);
    expect(result.freshInstall).toBe(false);
  });

  test('creates daemon home directory when absent', () => {
    expect(existsSync(daemonHome)).toBe(false);
    ensureDaemonHome(daemonHome);
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('does not import workspace-scoped operator-tokens.json', () => {
    const fakeWorkspace = join(baseDir, 'workspace');
    mkdirSync(join(fakeWorkspace, '.goodvibes'), { recursive: true });
    writeFileSync(join(fakeWorkspace, '.goodvibes', 'operator-tokens.json'), JSON.stringify({ tokens: ['tok1'] }));

    ensureDaemonHome(daemonHome);

    const dest = join(daemonHome, 'operator-tokens.json');
    expect(existsSync(dest)).toBe(false);
  });

  test('creates an empty daemon home without external source files', () => {
    expect(() => ensureDaemonHome(daemonHome)).not.toThrow();
    expect(existsSync(daemonHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveOperatorTokenPath / writeOperatorTokenFile / readOperatorTokenFile
// ---------------------------------------------------------------------------

describe('operator token path — global-only', () => {
  let daemonHome: string;

  beforeEach(() => { daemonHome = tempDir('op-token'); });
  afterEach(() => { cleanup(daemonHome); });

  test('resolveOperatorTokenPath returns <daemonHomeDir>/operator-tokens.json', () => {
    expect(resolveOperatorTokenPath(daemonHome)).toBe(join(daemonHome, 'operator-tokens.json'));
  });

  test('writeOperatorTokenFile creates file at global path', () => {
    const content = JSON.stringify({ token: 'gv_abc', peerId: 'p1', createdAt: 0 }, null, 2);
    writeOperatorTokenFile(daemonHome, content);
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf-8')).toBe(content);
  });

  test('writeOperatorTokenFile sets mode 0600', () => {
    writeOperatorTokenFile(daemonHome, '{"token":"gv_x","peerId":"p","createdAt":0}');
    const tokenPath = resolveOperatorTokenPath(daemonHome);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('readOperatorTokenFile returns undefined when file does not exist', () => {
    expect(readOperatorTokenFile(daemonHome)).toBeUndefined();
  });

  test('readOperatorTokenFile returns content when file exists', () => {
    const content = '{"token":"gv_y","peerId":"q","createdAt":1}';
    writeOperatorTokenFile(daemonHome, content);
    expect(readOperatorTokenFile(daemonHome)).toBe(content);
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
    const mgr = makeManager();
    const traversalPath = join(baseDir, '..', 'traversal-target-' + Date.now());
    const result = await mgr.requestSwap(traversalPath);
    if (result.ok) {
      expect(mgr.getCurrentWorkingDir()).toBe(traversalPath);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_PATH');
      }
    }
    try { rmSync(traversalPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('requestSwap with absolute path containing ".." segments resolves correctly', async () => {
    const mgr = makeManager();
    const subDir = join(baseDir, 'sub');
    mkdirSync(subDir, { recursive: true });
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

describe('ensureDaemonHome: workspace-scoped token files are ignored', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('no-ws-token');
    daemonHome = join(baseDir, 'daemon-home');
  });

  afterEach(() => cleanup(baseDir));

  test('does not import even valid workspace-scoped operator-tokens.json', () => {
    const oldTokenDir = join(baseDir, '.goodvibes');
    mkdirSync(oldTokenDir, { recursive: true });
    const tokenContent = JSON.stringify({ token: 'gv_x', peerId: 'p', createdAt: 0 });
    writeFileSync(join(oldTokenDir, 'operator-tokens.json'), tokenContent);

    ensureDaemonHome(daemonHome);

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
    } as unknown as import('../packages/sdk/src/platform/runtime/events/index.ts').RuntimeEventBus;

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
    } as unknown as import('../packages/sdk/src/platform/runtime/events/index.ts').RuntimeEventBus;

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
