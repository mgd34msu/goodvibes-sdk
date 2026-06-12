/**
 * Tests for cursor-based pagination on daemon-sdk list endpoints.
 *
 * Coverage:
 * - paginateItems: first page + nextCursor + hasMore true/false
 * - paginateItems: cursor walk reaches all items exactly once, no duplicates
 * - paginateItems: insertion between pages doesn't duplicate/skip (stable id-based cursor)
 * - paginateItems: limit clamping via readBoundedPositiveInteger
 * - paginateItems: invalid cursor returns error sentinel
 * - paginateItems: deleted-cursor mid-walk uses createdAt to avoid restart-from-zero duplicates
 * - encodeCursor / decodeCursor: round-trip, tampering, missing id
 * - hasPaginationParams: detects limit/cursor in URL
 * - getAutomationJobs: backward-compat (no params), paginated path, limit clamping
 * - getAutomationRuns: backward-compat (no params), paginated path, limit clamping
 * - getIntegrationSessions: always returns snapshot (pagination not implemented in daemon-sdk)
 * - knowledge sources: backward-compat and paginated path (via handleGetKnowledgeSources)
 * - knowledge nodes: backward-compat and paginated path (via handleGetKnowledgeNodes)
 */

import { describe, expect, test } from 'bun:test';
import {
  encodeCursor,
  decodeCursor,
  hasPaginationParams,
  paginateItems,
} from '../packages/daemon-sdk/dist/index.js';
import { createDaemonRuntimeAutomationRouteHandlers } from '../packages/daemon-sdk/dist/index.js';
import { createDaemonIntegrationRouteHandlers } from '../packages/daemon-sdk/dist/index.js';
import { createDaemonKnowledgeRouteHandlers } from '../packages/daemon-sdk/dist/index.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/dist/index.js';
import type { DaemonIntegrationRouteContext } from '../packages/daemon-sdk/dist/index.js';
import type { DaemonKnowledgeRouteContext } from '../packages/daemon-sdk/dist/index.js';

// ============================================================
// Cursor encode / decode
// ============================================================

