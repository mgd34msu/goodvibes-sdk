import { describe, expect, test } from 'bun:test';
import {
  MemorySpineClient,
  createLocalMemoryAccess,
  foldMemoryWireExtendedError,
  type MemoryTransport,
  type LocalMemoryStore,
} from '../packages/sdk/src/platform/runtime/memory-spine/index.js';
import { createTransportError } from '../packages/transport-http/src/http-core.ts';
import type { MemoryBundle, MemoryImportResult, MemoryLink, MemoryRecord, MemorySemanticSearchResult, MemoryVectorStats, MemoryDoctorReport } from '../packages/sdk/src/platform/state/index.js';
import type { HonestMemorySearchResult } from '../packages/sdk/src/platform/state/index.js';

/**
 * The memory-spine host-vs-client switch. A daemon host and any offline/embedded
 * surface read/write the LOCAL store directly; a surface that has adopted a daemon
 * routes every op THROUGH the wire and never touches its local store. Proves the
 * routing exclusivity that realizes the single-writer invariant, and that the
 * offline (local) fallback is unchanged.
 */

function record(summary: string): MemoryRecord {
  const now = Date.now();
  return {
    id: `mem_${summary}`, scope: 'project', cls: 'fact', summary,
    tags: [], provenance: [], reviewState: 'fresh', confidence: 60,
    createdAt: now, updatedAt: now,
  };
}

function honest(records: MemoryRecord[]): HonestMemorySearchResult {
  return {
    records, mode: 'literal', requestedSemantic: false, indexUnavailableReason: null,
    caveat: null, recallFiltered: false, excludedFlaggedCount: 0, excludedBelowFloorCount: 0,
    totalBeforeRecallFilter: records.length,
  };
}

const emptyBundle: MemoryBundle = { schemaVersion: 'v1', exportedAt: 0, scope: 'all', recordCount: 0, linkCount: 0, records: [], links: [] };
const emptyImport: MemoryImportResult = { importedRecords: 0, skippedRecords: 0, importedLinks: 0 };
const emptyStats = { backend: 'sqlite-vec', enabled: false, available: false, path: '', dimensions: 0, indexedRecords: 0, embeddingProviderId: 'x', embeddingProviderLabel: 'x' } as MemoryVectorStats;
const emptyDoctor = { vector: emptyStats, embeddings: {} as MemoryDoctorReport['embeddings'], checkedAt: 0 } as MemoryDoctorReport;

/** A local store spy that records every call so a test can prove it was NOT touched. */
function spyLocalStore(): { store: LocalMemoryStore; calls: string[] } {
  const calls: string[] = [];
  const store: LocalMemoryStore = {
    add: (opts) => { calls.push(`add:${opts.summary}`); return record(opts.summary); },
    honestSearch: () => { calls.push('search'); return honest([record('local-hit')]); },
    get: (id) => { calls.push(`get:${id}`); return record('local'); },
    review: (id) => { calls.push(`review:${id}`); return record('local'); },
    delete: (id) => { calls.push(`delete:${id}`); return true; },
    search: () => { calls.push('list'); return [record('local-list')]; },
    searchSemantic: () => { calls.push('searchSemantic'); return []; },
    update: (id) => { calls.push(`update:${id}`); return record('local'); },
    link: (fromId, toId) => { calls.push(`link:${fromId}->${toId}`); return null; },
    linksFor: (id) => { calls.push(`linksFor:${id}`); return []; },
    reviewQueue: () => { calls.push('reviewQueue'); return []; },
    exportBundle: () => { calls.push('exportBundle'); return emptyBundle; },
    importBundle: () => { calls.push('importBundle'); return emptyImport; },
    vectorStats: () => { calls.push('vectorStats'); return emptyStats; },
    doctor: () => { calls.push('doctor'); return emptyDoctor; },
  };
  return { store, calls };
}

/** A wire transport spy exposing the five CORE verbs only (an older/pinned adapter). */
function spyTransport(): { transport: MemoryTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: MemoryTransport = {
    add: (opts) => { calls.push(`add:${opts.summary}`); return Promise.resolve(record(`wire-${opts.summary}`)); },
    honestSearch: () => { calls.push('search'); return Promise.resolve(honest([record('wire-hit')])); },
    get: (id) => { calls.push(`get:${id}`); return Promise.resolve(record('wire')); },
    updateReview: (id) => { calls.push(`review:${id}`); return Promise.resolve(record('wire')); },
    delete: (id) => { calls.push(`delete:${id}`); return Promise.resolve(true); },
  };
  return { transport, calls };
}

