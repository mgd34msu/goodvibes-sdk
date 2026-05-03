/**
 * B1 — Workspace swap re-root integration test.
 *
 * Verifies that WorkspaceSwapManager.requestSwap() calls the rerootStores callback
 * with the new path and that session writes after the swap go to the new workspace.
 *
 * Includes a real-services integration test (no mocks) that exercises MemoryStore
 * disk-level isolation between workspaces: writes before swap land in workspace1,
 * writes after swap land in workspace2, and workspace1 is not mutated post-swap.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceSwapManager } from '../packages/sdk/src/platform/workspace/workspace-swap-manager.ts';
import { MemoryStore } from '../packages/sdk/src/platform/state/memory-store.ts';
import { MemoryEmbeddingProviderRegistry } from '../packages/sdk/src/platform/state/memory-embeddings.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-reroot-${suffix}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// B1 — rerootStores is called with the new working directory
// ---------------------------------------------------------------------------

describe('WorkspaceSwapManager — rerootStores is called on swap', () => {
  let workspace1: string;
  let workspace2: string;
  let daemonHome: string;

  beforeEach(() => {
    workspace1 = tempDir('ws1');
    workspace2 = tempDir('ws2');
    daemonHome = tempDir('daemon');
  });

  afterEach(() => cleanup(workspace1, workspace2, daemonHome));

  test('requestSwap calls rerootStores with the new working dir', async () => {
    const rerootCalls: string[] = [];

    const mgr = new WorkspaceSwapManager(workspace1, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async (newDir) => {
        rerootCalls.push(newDir);
      },
    });

    const result = await mgr.requestSwap(workspace2);
    expect(result.ok).toBe(true);
    expect(rerootCalls).toEqual([workspace2]);
    expect(mgr.getCurrentWorkingDir()).toBe(workspace2);
  });

  test('requestSwap creates .goodvibes subdirs in the new workspace', async () => {
    const mgr = new WorkspaceSwapManager(workspace1, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {},
    });

    await mgr.requestSwap(workspace2);

    expect(existsSync(join(workspace2, '.goodvibes', 'sessions'))).toBe(true);
    expect(existsSync(join(workspace2, '.goodvibes', 'memory'))).toBe(true);
    expect(existsSync(join(workspace2, '.goodvibes', 'logs'))).toBe(true);
  });

  test('rerootStores throw causes swap to fail with INVALID_PATH', async () => {
    const mgr = new WorkspaceSwapManager(workspace1, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {
        throw new Error('simulated store failure');
      },
    });

    const result = await mgr.requestSwap(workspace2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PATH');
    }
    // Working dir must NOT have changed after failure
    expect(mgr.getCurrentWorkingDir()).toBe(workspace1);
  });

  test('concurrent swap: second call gets WORKSPACE_BUSY while first is in flight', async () => {
    let resolveReroot!: () => void;
    const rerootDone = new Promise<void>((res) => { resolveReroot = res; });

    const mgr = new WorkspaceSwapManager(workspace1, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async () => {
        // Hang until we release it
        await rerootDone;
      },
    });

    // Fire first swap — will hang in rerootStores
    const first = mgr.requestSwap(workspace2);
    // Fire second swap immediately — should be rejected as WORKSPACE_BUSY
    const second = await mgr.requestSwap(join(workspace1, 'other'));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('WORKSPACE_BUSY');
    }
    // Release the first and confirm it succeeds
    resolveReroot();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-services integration: MemoryStore disk isolation across workspace swap
// ---------------------------------------------------------------------------

describe('WorkspaceSwapManager — real MemoryStore disk isolation', () => {
  /**
   * Build a real MemoryEmbeddingProviderRegistry pre-loaded with the
   * built-in deterministic HASHED provider (no external API keys required).
   *
   * MemoryStore with enableVectorIndex: false never calls the registry for
   * embedding operations — the registry is held by reference but dormant.
   * Using a real registry here eliminates the need for any type-unsafe casts.
   */
  function makeEmbeddingRegistry(): MemoryEmbeddingProviderRegistry {
    // ConfigManager requires a configDir (absolute path). Use a temp dir that
    // will never be written to; we only need the registry for type correctness.
    // MemoryStore with enableVectorIndex: false never invokes embedding calls.
    const configManager = new ConfigManager({ configDir: tmpdir() });
    // HASHED_MEMORY_EMBEDDING_PROVIDER is registered automatically in the
    // constructor and is the default — no additional registration needed.
    return new MemoryEmbeddingProviderRegistry({ configManager });
  }

  test('real services: reroot closes store at A, reopens at B, data isolated on disk', async () => {
    const daemonHome = join(tmpdir(), `gv-reroot-dh-${Date.now()}-${crypto.randomUUID()}`);
    const workspace1 = join(tmpdir(), `gv-reroot-ws1-${Date.now()}-${crypto.randomUUID()}`);
    const workspace2 = join(tmpdir(), `gv-reroot-ws2-${Date.now()}-${crypto.randomUUID()}`);

    mkdirSync(join(workspace1, '.goodvibes', 'memory'), { recursive: true });
    mkdirSync(join(workspace2, '.goodvibes', 'memory'), { recursive: true });
    mkdirSync(daemonHome, { recursive: true });

    const ws1DbPath = join(workspace1, '.goodvibes', 'memory.sqlite');
    const ws2DbPath = join(workspace2, '.goodvibes', 'memory.sqlite');

    // Boot a real MemoryStore at workspace1
    const memoryStore = new MemoryStore(ws1DbPath, {
      embeddingRegistry: makeEmbeddingRegistry(),
      enableVectorIndex: false,
    });
    await memoryStore.init();

    // Write a record to workspace1
    await memoryStore.add({
      cls: 'fact',
      summary: 'workspace1-record',
      tags: ['ws1'],
    });
    // Flush to disk
    await memoryStore.save();

    // workspace1 db file must exist on disk
    expect(existsSync(ws1DbPath)).toBe(true);

    // Snapshot workspace1 records before swap
    const ws1RecordsBefore = memoryStore.search();
    expect(ws1RecordsBefore.length).toBe(1);
    expect(ws1RecordsBefore[0].summary).toBe('workspace1-record');

    // Build swap manager that reroots the real MemoryStore
    const mgr = new WorkspaceSwapManager(workspace1, {
      runtimeBus: null,
      daemonHomeDir: daemonHome,
      getBusySessionCount: () => 0,
      rerootStores: async (newWorkingDir) => {
        const newDbPath = join(newWorkingDir, '.goodvibes', 'memory.sqlite');
        await memoryStore.reroot(newDbPath);
      },
    });

    // Perform the swap
    const result = await mgr.requestSwap(workspace2);
    expect(result.ok).toBe(true);

    // After swap: memoryStore is now backed by workspace2's SQLite
    // Write a new record — this must go to workspace2, NOT workspace1
    await memoryStore.add({
      cls: 'fact',
      summary: 'workspace2-record',
      tags: ['ws2'],
    });
    await memoryStore.save();

    // workspace2 db file must exist on disk
    expect(existsSync(ws2DbPath)).toBe(true);

    // workspace2 store has exactly the post-swap record
    const ws2Records = memoryStore.search();
    expect(ws2Records.length).toBe(1);
    expect(ws2Records[0].summary).toBe('workspace2-record');

    // workspace1 disk isolation: read the ws1 store directly from its file
    // to confirm the post-swap write did NOT land there
    const ws1Verify = new MemoryStore(ws1DbPath, {
      embeddingRegistry: makeEmbeddingRegistry(),
      enableVectorIndex: false,
    });
    await ws1Verify.init();
    const ws1RecordsAfter = ws1Verify.search();
    // workspace1 must still have exactly the pre-swap record (no post-swap write)
    expect(ws1RecordsAfter.length).toBe(1);
    expect(ws1RecordsAfter[0].summary).toBe('workspace1-record');
    ws1Verify.close();

    memoryStore.close();
    rmSync(daemonHome, { recursive: true, force: true });
    rmSync(workspace1, { recursive: true, force: true });
    rmSync(workspace2, { recursive: true, force: true });
  });
});
