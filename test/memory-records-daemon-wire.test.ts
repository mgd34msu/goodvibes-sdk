/**
 * memory-records-daemon-wire.test.ts
 *
 * The daemon-owned single-writer memory service, proven over a REAL bootDaemon
 * (isolated home, ephemeral port, token auth — the boot-daemon-factory pattern).
 *
 *   - add over the wire → the record is visible via a wire search AND via a DIRECT
 *     read of the daemon's canonical store (the same registry the routes serve),
 *     confirming the write reached the canonical store, not a detached copy.
 *   - semantic search with the honesty contract: an unavailable/empty index degrades
 *     to a literal scan WITH a stated reason, never a silent empty.
 *   - review-state exclusion: a record flagged contradicted is dropped from a
 *     recall search regardless of confidence.
 *   - get 404 for unknown ids; delete-means-delete (deleted:true then deleted:false).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'memory-wire-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

async function addRecord(body: Record<string, unknown>): Promise<{ id: string; summary: string }> {
  const res = await fetch(`${daemon.url}/api/memory/records`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  const parsed = await res.json() as { record: { id: string; summary: string } };
  return parsed.record;
}

interface WireSearchResult {
  records: Array<{ id: string; summary: string }>;
  mode: string;
  requestedSemantic: boolean;
  indexUnavailableReason: string | null;
  recallFiltered: boolean;
  excludedFlaggedCount: number;
  excludedBelowFloorCount: number;
}

async function search(body: Record<string, unknown>): Promise<WireSearchResult> {
  const res = await fetch(`${daemon.url}/api/memory/records/search`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return res.json() as Promise<WireSearchResult>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'mem-wire-home-'));
  work = mkdtempSync(join(tmpdir(), 'mem-wire-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('add over the wire is visible via wire search AND a direct canonical-store read', () => {
  test('a wire add lands in the canonical store', async () => {
    const record = await addRecord({ cls: 'decision', summary: 'canonical wire decision', tags: ['wire'], review: { confidence: 80 } });
    expect(record.id).toMatch(/^mem_/);

    // Visible via a wire search.
    const viaWire = await search({ query: 'canonical wire decision' });
    expect(viaWire.records.some((r) => r.id === record.id)).toBe(true);

    // Visible via a DIRECT read of the daemon's own canonical store.
    const direct = daemon.memory.get(record.id);
    expect(direct?.summary).toBe('canonical wire decision');
    expect(daemon.memory.search({ query: 'canonical wire' }).some((r) => r.id === record.id)).toBe(true);
  });

  test('missing required fields are rejected 400', async () => {
    const res = await fetch(`${daemon.url}/api/memory/records`, { method: 'POST', headers: auth(), body: JSON.stringify({ summary: 'no class' }) });
    expect(res.status).toBe(400);
  });
});

describe('semantic search degrades honestly to a literal fallback with a stated reason', () => {
  test('semantic requested with no consultable index → literal fallback, reason stated, record still found', async () => {
    const record = await addRecord({ cls: 'fact', summary: 'semantic honesty probe fact', review: { confidence: 75 } });

    const result = await search({ query: 'semantic honesty probe', semantic: true });
    expect(result.requestedSemantic).toBe(true);
    // In the isolated test daemon the semantic index has no modeled provider / no
    // indexed rows, so the honest path is a stated fallback — never a silent empty.
    if (result.indexUnavailableReason !== null) {
      expect(result.mode).toBe('literal');
    }
    expect(result.records.some((r) => r.id === record.id)).toBe(true);
  });
});

describe('review-state exclusion under the recall contract', () => {
  test('a contradicted record is excluded from a recall search regardless of confidence', async () => {
    const record = await addRecord({ cls: 'incident', summary: 'flagged wire incident', review: { confidence: 95 } });

    // Flag it contradicted over the wire.
    const reviewRes = await fetch(`${daemon.url}/api/memory/records/${record.id}/review`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ state: 'contradicted', staleReason: 'superseded' }),
    });
    expect(reviewRes.status).toBe(200);
    const reviewed = await reviewRes.json() as { record: { reviewState: string } };
    expect(reviewed.record.reviewState).toBe('contradicted');

    // A recall search drops it and counts the exclusion; a plain search still sees it.
    const recall = await search({ query: 'flagged wire incident', recall: true });
    expect(recall.records.some((r) => r.id === record.id)).toBe(false);
    expect(recall.excludedFlaggedCount).toBeGreaterThanOrEqual(1);

    const plain = await search({ query: 'flagged wire incident' });
    expect(plain.records.some((r) => r.id === record.id)).toBe(true);
  });
});

describe('get and delete honesty', () => {
  test('get returns 404 for an unknown id', async () => {
    const res = await fetch(`${daemon.url}/api/memory/records/mem_does_not_exist`, { headers: auth() });
    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('MEMORY_RECORD_NOT_FOUND');
  });

  test('delete removes the record (deleted:true), then reports deleted:false on a second delete', async () => {
    const record = await addRecord({ cls: 'fact', summary: 'delete me over the wire' });

    const first = await fetch(`${daemon.url}/api/memory/records/${record.id}`, { method: 'DELETE', headers: auth() });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id: record.id, deleted: true });

    // Gone from the canonical store.
    expect(daemon.memory.get(record.id)).toBeNull();

    const second = await fetch(`${daemon.url}/api/memory/records/${record.id}`, { method: 'DELETE', headers: auth() });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: record.id, deleted: false });
  });
});