/** A wire transport spy exposing the FULL catalog (a current daemon). */
function spyFullTransport(): { transport: MemoryTransport; calls: string[] } {
  const base = spyTransport();
  const calls = base.calls;
  const link: MemoryLink = { fromId: 'a', toId: 'b', relation: 'r', createdAt: 0 };
  const semantic: MemorySemanticSearchResult = { record: record('wire-sem'), distance: 0, similarity: 1, score: 100 };
  const transport: MemoryTransport = {
    ...base.transport,
    list: () => { calls.push('list'); return Promise.resolve([record('wire-list')]); },
    searchSemantic: () => { calls.push('searchSemantic'); return Promise.resolve([semantic]); },
    update: (id) => { calls.push(`update:${id}`); return Promise.resolve(record('wire')); },
    link: (fromId, toId) => { calls.push(`link:${fromId}->${toId}`); return Promise.resolve(link); },
    linksFor: (id) => { calls.push(`linksFor:${id}`); return Promise.resolve([link]); },
    reviewQueue: () => { calls.push('reviewQueue'); return Promise.resolve([record('wire-queue')]); },
    exportBundle: () => { calls.push('exportBundle'); return Promise.resolve(emptyBundle); },
    importBundle: () => { calls.push('importBundle'); return Promise.resolve(emptyImport); },
    vectorStats: () => { calls.push('vectorStats'); return Promise.resolve(emptyStats); },
    doctor: () => { calls.push('doctor'); return Promise.resolve(emptyDoctor); },
  };
  return { transport, calls };
}

describe('memory-spine — offline/local fallback (no daemon adopted)', () => {
  test('with no transport, every op resolves against the LOCAL store', async () => {
    const { store, calls } = spyLocalStore();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(store) });

    expect(client.mode()).toBe('local');
    expect(client.active).toBe(false);

    const added = await client.add({ cls: 'fact', summary: 'offline-note' });
    expect(added.summary).toBe('offline-note');
    const search = await client.honestSearch({});
    expect(search.records[0]!.summary).toBe('local-hit');
    await client.get('id1');
    await client.updateReview('id1', { state: 'reviewed' });
    await client.delete('id1');

    expect(calls).toEqual(['add:offline-note', 'search', 'get:id1', 'review:id1', 'delete:id1']);
  });
});

describe('memory-spine — client-of-adopted-daemon mode', () => {
  test('activate routes EVERY op through the wire and never touches the local store', async () => {
    const local = spyLocalStore();
    const wire = spyTransport();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store) });

    client.activate(wire.transport);
    expect(client.mode()).toBe('client');
    expect(client.active).toBe(true);

    const added = await client.add({ cls: 'fact', summary: 'x' });
    expect(added.summary).toBe('wire-x');
    const search = await client.honestSearch({});
    expect(search.records[0]!.summary).toBe('wire-hit');
    await client.get('id1');
    await client.updateReview('id1', { state: 'reviewed' });
    await client.delete('id1');

    // The wire saw everything; the local store was NEVER touched (single writer).
    expect(wire.calls).toEqual(['add:x', 'search', 'get:id1', 'review:id1', 'delete:id1']);
    expect(local.calls).toEqual([]);
  });

  test('constructing WITH a transport starts in client mode immediately', () => {
    const local = spyLocalStore();
    const wire = spyTransport();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: wire.transport });
    expect(client.mode()).toBe('client');
  });

  test('deactivate reverts to owned-local access', async () => {
    const local = spyLocalStore();
    const wire = spyTransport();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: wire.transport });

    client.deactivate('daemon lost');
    expect(client.mode()).toBe('local');

    await client.add({ cls: 'fact', summary: 'back-offline' });
    expect(local.calls).toEqual(['add:back-offline']);
    expect(wire.calls).toEqual([]);
  });
});

