/**
 * memory-projections-wire.test.ts
 *
 * The memory.projections.list / memory.projections.get wire verbs and the live
 * projection functions they expose: standing (project/team) records projected to
 * markdown, session records excluded, expired records labelled not dropped,
 * unknown/session ids an honest 404.
 */
import { describe, expect, test } from 'bun:test';
import {
  listMemoryProjections,
  getMemoryProjection,
} from '../packages/sdk/src/platform/state/memory-file-projection.ts';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerMemoryProjectionsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/memory-projections.ts';

const NOW = 2_000_000_000_000;

function record(over: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'scope'>): MemoryRecord {
  return {
    cls: 'decision',
    summary: `summary-${over.id}`,
    tags: ['t1'],
    provenance: [],
    reviewState: 'fresh',
    confidence: 80,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as MemoryRecord;
}

const RECORDS: MemoryRecord[] = [
  record({ id: 'mem_a', scope: 'project', summary: 'project fact', createdAt: 10 }),
  record({ id: 'mem_b', scope: 'team', summary: 'team decision', createdAt: 20 }),
  record({ id: 'mem_c', scope: 'session', summary: 'ephemeral' }), // excluded from projection
  record({ id: 'mem_d', scope: 'project', validUntil: NOW - 1000, createdAt: 30 }), // expired
];

describe('listMemoryProjections', () => {
  test('projects only standing (project/team) records, oldest first, session excluded', () => {
    const rows = listMemoryProjections(RECORDS, { now: NOW });
    expect(rows.map((r) => r.id)).toEqual(['mem_a', 'mem_b', 'mem_d']);
    expect(rows.find((r) => r.id === 'mem_a')!.filename).toBe('mem_a.md');
  });

  test('an expired record is present and labelled expired, not dropped', () => {
    const rows = listMemoryProjections(RECORDS, { now: NOW });
    expect(rows.find((r) => r.id === 'mem_d')!.status).toBe('expired');
    expect(rows.find((r) => r.id === 'mem_a')!.status).toBe('active');
  });
});

describe('getMemoryProjection', () => {
  test('returns entry + projected markdown for a standing record', () => {
    const got = getMemoryProjection(RECORDS, 'mem_b', { now: NOW });
    expect(got).not.toBeNull();
    expect(got!.entry.scope).toBe('team');
    expect(got!.markdown).toContain('# team decision');
    expect(got!.markdown).toContain('scope: team');
  });

  test('a session-scope or unknown id is an honest miss (null)', () => {
    expect(getMemoryProjection(RECORDS, 'mem_c', { now: NOW })).toBeNull();
    expect(getMemoryProjection(RECORDS, 'nope', { now: NOW })).toBeNull();
  });
});

describe('memory.projections.* gateway verbs', () => {
  const ctx = { context: { admin: true } } as const;
  function makeCatalog(): GatewayMethodCatalog {
    const catalog = new GatewayMethodCatalog();
    registerMemoryProjectionsGatewayMethods(catalog, { getAll: () => RECORDS });
    return catalog;
  }

  test('both verbs register with handlers', () => {
    const catalog = makeCatalog();
    expect(catalog.hasHandler('memory.projections.list')).toBe(true);
    expect(catalog.hasHandler('memory.projections.get')).toBe(true);
  });

  test('memory.projections.list returns the standing projections', async () => {
    const out = await makeCatalog().invoke('memory.projections.list', { ...ctx, body: {} }) as { projections: { id: string }[] };
    expect(out.projections.map((p) => p.id)).toEqual(['mem_a', 'mem_b', 'mem_d']);
  });

  test('memory.projections.get returns one projection with markdown', async () => {
    const out = await makeCatalog().invoke('memory.projections.get', { ...ctx, body: { id: 'mem_a' } }) as { projection: { id: string }; markdown: string };
    expect(out.projection.id).toBe('mem_a');
    expect(out.markdown).toContain('# project fact');
  });

  test('memory.projections.get is an honest 404 for a session/unknown id', async () => {
    await expect(makeCatalog().invoke('memory.projections.get', { ...ctx, body: { id: 'mem_c' } })).rejects.toThrow(/mem_c/);
    await expect(makeCatalog().invoke('memory.projections.get', { ...ctx, body: {} })).rejects.toThrow(/id/);
  });
});