describe('encodeCursor / decodeCursor', () => {
  test('round-trips id only', () => {
    const cursor = encodeCursor('abc-123');
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('abc-123');
    expect(decoded!.createdAt).toBeUndefined();
  });

  test('round-trips id + createdAt', () => {
    const cursor = encodeCursor('xyz', 1_700_000_000_000);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('xyz');
    expect(decoded!.createdAt).toBe(1_700_000_000_000);
  });

  test('returns null for empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });

  test('returns null for arbitrary garbage', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  test('returns null when id is missing from payload', () => {
    // base64url-encode a JSON without an id field
    const noId = Buffer.from(JSON.stringify({ createdAt: 123 }), 'utf8').toString('base64url');
    expect(decodeCursor(noId)).toBeNull();
  });

  test('cursor is base64url-safe (no +, /, =)', () => {
    const cursor = encodeCursor('some-id-that-exercises-encoding', 1234567890);
    expect(cursor).not.toMatch(/[+/=]/);
  });
});

// ============================================================
// hasPaginationParams
// ============================================================

describe('hasPaginationParams', () => {
  test('returns false with no params', () => {
    expect(hasPaginationParams(new URL('http://localhost/api/foo'))).toBe(false);
  });

  test('returns true with ?limit=', () => {
    expect(hasPaginationParams(new URL('http://localhost/api/foo?limit=10'))).toBe(true);
  });

  test('returns true with ?cursor=', () => {
    expect(hasPaginationParams(new URL('http://localhost/api/foo?cursor=abc'))).toBe(true);
  });

  test('returns true with both params', () => {
    expect(hasPaginationParams(new URL('http://localhost/api/foo?limit=5&cursor=abc'))).toBe(true);
  });

  test('returns false with unrelated params', () => {
    expect(hasPaginationParams(new URL('http://localhost/api/foo?filter=x'))).toBe(false);
  });
});

// ============================================================
// paginateItems
// ============================================================

const makeItems = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}`, createdAt: (i + 1) * 1000 }));

describe('paginateItems', () => {
  test('first page — hasMore false when items fit within limit', () => {
    const items = makeItems(3);
    const result = paginateItems(items, 5, null, (x) => x.id);
    if ('error' in result) throw new Error(result.error);
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test('first page — hasMore true and nextCursor set when more remain', () => {
    const items = makeItems(10);
    const result = paginateItems(items, 3, null, (x) => x.id);
    if ('error' in result) throw new Error(result.error);
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeDefined();
    expect(result.items.map((x) => x.id)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  test('cursor walk reaches all items exactly once, no duplicates', () => {
    const items = makeItems(10);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    // page through 3 items at a time
    while (pages < 20) {
      const result = paginateItems(items, 3, cursor, (x) => x.id);
      if ('error' in result) throw new Error(result.error);
      for (const item of result.items) {
        seen.push(item.id);
      }
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
      pages++;
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10); // no duplicates
    expect(seen).toEqual(items.map((x) => x.id));
  });

  test('cursor is stable when item is inserted before cursor position', () => {
    // Start with 6 items; page 1 returns items 1-3, cursor points at item-3.
    // Insert item-0 at the front. Page 2 should still start after item-3.
    const original = makeItems(6);
    const page1 = paginateItems(original, 3, null, (x) => x.id);
    if ('error' in page1) throw new Error(page1.error);
    expect(page1.nextCursor).toBeDefined();

    const withInsertion = [{ id: 'item-0', createdAt: 0 }, ...original];
    const page2 = paginateItems(withInsertion, 3, page1.nextCursor!, (x) => x.id);
    if ('error' in page2) throw new Error(page2.error);
    // item-4, item-5, item-6 should appear — item-0 (before cursor) is not re-shown
    expect(page2.items.map((x) => x.id)).toEqual(['item-4', 'item-5', 'item-6']);
    expect(page2.hasMore).toBe(false);
  });

  test('invalid cursor returns error sentinel', () => {
    const items = makeItems(5);
    const result = paginateItems(items, 5, 'totally-invalid-cursor', (x) => x.id);
    expect('error' in result).toBe(true);
  });

  test('empty items list returns empty page, hasMore false', () => {
    const result = paginateItems([], 10, null, (x: { id: string; createdAt: number }) => x.id);
    if ('error' in result) throw new Error(result.error);
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test('deleted-cursor mid-walk: with createdAt falls to insertion point, no duplicates (m3/m4)', () => {
    // 8 items sorted by createdAt. Page 1: items 1-3 (cursor encodes id=item-3, createdAt=3000).
    // item-3 is then deleted from the list. Page 2 should start from item-4 (first createdAt > 3000).
    const items = makeItems(8);
    const page1 = paginateItems(items, 3, null, (x) => x.id, (x) => x.createdAt);
    if ('error' in page1) throw new Error(page1.error);
    expect(page1.nextCursor).toBeDefined();

    // Simulate item-3 deleted from store
    const itemsAfterDelete = items.filter((x) => x.id !== 'item-3');
    // page2: should resume from item-4 onwards, not restart from item-1
    const page2 = paginateItems(
      itemsAfterDelete,
      3,
      page1.nextCursor!,
      (x) => x.id,
      (x) => x.createdAt,
    );
    if ('error' in page2) throw new Error(page2.error);
    // No duplicates: item-1, item-2 were already seen; item-4, item-5, item-6 expected
    expect(page2.items.map((x) => x.id)).toEqual(['item-4', 'item-5', 'item-6']);
    expect(page2.hasMore).toBe(true);
  });

  test('deleted-cursor mid-walk: without createdAt falls back to index 0 (legacy behavior)', () => {
    // Without getCreatedAt supplied, missing id means startIndex=0
    const items = makeItems(5);
    const cursor = encodeCursor('item-2'); // id-only cursor, no createdAt
    const withoutItem2 = items.filter((x) => x.id !== 'item-2');
    const result = paginateItems(withoutItem2, 3, cursor, (x) => x.id);
    if ('error' in result) throw new Error(result.error);
    // Falls back to 0 — items 1, 3, 4 (first three)
    expect(result.items.map((x) => x.id)).toEqual(['item-1', 'item-3', 'item-4']);
  });
});

// ============================================================
// Automation route handlers
// ============================================================

function makeAutomationContext(
  jobs: Array<{ id: string }> = [],
  runs: Array<{ id: string; jobId: string; status: string; queuedAt: number }> = [],
): DaemonRuntimeRouteContext {
  // Minimal stub — only methods needed for getAutomationJobs/Runs
  return {
    automationManager: {
      listJobs: () => jobs,
      listRuns: () => runs,
      getRun: () => null,
      triggerHeartbeat: async () => ({}),
      cancelRun: async () => null,
      retryRun: async () => ({}),
      createJob: async () => ({ id: 'new-job' }),
      updateJob: async () => null,
      removeJob: async () => undefined,
      setEnabled: async () => null,
      runNow: async () => ({ id: 'r1', status: 'queued' }),
      getSchedulerCapacity: () => ({ slotsTotal: 4, slotsInUse: 0, queueDepth: 0, oldestQueuedAgeMs: null }),
    },
    parseJsonBody: async (req) => { const j = await req.json(); return j as Record<string, unknown>; },
    parseOptionalJsonBody: async () => null,
    recordApiResponse: (_req, _path, res) => res,
    requireAdmin: () => null,
    snapshotMetrics: () => ({}),
    sessionBroker: {
      start: async () => undefined,
      submitMessage: async () => ({ mode: 'rejected', input: { id: '' }, session: { id: '', status: '' } }),
      steerMessage: async () => ({ mode: 'rejected', input: { id: '', state: '' }, session: { id: '', status: '' } }),
      followUpMessage: async () => ({ mode: 'rejected', input: { id: '', state: '' }, session: { id: '', status: '' } }),
      bindAgent: async () => undefined,
      createSession: async () => ({ id: '' }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async () => null,
      completeAgent: async () => undefined,
      appendCompanionMessage: async () => undefined,
    },
    agentManager: { getStatus: () => null, cancel: () => undefined },
    normalizeAtSchedule: () => ({}),
    normalizeEverySchedule: () => ({}),
    normalizeCronSchedule: () => ({}),
    routeBindings: { start: async () => undefined, getBinding: () => undefined },
    trySpawnAgent: () => new Response(null, { status: 503 }),
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => undefined,
    syncFinishedAgentTask: () => undefined,
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => undefined,
    openSessionEventStream: () => new Response(null, { status: 200 }),
  } as unknown as DaemonRuntimeRouteContext;
}

describe('getAutomationJobs', () => {
  test('backward-compat: no params returns {jobs} array', async () => {
    const jobs = [{ id: 'j1' }, { id: 'j2' }];
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const response = await handlers.getAutomationJobs();
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.jobs)).toBe(true);
    expect((body.jobs as Array<unknown>)).toHaveLength(2);
    expect(body.items).toBeUndefined(); // not paginated envelope
  });

  test('with ?limit=1: returns paginated envelope, hasMore true', async () => {
    const jobs = [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }];
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=1');
    const response = await handlers.getAutomationJobs(url);
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as Array<unknown>)).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  test('invalid cursor returns 400', async () => {
    const jobs = [{ id: 'j1' }];
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=10&cursor=garbage');
    const response = await handlers.getAutomationJobs(url);
    expect(response.status).toBe(400);
  });

  test('cursor walk traverses all jobs exactly once', async () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({ id: `j${i + 1}` }));
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const seen: string[] = [];
    let nextCursor: string | undefined;
    let iterations = 0;
    do {
      const urlStr = `http://localhost/api/automation/jobs?limit=3${nextCursor ? `&cursor=${nextCursor}` : ''}`;
      const response = await handlers.getAutomationJobs(new URL(urlStr));
      const body = await response.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
      for (const item of body.items) seen.push(item.id);
      nextCursor = body.nextCursor;
      iterations++;
    } while (nextCursor && iterations < 20);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  test('last page: hasMore false, no nextCursor', async () => {
    const jobs = [{ id: 'j1' }, { id: 'j2' }];
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=10');
    const response = await handlers.getAutomationJobs(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string };
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  test('limit=99999 clamped to MAX (500)', async () => {
    // Provide 501 jobs so the cap is observable
    const jobs = Array.from({ length: 501 }, (_, i) => ({ id: `j${i + 1}` }));
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=99999');
    const response = await handlers.getAutomationJobs(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean };
    // Should be capped at 500
    expect((body.items as Array<unknown>).length).toBe(500);
    expect(body.hasMore).toBe(true);
  });

  test('limit=0 clamps to min (1)', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `j${i + 1}` }));
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=0');
    const response = await handlers.getAutomationJobs(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean };
    // 0 is below min=1 -> clamped to 1
    expect((body.items as Array<unknown>).length).toBe(1);
    expect(body.hasMore).toBe(true);
  });

  test('limit=abc uses default (100)', async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `j${i + 1}` }));
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext(jobs));
    const url = new URL('http://localhost/api/automation/jobs?limit=abc');
    const response = await handlers.getAutomationJobs(url);
    const body = await response.json() as { items: unknown[] };
    expect((body.items as Array<unknown>).length).toBe(50);
  });
});