describe('memory-spine — extended catalog (full detach)', () => {
  test('local mode routes every extended verb against the LOCAL store', async () => {
    const { store, calls } = spyLocalStore();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(store) });

    await client.list({});
    await client.searchSemantic({ query: 'x' });
    await client.update('id1', { summary: 's' });
    await client.link('a', 'b', 'rel');
    await client.linksFor('a');
    await client.reviewQueue(5);
    await client.exportBundle({});
    await client.importBundle(emptyBundle);
    await client.vectorStats();
    await client.doctor();

    expect(calls).toEqual([
      'list', 'searchSemantic', 'update:id1', 'link:a->b', 'linksFor:a',
      'reviewQueue', 'exportBundle', 'importBundle', 'vectorStats', 'doctor',
    ]);
  });

  test('client mode with a full transport routes every extended verb over the wire, never the local store', async () => {
    const local = spyLocalStore();
    const wire = spyFullTransport();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: wire.transport });

    const list = await client.list({});
    expect(list[0]!.summary).toBe('wire-list');
    const sem = await client.searchSemantic({ query: 'x' });
    expect(sem[0]!.record.summary).toBe('wire-sem');
    await client.update('id1', { summary: 's' });
    await client.link('a', 'b', 'rel');
    await client.linksFor('a');
    await client.reviewQueue(5);
    await client.exportBundle({});
    await client.importBundle(emptyBundle);
    await client.vectorStats();
    await client.doctor();

    expect(wire.calls).toEqual([
      'list', 'searchSemantic', 'update:id1', 'link:a->b', 'linksFor:a',
      'reviewQueue', 'exportBundle', 'importBundle', 'vectorStats', 'doctor',
    ]);
    expect(local.calls).toEqual([]);
  });

  test('COMPILE-TIME guard: a transport object that OMITS an extended verb rejects honestly — never the local file', async () => {
    // A surface pinned to an adapter that predates the verb: the transport object
    // literally has no `list`/`searchSemantic`/`exportBundle` function. The client's
    // routeExtended catches the `call === undefined` case. (This is the secondary
    // guard; the primary — a wired verb whose daemon 404s at runtime — is below.)
    const local = spyLocalStore();
    const wire = spyTransport(); // core-only transport (older/pinned adapter)
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: wire.transport });

    await expect(client.list({})).rejects.toThrow(/does not support the 'list' memory verb/);
    await expect(client.searchSemantic({})).rejects.toThrow(/searchSemantic/);
    await expect(client.exportBundle({})).rejects.toThrow(/exportBundle/);
    // Crucially, the local store was NEVER reached — the single-writer invariant holds.
    expect(local.calls).toEqual([]);
  });

  test('RUNTIME signal: a wired verb whose live older daemon 404s (route-not-found) REJECTS honestly, never nulls', async () => {
    // This is what a LIVE older daemon actually produces (not a transport that omits
    // the method): the transport IMPLEMENTS `update`, calls the route, and the daemon
    // answers a route-not-found 404. The transport folds that through the shared
    // discriminator and rejects with the canonical unavailable-verb message — it does
    // NOT return null (which the CLI would mislabel as "record not found").
    const local = spyLocalStore();
    const routeNotFound = createTransportError(
      404, 'http://daemon.test/api/memory/records/mem_x/update', 'POST',
      { error: 'Route not found', code: 'NOT_FOUND', category: 'not_found', status: 404 },
    );
    const olderDaemonTransport: MemoryTransport = {
      ...spyTransport().transport,
      update: async (): Promise<MemoryRecord | null> => {
        try { throw routeNotFound; } catch (error) { foldMemoryWireExtendedError('update', error); return null; }
      },
    };
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: olderDaemonTransport });

    await expect(client.update('mem_x', { summary: 's' })).rejects.toThrow(/does not support the 'update' memory verb/);
    expect(local.calls).toEqual([]);
  });

  test('RUNTIME signal: a genuine record-missing 404 (current daemon) folds to null, never a false reject', async () => {
    // The other side of the discriminator: the SAME bare 404 status, but the body
    // carries the record-missing code, so the transport folds it to null — a real
    // "no such record", correctly distinguished from the version-skew case above.
    const local = spyLocalStore();
    const recordMissing = createTransportError(
      404, 'http://daemon.test/api/memory/records/mem_x/update', 'POST',
      { error: 'Unknown memory record', code: 'MEMORY_RECORD_NOT_FOUND', category: 'not_found', status: 404 },
    );
    const currentDaemonTransport: MemoryTransport = {
      ...spyTransport().transport,
      update: async (): Promise<MemoryRecord | null> => {
        try { throw recordMissing; } catch (error) { foldMemoryWireExtendedError('update', error); return null; }
      },
    };
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: currentDaemonTransport });

    expect(await client.update('mem_x', { summary: 's' })).toBeNull();
    expect(local.calls).toEqual([]);
  });
});

describe('memory-spine — sync-recall snapshot seam', () => {
  test('before any refresh, the snapshot is empty and SAYS SO (never a silent empty)', () => {
    const { store } = spyLocalStore();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(store) });
    const snap = client.recallSnapshot();
    expect(snap.records).toEqual([]);
    expect(snap.capturedAt).toBeNull();
    expect(snap.stale).toBe(true);
    expect(snap.note).toMatch(/not yet captured/);
  });

  test('an async refresh populates a snapshot a SYNC read returns, with an honest freshness note', async () => {
    const local = spyLocalStore();
    const wire = spyFullTransport();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(local.store), transport: wire.transport });

    const refreshed = await client.refreshRecallSnapshot({ query: 'x' });
    expect(refreshed.records[0]!.summary).toBe('wire-hit');
    expect(refreshed.mode).toBe('client');
    expect(refreshed.note).toMatch(/over the wire from the adopted daemon/);

    // A synchronous reader (the prompt builder) gets the cached result with no await.
    const sync = client.recallSnapshot();
    expect(sync.records[0]!.summary).toBe('wire-hit');
    expect(sync.capturedAt).not.toBeNull();
    // The refresh went over the wire (honestSearch on the transport), not the local store.
    expect(wire.calls).toContain('search');
    expect(local.calls).toEqual([]);
  });

  test('a snapshot older than the freshness window reports stale WITH a stated reason', async () => {
    const { store } = spyLocalStore();
    const client = new MemorySpineClient({ local: createLocalMemoryAccess(store), recallSnapshotStaleAfterMs: 10 });
    const refreshed = await client.refreshRecallSnapshot({});
    const capturedAt = refreshed.capturedAt!;
    // Read far in the future: the same cached data, now honestly flagged stale.
    const stale = client.recallSnapshot(capturedAt + 5_000);
    expect(stale.stale).toBe(true);
    expect(stale.note).toMatch(/STALE/);
    expect(stale.ageMs).toBe(5_000);
  });
});
