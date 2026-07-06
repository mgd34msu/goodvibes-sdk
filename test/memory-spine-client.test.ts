import { describe, expect, test } from 'bun:test';
import {
  MemorySpineClient,
  createLocalMemoryAccess,
  type MemoryAccess,
  type LocalMemoryStore,
} from '../packages/sdk/src/platform/runtime/memory-spine/index.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/index.js';
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

/** A local store spy that records every call so a test can prove it was NOT touched. */
function spyLocalStore(): { store: LocalMemoryStore; calls: string[] } {
  const calls: string[] = [];
  const store: LocalMemoryStore = {
    add: (opts) => { calls.push(`add:${opts.summary}`); return record(opts.summary); },
    honestSearch: () => { calls.push('search'); return honest([record('local-hit')]); },
    get: (id) => { calls.push(`get:${id}`); return record('local'); },
    review: (id) => { calls.push(`review:${id}`); return record('local'); },
    delete: (id) => { calls.push(`delete:${id}`); return true; },
  };
  return { store, calls };
}

/** A wire transport spy. */
function spyTransport(): { transport: MemoryAccess; calls: string[] } {
  const calls: string[] = [];
  const transport: MemoryAccess = {
    add: (opts) => { calls.push(`add:${opts.summary}`); return Promise.resolve(record(`wire-${opts.summary}`)); },
    honestSearch: () => { calls.push('search'); return Promise.resolve(honest([record('wire-hit')])); },
    get: (id) => { calls.push(`get:${id}`); return Promise.resolve(record('wire')); },
    updateReview: (id) => { calls.push(`review:${id}`); return Promise.resolve(record('wire')); },
    delete: (id) => { calls.push(`delete:${id}`); return Promise.resolve(true); },
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