describe('getAutomationRuns', () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r${i + 1}`, jobId: 'j1', status: 'completed', queuedAt: i }));

  test('backward-compat: no params returns {runs} array', async () => {
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext([], runs));
    const response = await handlers.getAutomationRuns();
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.items).toBeUndefined();
  });

  test('with ?limit=2: paginated response', async () => {
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext([], runs));
    const url = new URL('http://localhost/api/automation/runs?limit=2');
    const response = await handlers.getAutomationRuns(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean };
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(true);
  });

  test('invalid cursor returns 400', async () => {
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext([], runs));
    const url = new URL('http://localhost/api/automation/runs?limit=2&cursor=bad');
    const response = await handlers.getAutomationRuns(url);
    expect(response.status).toBe(400);
  });

  test('limit=-5 clamps to min (1)', async () => {
    const handlers = createDaemonRuntimeAutomationRouteHandlers(makeAutomationContext([], runs));
    const url = new URL('http://localhost/api/automation/runs?limit=-5');
    const response = await handlers.getAutomationRuns(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean };
    // -5 is below min=1 -> clamped to 1
    expect((body.items as Array<unknown>).length).toBe(1);
    expect(body.hasMore).toBe(true);
  });

  test('mid-walk deletion: descending order — no duplicate, no skip', async () => {
    // Runs sorted descending by queuedAt (newest-first), matching sortRuns production behavior.
    // queuedAt: 50, 40, 30, 20, 10
    const descRuns = [
      { id: 'r50', jobId: 'j1', status: 'completed', queuedAt: 50 },
      { id: 'r40', jobId: 'j1', status: 'completed', queuedAt: 40 },
      { id: 'r30', jobId: 'j1', status: 'completed', queuedAt: 30 },
      { id: 'r20', jobId: 'j1', status: 'completed', queuedAt: 20 },
      { id: 'r10', jobId: 'j1', status: 'completed', queuedAt: 10 },
    ];

    // Encode a cursor at the item with queuedAt=30 (position 2 in descending order).
    const cursor = encodeCursor('r30', 30);

    // Simulate mid-walk deletion: remove r30 from the store.
    const afterDeletion = descRuns.filter((r) => r.id !== 'r30');

    // Context returns runs pre-sorted descending (matches production sortRuns output).
    const ctx = makeAutomationContext([], afterDeletion);
    // Override listRuns to return already-sorted descending (no re-sort needed).
    (ctx.automationManager as unknown as Record<string, unknown>).listRuns =
      () => [...afterDeletion].sort((a, b) => b.queuedAt - a.queuedAt);

    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);
    const url = new URL(`http://localhost/api/automation/runs?limit=5&cursor=${cursor}`);
    const response = await handlers.getAutomationRuns(url);
    const body = await response.json() as { items: Array<{ id: string; queuedAt: number }>; hasMore: boolean };

    const ids = body.items.map((r) => r.id);
    // r50 and r40 must NOT reappear (no duplicate / backward drift)
    expect(ids).not.toContain('r50');
    expect(ids).not.toContain('r40');
    // r20 must be next (no skip forward)
    expect(ids[0]).toBe('r20');
    // r10 follows
    expect(ids).toContain('r10');
    // r30 was deleted — should not appear
    expect(ids).not.toContain('r30');
  });
});

