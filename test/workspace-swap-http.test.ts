/**
 * B3 — HTTP integration test for POST /config runtime.workingDir.
 *
 * Uses the real route handler (createDaemonSystemRouteHandlers) wired with a
 * real WorkspaceSwapManager backed by tmp directories. No full DaemonServer
 * boot is required — we test at the route-handler layer.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDaemonSystemRouteHandlers,
} from '../packages/daemon-sdk/src/index.ts';
import { WorkspaceSwapManager } from '../packages/sdk/src/_internal/platform/workspace/workspace-swap-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-http-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const AUTH_TOKEN = 'test-token-b3';

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeSystemContext(daemonHome: string, workingDir: string, swapManager: WorkspaceSwapManager) {
  const fakeWatcherRegistry = {
    list: () => [],
    addWatcher: () => ({ id: 'w1' }),
    removeWatcher: () => true,
    getWatcher: () => null,
    updateWatcher: () => null,
    triggerWatcher: () => null,
  };
  return {
    approvalBroker: {
      listPending: () => [],
      approve: () => null,
      reject: () => null,
    },
    configManager: {
      get: (key: string) => {
        if (key === 'runtime.workingDir') return workingDir;
        return undefined;
      },
      set: async () => {},
      list: () => ({}),
    },
    integrationHelpers: {
      list: () => [],
      get: () => null,
      install: async () => ({}),
      uninstall: async () => ({}),
    },
    inspectInboundTls: () => ({ mode: 'off' }),
    inspectOutboundTls: () => ({ mode: 'system' }),
    isValidConfigKey: (_key: string) => true,
    parseJsonBody: async (req: Request) => {
      const body = await req.json();
      return body as Record<string, unknown>;
    },
    parseOptionalJsonBody: async (req: Request) => {
      try {
        return await req.json() as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    platformServiceManager: {
      status: () => ({}),
      install: () => ({}),
      start: () => ({}),
      stop: () => ({}),
      restart: () => ({}),
      uninstall: () => ({}),
    },
    requireAdmin: (_req: Request) => null,
    requireAuthenticatedSession: (_req: Request) => ({ username: 'admin', roles: ['admin'] }),
    routeBindings: {
      start: async () => {},
      stop: async () => {},
      list: () => [],
      find: () => null,
      bind: async () => ({}),
      unbind: async () => {},
      patch: async () => null,
      getBinding: () => null,
    },
    swapManager,
    watcherRegistry: fakeWatcherRegistry,
  };
}

// ---------------------------------------------------------------------------
// B3 tests
// ---------------------------------------------------------------------------

describe('POST /config runtime.workingDir — HTTP integration', () => {
  let daemonHome: string;
  let workingDir: string;

  beforeEach(() => {
    daemonHome = tempDir('daemon');
    workingDir = tempDir('work');
  });

  afterEach(() => cleanup(daemonHome, workingDir));

  test('POST /config with valid new dir returns 200 and persists to daemon-settings.json', async () => {
    const newDir = tempDir('newwork');
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });

    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: newDir });
    const handlers = createDaemonSystemRouteHandlers(ctx as Parameters<typeof createDaemonSystemRouteHandlers>[0], req);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(200);

    const settingsPath = join(daemonHome, 'daemon-settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings['runtime.workingDir']).toBe(newDir);
    cleanup(newDir);
  });

  test('POST /config with empty value returns 400 INVALID_PATH', async () => {
    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });
    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: '' });
    const handlers = createDaemonSystemRouteHandlers(ctx as Parameters<typeof createDaemonSystemRouteHandlers>[0], req);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PATH');
  });

  test('POST /config with a file path (not a dir) returns 400 INVALID_PATH', async () => {
    // Create a file at the target path so mkdir will fail
    const filePath = join(daemonHome, 'i-am-a-file.txt');
    writeFileSync(filePath, 'not a dir');

    const swapManager = new WorkspaceSwapManager(workingDir, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });
    const ctx = makeSystemContext(daemonHome, workingDir, swapManager);
    // request a subdir of a file — mkdir will fail
    const req = makeRequest('/api/config', { key: 'runtime.workingDir', value: join(filePath, 'subdir') });
    const handlers = createDaemonSystemRouteHandlers(ctx as Parameters<typeof createDaemonSystemRouteHandlers>[0], req);
    const response = await handlers.postConfig(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PATH');
  });
});
