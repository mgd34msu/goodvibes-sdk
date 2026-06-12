import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * Item 7 — reviewQueue scope filter
 *
 * Verifies that:
 * 1. MemoryStore.reviewQueue(limit) still works with no scope (backward compat).
 * 2. MemoryStore.reviewQueue(limit, scope) filters to only that scope.
 * 3. MemoryRegistry.reviewQueue(limit, scope) correctly delegates.
 * 4. scope filter applies BEFORE the limit slice — not post-fetch.
 * 5. The HTTP handler returns scoped results correctly (via integration-routes).
 */

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(root: string) {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
  return store;
}

describe('MemoryStore.reviewQueue scope filter (Item 7)', () => {
  test('no-scope call returns all scopes (backward compatible)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-compat-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    await store.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await store.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    await store.add({ scope: 'team',    cls: 'fact', summary: 'team record' });
    const all = store.reviewQueue(100);
    const scopes = all.map((r) => r.scope);
    expect(scopes).toContain('session');
    expect(scopes).toContain('project');
    expect(scopes).toContain('team');
  });

  test('scope=session returns only session records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-session-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    await store.add({ scope: 'session', cls: 'fact', summary: 'session record A' });
    await store.add({ scope: 'session', cls: 'fact', summary: 'session record B' });
    await store.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    await store.add({ scope: 'team',    cls: 'fact', summary: 'team record' });
    const result = store.reviewQueue(100, 'session');
    expect(result.length).toBe(2);
    expect(result.every((r) => r.scope === 'session')).toBe(true);
  });

  test('scope=project returns only project records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-project-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    await store.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await store.add({ scope: 'project', cls: 'fact', summary: 'project record A' });
    await store.add({ scope: 'project', cls: 'fact', summary: 'project record B' });
    await store.add({ scope: 'team',    cls: 'fact', summary: 'team record' });
    const result = store.reviewQueue(100, 'project');
    expect(result.length).toBe(2);
    expect(result.every((r) => r.scope === 'project')).toBe(true);
  });

  test('scope=team returns only team records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-team-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    await store.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await store.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    await store.add({ scope: 'team',    cls: 'fact', summary: 'team record X' });
    await store.add({ scope: 'team',    cls: 'fact', summary: 'team record Y' });
    const result = store.reviewQueue(100, 'team');
    expect(result.length).toBe(2);
    expect(result.every((r) => r.scope === 'team')).toBe(true);
  });

  test('limit applies within the filtered scope (not pre-filter population)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-limit-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    for (let i = 0; i < 5; i++) {
      await store.add({ scope: 'project', cls: 'fact', summary: `project record ${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await store.add({ scope: 'session', cls: 'fact', summary: `session record ${i}` });
    }
    // Request only 2 project records — should get exactly 2 project records
    const result = store.reviewQueue(2, 'project');
    expect(result.length).toBe(2);
    expect(result.every((r) => r.scope === 'project')).toBe(true);
  });

  test('scope filter on empty scope returns empty array', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-rq-scope-empty-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    await store.add({ scope: 'session', cls: 'fact', summary: 'session only' });
    const result = store.reviewQueue(10, 'team');
    expect(result).toEqual([]);
  });
});

describe('MemoryRegistry.reviewQueue scope filter (Item 7)', () => {
  test('backward compatible — no scope returns all scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-reg-rq-compat-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    const registry = new MemoryRegistry(store);
    await registry.add({ scope: 'session', cls: 'fact', summary: 'session' });
    await registry.add({ scope: 'project', cls: 'fact', summary: 'project' });
    const all = registry.reviewQueue(100);
    const scopes = all.map((r) => r.scope);
    expect(scopes).toContain('session');
    expect(scopes).toContain('project');
  });

  test('scope=session delegates correctly to store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-reg-rq-session-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    const registry = new MemoryRegistry(store);
    await registry.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await registry.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    const result = registry.reviewQueue(100, 'session');
    expect(result.length).toBe(1);
    expect(result[0]!.scope).toBe('session');
  });

  test('scope=project delegates correctly to store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-reg-rq-project-'));
    tmpRoots.push(root);
    const store = makeStore(root);
    await store.init();
    const registry = new MemoryRegistry(store);
    await registry.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await registry.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    const result = registry.reviewQueue(100, 'project');
    expect(result.length).toBe(1);
    expect(result[0]!.scope).toBe('project');
  });
});

describe('HTTP handler: GET /api/memory/review-queue (Item 7)', () => {
  async function makeHandlers(root: string) {
    const { createDaemonIntegrationRouteHandlers } = await import('../packages/daemon-sdk/src/integration-routes.js');
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const store = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await store.init();
    const memoryRegistry = new MemoryRegistry(store);
    // Minimal context stub
    const context = {
      memoryRegistry,
      memoryEmbeddingRegistry: { setDefaultProvider: () => {} },
      requireAdmin: () => null,
      parseJsonBody: async (req: Request) => req.json(),
      integrationHelpers: null,
      userAuth: null as unknown as never,
      channelPlugins: [] as unknown as never,
      runtimeStore: null,
      runtimeBus: null as unknown as never,
    };
    return { handlers: createDaemonIntegrationRouteHandlers(context as Parameters<typeof createDaemonIntegrationRouteHandlers>[0]), memoryRegistry };
  }

  test('returns all records with no scope query param', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-rq-all-'));
    tmpRoots.push(root);
    const { handlers, memoryRegistry } = await makeHandlers(root);
    await memoryRegistry.add({ scope: 'session', cls: 'fact', summary: 'session' });
    await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'project' });
    const url = new URL('http://localhost/api/memory/review-queue');
    const response = await handlers.getMemoryReviewQueue(url);
    expect(response.status).toBe(200);
    const body = await response.json() as { records: unknown[] };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(2);
  });

  test('scope=session query param returns only session records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-rq-session-'));
    tmpRoots.push(root);
    const { handlers, memoryRegistry } = await makeHandlers(root);
    await memoryRegistry.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'project record' });
    const url = new URL('http://localhost/api/memory/review-queue?scope=session');
    const response = await handlers.getMemoryReviewQueue(url);
    expect(response.status).toBe(200);
    const body = await response.json() as { records: Array<{ scope: string }> };
    expect(body.records.length).toBe(1);
    expect(body.records[0]!.scope).toBe('session');
  });

  test('scope=project query param returns only project records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-rq-project-'));
    tmpRoots.push(root);
    const { handlers, memoryRegistry } = await makeHandlers(root);
    await memoryRegistry.add({ scope: 'session', cls: 'fact', summary: 'session record' });
    await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'project record A' });
    await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'project record B' });
    const url = new URL('http://localhost/api/memory/review-queue?scope=project');
    const response = await handlers.getMemoryReviewQueue(url);
    expect(response.status).toBe(200);
    const body = await response.json() as { records: Array<{ scope: string }> };
    expect(body.records.length).toBe(2);
    expect(body.records.every((r) => r.scope === 'project')).toBe(true);
  });

  test('invalid scope value returns 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-rq-invalid-scope-'));
    tmpRoots.push(root);
    const { handlers, memoryRegistry } = await makeHandlers(root);
    await memoryRegistry.add({ scope: 'session', cls: 'fact', summary: 'session' });
    await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'project' });
    const url = new URL('http://localhost/api/memory/review-queue?scope=invalid');
    const response = await handlers.getMemoryReviewQueue(url);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  test('limit query param is honoured within scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-http-rq-limit-'));
    tmpRoots.push(root);
    const { handlers, memoryRegistry } = await makeHandlers(root);
    for (let i = 0; i < 5; i++) {
      await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: `project ${i}` });
    }
    const url = new URL('http://localhost/api/memory/review-queue?scope=project&limit=2');
    const response = await handlers.getMemoryReviewQueue(url);
    const body = await response.json() as { records: unknown[] };
    expect(body.records.length).toBe(2);
  });
});