// ============================================================
// Integration sessions route (no pagination in daemon-sdk)
// ============================================================

function makeIntegrationContext(
  sessions: unknown = { sessions: [] },
): DaemonIntegrationRouteContext {
  return {
    integrationHelpers: {
      buildReview: () => ({}),
      getSessionSnapshot: () => ({}),
      getTaskSnapshot: () => ({}),
      getAutomationSnapshot: () => ({}),
      getSessionBrokerSnapshot: () => sessions,
      getDeliverySnapshot: () => ({}),
      getRouteSnapshot: () => ({}),
      getRemoteSnapshot: () => ({}),
      getHealthSnapshot: () => ({}),
      getAccountsSnapshot: async () => ({}),
      getSettingsSnapshot: () => ({}),
      getSecuritySettingsReport: () => ({}),
      getContinuitySnapshot: () => ({}),
      getWorktreeSnapshot: () => ({}),
      getIntelligenceSnapshot: () => ({}),
      getLocalAuthSnapshot: () => ({}),
      listPanels: () => [],
      openPanel: () => false,
      createEventStream: () => new Response(null, { status: 200 }),
      getRuntimeStore: () => null,
    },
    channelPlugins: { listAccounts: async () => [] },
    memoryEmbeddingRegistry: { setDefaultProvider: () => undefined },
    memoryRegistry: {
      doctor: async () => ({}),
      vectorStats: () => ({}),
      rebuildVectorsAsync: async () => ({}),
      reviewQueue: () => [],
    },
    parseJsonBody: async (req) => { const j = await req.json(); return j as Record<string, unknown>; },
    providerRuntime: {
      listSnapshots: async () => [],
      getSnapshot: async () => null,
      getUsageSnapshot: async () => null,
    },
    requireAdmin: () => null,
    userAuth: {
      addUser: () => ({}),
      deleteUser: () => false,
      rotatePassword: () => undefined,
      revokeSession: () => false,
      clearBootstrapCredentialFile: () => false,
    },
  } as unknown as DaemonIntegrationRouteContext;
}

describe('getIntegrationSessions', () => {
  test('no params: returns session broker snapshot', async () => {
    const expected = { sessions: [{ id: 's1' }] };
    const handlers = createDaemonIntegrationRouteHandlers(makeIntegrationContext(expected));
    const response = await handlers.getIntegrationSessions();
    const body = await response.json();
    expect(body).toEqual(expected);
  });

  test('with ?limit=10: still returns session broker snapshot (no pagination in daemon-sdk)', async () => {
    const expected = { sessions: [{ id: 's1' }] };
    const handlers = createDaemonIntegrationRouteHandlers(makeIntegrationContext(expected));
    const url = new URL('http://localhost/api/sessions?limit=10');
    const response = await handlers.getIntegrationSessions(url);
    const body = await response.json();
    // Returns snapshot, not PaginatedResponse envelope
    expect(body).toEqual(expected);
    expect((body as Record<string, unknown>).items).toBeUndefined();
  });

  test('without helper: returns 503', async () => {
    const ctx = makeIntegrationContext();
    (ctx as unknown as Record<string, unknown>).integrationHelpers = null;
    const handlers = createDaemonIntegrationRouteHandlers(ctx);
    const response = await handlers.getIntegrationSessions();
    expect(response.status).toBe(503);
  });
});

// ============================================================
// Knowledge route handlers
// ============================================================

function makeKnowledgeItems(count: number): Array<{ id: string; name: string }> {
  return Array.from({ length: count }, (_, i) => ({ id: `k${i + 1}`, name: `item ${i + 1}` }));
}

/**
 * Knowledge items with updatedAt timestamps, sorted descending (newest-first by updatedAt),
 * matching the store's byUpdatedAtDesc sort order.
 * k1 has the highest updatedAt (most recently updated); kN has the lowest.
 *
 * createdAt is intentionally set to a DIFFERENT order (ascending) so that tests
 * can prove recovery keys on updatedAt, not createdAt.
 */
function makeKnowledgeItemsWithTs(
  count: number,
): Array<{ id: string; name: string; updatedAt: number; createdAt: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `k${i + 1}`,
    name: `item ${i + 1}`,
    // updatedAt descending: k1 = count*1000 (newest), kN = 1000 (oldest) — matches byUpdatedAtDesc
    updatedAt: (count - i) * 1000,
    // createdAt ascending (OPPOSITE order) — proves cursor keys on updatedAt, not createdAt
    createdAt: (i + 1) * 100,
  }));
}

function makeKnowledgeContext(
  sources: unknown[] = [],
  nodes: unknown[] = [],
): DaemonKnowledgeRouteContext {
  return {
    knowledgeService: {
      querySources: ({ limit }: { limit?: number }) => ({
        total: sources.length,
        items: sources.slice(0, limit ?? sources.length),
      }),
      queryNodes: ({ limit }: { limit?: number }) => ({
        total: nodes.length,
        items: nodes.slice(0, limit ?? nodes.length),
      }),
      // Stub out everything else
      queryItem: () => null,
      getSource: () => null,
      getNode: () => null,
      ingest: async () => ({ id: 'new' }),
      deleteSource: async () => undefined,
      deleteNode: async () => undefined,
      runJob: async () => ({}),
      getJobStatus: () => null,
      listJobs: () => [],
      search: async () => ({ results: [] }),
      ask: async () => ({ answer: '' }),
      packet: async () => ({ items: [] }),
      getSpaces: () => [],
      createSpace: async () => ({ id: 'sp1' }),
      updateSpace: async () => null,
      deleteSpace: async () => undefined,
      getCandidate: () => null,
      listCandidates: () => [],
      updateCandidateStatus: async () => null,
      createProjection: async () => ({ id: 'proj1' }),
      listProjections: () => [],
      deleteProjection: async () => undefined,
      getUsageStats: () => ({}),
      getRefinementSuggestions: async () => [],
      applyRefinement: async () => ({}),
    },
    knowledgeSpaceRegistry: {
      listSpaces: () => [],
      getDefaultSpace: () => null,
    },
    parseJsonBody: async (req) => { const j = await req.json(); return j as Record<string, unknown>; },
    requireAdmin: () => null,
    fetchOptions: {},
    artifactStore: null,
  } as unknown as DaemonKnowledgeRouteContext;
}

describe('knowledge sources — getKnowledgeSources', () => {
  test('backward-compat: no params returns {sources} array', async () => {
    const sources = makeKnowledgeItems(3);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(sources));
    const url = new URL('http://localhost/api/knowledge/sources');
    const response = await handlers.getKnowledgeSources(url);
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.items).toBeUndefined();
  });

  test('with ?limit=2: returns paginated envelope, hasMore true', async () => {
    const sources = makeKnowledgeItems(5);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(sources));
    const url = new URL('http://localhost/api/knowledge/sources?limit=2');
    const response = await handlers.getKnowledgeSources(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string };
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  test('invalid cursor returns 400', async () => {
    const sources = makeKnowledgeItems(3);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(sources));
    const url = new URL('http://localhost/api/knowledge/sources?limit=2&cursor=bad');
    const response = await handlers.getKnowledgeSources(url);
    expect(response.status).toBe(400);
  });

  test('cursor walk traverses all sources exactly once', async () => {
    const sources = makeKnowledgeItems(7);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(sources));
    const seen: string[] = [];
    let nextCursor: string | undefined;
    let iterations = 0;
    do {
      const urlStr = `http://localhost/api/knowledge/sources?limit=3${nextCursor ? `&cursor=${nextCursor}` : ''}`;
      const response = await handlers.getKnowledgeSources(new URL(urlStr));
      const body = await response.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
      for (const item of body.items) seen.push(item.id);
      nextCursor = body.nextCursor;
      iterations++;
    } while (nextCursor && iterations < 20);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('knowledge sources — mid-walk deletion recovery', () => {
  test('deleted cursor item: recovery resumes from insertion point via updatedAt, no duplicates (descending order)', async () => {
    // 8 items sorted descending by updatedAt: k1=8000, k2=7000, ..., k8=1000.
    // createdAt is in ASCENDING order (100, 200, ...) — opposite of updatedAt — so this
    // test will FAIL if the extractor reads createdAt and PASS only when it reads updatedAt.
    // Page 1 (limit=3): k1, k2, k3. cursor encodes id=k3, updatedAt=6000.
    // k3 deleted. Page 2 must resume from k4 (first item with updatedAt < 6000).
    const items = makeKnowledgeItemsWithTs(8);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(items));

    // Walk page 1
    const resp1 = await handlers.getKnowledgeSources(new URL('http://localhost/api/knowledge/sources?limit=3'));
    const page1 = await resp1.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(page1.items.map((x) => x.id)).toEqual(['k1', 'k2', 'k3']);
    expect(page1.nextCursor).toBeDefined();

    // Simulate k3 deleted from store
    const itemsAfterDelete = items.filter((x) => x.id !== 'k3');
    const handlersAfterDelete = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(itemsAfterDelete));

    // Walk page 2 — must get k4, k5, k6; must NOT restart from k1/k2
    // (with old createdAt extractor: createdAt order is ascending so cursor's recorded value
    //  would be k3.createdAt=300 and scan would land at wrong position — this assertion catches it)
    const urlStr = `http://localhost/api/knowledge/sources?limit=3&cursor=${page1.nextCursor!}`;
    const resp2 = await handlersAfterDelete.getKnowledgeSources(new URL(urlStr));
    const page2 = await resp2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(page2.items.map((x) => x.id)).toEqual(['k4', 'k5', 'k6']);
    expect(page2.hasMore).toBe(true); // k7, k8 remain
    // Decisive: k1, k2 must NOT appear — any duplicate means createdAt-keyed recovery misfired
    expect(page2.items.every((x) => x.id !== 'k1' && x.id !== 'k2')).toBe(true);
  });

  test('mid-walk UPDATE: updated item moves to front, subsequent pages skip it (no crash, documented behavior)', async () => {
    // Items sorted descending by updatedAt: k1=8000 ... k8=1000.
    // Page 1 (limit=3): k1, k2, k3. cursor encodes k3's updatedAt=6000.
    // k5 is then updated (gains updatedAt=9000), moving it to front of the list.
    // Store now: k5(9000), k1(8000), k2(7000), k3(6000), k4(5000), k6(3000), k7(2000), k8(1000).
    // Page 2 cursor targets updatedAt < 6000 -> starts from k4.
    // k5 has already moved past the cursor boundary so it will NOT appear in remaining pages.
    // This matches documented behavior: mid-walk update = old position vanishes like a deletion.
    const items = makeKnowledgeItemsWithTs(8);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(items));

    const resp1 = await handlers.getKnowledgeSources(new URL('http://localhost/api/knowledge/sources?limit=3'));
    const page1 = await resp1.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(page1.items.map((x) => x.id)).toEqual(['k1', 'k2', 'k3']);
    expect(page1.nextCursor).toBeDefined();

    // Simulate k5 updated: updatedAt bumped to 9000, moves to front
    const itemsAfterUpdate = items
      .map((x) => x.id === 'k5' ? { ...x, updatedAt: 9000 } : x)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const handlersAfterUpdate = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext(itemsAfterUpdate));

    const urlStr = `http://localhost/api/knowledge/sources?limit=3&cursor=${page1.nextCursor!}`;
    const resp2 = await handlersAfterUpdate.getKnowledgeSources(new URL(urlStr));
    const page2 = await resp2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    // Page 2 should not crash and must not duplicate k1/k2/k3 from page 1
    expect(resp2.status).toBe(200);
    const page2Ids = page2.items.map((x) => x.id);
    expect(page2Ids.includes('k1')).toBe(false);
    expect(page2Ids.includes('k2')).toBe(false);
    expect(page2Ids.includes('k3')).toBe(false);
    // k4 must be in page 2 (updatedAt=5000 < cursor's 6000 — first item past boundary)
    expect(page2Ids[0]).toBe('k4');
  });
});

describe('knowledge nodes — getKnowledgeNodes', () => {
  test('backward-compat: no params returns {nodes} array', async () => {
    const nodes = makeKnowledgeItems(3);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], nodes));
    const url = new URL('http://localhost/api/knowledge/nodes');
    const response = await handlers.getKnowledgeNodes(url);
    const body = await response.json() as Record<string, unknown>;
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.items).toBeUndefined();
  });

  test('with ?limit=2: returns paginated envelope, hasMore true', async () => {
    const nodes = makeKnowledgeItems(5);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], nodes));
    const url = new URL('http://localhost/api/knowledge/nodes?limit=2');
    const response = await handlers.getKnowledgeNodes(url);
    const body = await response.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string };
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe('string');
  });

  test('invalid cursor returns 400', async () => {
    const nodes = makeKnowledgeItems(3);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], nodes));
    const url = new URL('http://localhost/api/knowledge/nodes?limit=2&cursor=bad');
    const response = await handlers.getKnowledgeNodes(url);
    expect(response.status).toBe(400);
  });

  test('cursor walk traverses all nodes exactly once', async () => {
    const nodes = makeKnowledgeItems(7);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], nodes));
    const seen: string[] = [];
    let nextCursor: string | undefined;
    let iterations = 0;
    do {
      const urlStr = `http://localhost/api/knowledge/nodes?limit=3${nextCursor ? `&cursor=${nextCursor}` : ''}`;
      const response = await handlers.getKnowledgeNodes(new URL(urlStr));
      const body = await response.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
      for (const item of body.items) seen.push(item.id);
      nextCursor = body.nextCursor;
      iterations++;
    } while (nextCursor && iterations < 20);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('knowledge nodes — mid-walk deletion recovery', () => {
  test('deleted cursor item: recovery resumes from insertion point via updatedAt, no duplicates (descending order)', async () => {
    // 8 items sorted descending by updatedAt: k1=8000, k2=7000, ..., k8=1000.
    // createdAt is ASCENDING (100, 200, ...) — opposite of updatedAt — decisive test:
    // if extractor reads createdAt the insertion point will be wrong and the assertion fails.
    // Page 1 (limit=3): k1, k2, k3. cursor encodes id=k3, updatedAt=6000.
    // k3 deleted. Page 2 must resume from k4 (first item with updatedAt < 6000).
    const items = makeKnowledgeItemsWithTs(8);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], items));

    const resp1 = await handlers.getKnowledgeNodes(new URL('http://localhost/api/knowledge/nodes?limit=3'));
    const page1 = await resp1.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(page1.items.map((x) => x.id)).toEqual(['k1', 'k2', 'k3']);
    expect(page1.nextCursor).toBeDefined();

    // Simulate k3 deleted from store
    const itemsAfterDelete = items.filter((x) => x.id !== 'k3');
    const handlersAfterDelete = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], itemsAfterDelete));

    const urlStr = `http://localhost/api/knowledge/nodes?limit=3&cursor=${page1.nextCursor!}`;
    const resp2 = await handlersAfterDelete.getKnowledgeNodes(new URL(urlStr));
    const page2 = await resp2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    // Decisive: k4, k5, k6 — NOT k1/k2 (restart-from-zero) or wrong items (createdAt misfired)
    expect(page2.items.map((x) => x.id)).toEqual(['k4', 'k5', 'k6']);
    expect(page2.hasMore).toBe(true); // k7, k8 remain
    expect(page2.items.every((x) => x.id !== 'k1' && x.id !== 'k2')).toBe(true);
  });

  test('mid-walk UPDATE: updated node moves to front, subsequent pages skip it (no crash, documented behavior)', async () => {
    // Items sorted descending by updatedAt: k1=8000 ... k8=1000.
    // Page 1 (limit=3): k1, k2, k3. cursor encodes k3's updatedAt=6000.
    // k5 is then updated (gains updatedAt=9000), moving it to front.
    // Page 2 must not crash, must not contain k1/k2/k3 (duplicates), must start at k4.
    const items = makeKnowledgeItemsWithTs(8);
    const handlers = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], items));

    const resp1 = await handlers.getKnowledgeNodes(new URL('http://localhost/api/knowledge/nodes?limit=3'));
    const page1 = await resp1.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(page1.items.map((x) => x.id)).toEqual(['k1', 'k2', 'k3']);
    expect(page1.nextCursor).toBeDefined();

    // Simulate k5 updated: updatedAt bumped to 9000, re-sort list descending
    const itemsAfterUpdate = items
      .map((x) => x.id === 'k5' ? { ...x, updatedAt: 9000 } : x)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const handlersAfterUpdate = createDaemonKnowledgeRouteHandlers(makeKnowledgeContext([], itemsAfterUpdate));

    const urlStr = `http://localhost/api/knowledge/nodes?limit=3&cursor=${page1.nextCursor!}`;
    const resp2 = await handlersAfterUpdate.getKnowledgeNodes(new URL(urlStr));
    const page2 = await resp2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    expect(resp2.status).toBe(200);
    const page2Ids = page2.items.map((x) => x.id);
    expect(page2Ids.includes('k1')).toBe(false);
    expect(page2Ids.includes('k2')).toBe(false);
    expect(page2Ids.includes('k3')).toBe(false);
    // k4 is the first item with updatedAt (5000) < cursor boundary (6000)
    expect(page2Ids[0]).toBe('k4');
  });
});

describe('getAutomationRuns — mid-walk deletion recovery', () => {
  test('deleted cursor run: recovery resumes from insertion point via queuedAt, no duplicates', async () => {
    // 8 runs sorted DESCENDING by queuedAt (newest-first): r8=8000, r7=7000, ..., r1=1000.
    // This matches production sortRuns behavior.
    // Page 1 (limit=3): r8, r7, r6. cursor encodes id=r6, queuedAt=6000.
    // r6 deleted. Page 2 should resume from r5 (first run with queuedAt < 6000 in descending order).
    const runs = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i + 1}`,
      jobId: 'j1',
      status: 'completed',
      queuedAt: (i + 1) * 1000,
    }));
    // Supply runs pre-sorted descending to the handler (matching production sortRuns)
    const descRuns = [...runs].sort((a, b) => b.queuedAt - a.queuedAt);
    const ctx = makeAutomationContext([], descRuns);
    (ctx.automationManager as unknown as Record<string, unknown>).listRuns =
      () => [...descRuns];
    const handlers = createDaemonRuntimeAutomationRouteHandlers(ctx);

    const resp1 = await handlers.getAutomationRuns(new URL('http://localhost/api/automation/runs?limit=3'));
    const page1 = await resp1.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    // Descending: r8 (8000), r7 (7000), r6 (6000) are the first 3
    expect(page1.items.map((x) => x.id)).toEqual(['r8', 'r7', 'r6']);
    expect(page1.nextCursor).toBeDefined();

    // Simulate r6 deleted from store
    const runsAfterDelete = descRuns.filter((r) => r.id !== 'r6');
    const ctxAfterDelete = makeAutomationContext([], runsAfterDelete);
    (ctxAfterDelete.automationManager as unknown as Record<string, unknown>).listRuns =
      () => [...runsAfterDelete];
    const handlersAfterDelete = createDaemonRuntimeAutomationRouteHandlers(ctxAfterDelete);

    const urlStr = `http://localhost/api/automation/runs?limit=3&cursor=${page1.nextCursor!}`;
    const resp2 = await handlersAfterDelete.getAutomationRuns(new URL(urlStr));
    const page2 = await resp2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
    // r5 (5000), r4 (4000), r3 (3000) expected — not a restart from r8/r7
    expect(page2.items.map((x) => x.id)).toEqual(['r5', 'r4', 'r3']);
    expect(page2.hasMore).toBe(true); // r2, r1 remain
    expect(page2.items.every((x) => x.id !== 'r8' && x.id !== 'r7')).toBe(true);
  });
});
