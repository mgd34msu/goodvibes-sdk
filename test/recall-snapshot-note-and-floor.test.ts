/**
 * recall-snapshot-note-and-floor.test.ts
 *
 * Stage-5 cohesion/contract fixes:
 *  - Fix 3: the recall-snapshot note matches the TUI's freshness vocabulary
 *    (lowercase, hedged "may be stale", humanized seconds — never raw ms), and
 *    labels its count honestly against the capture's recall flag (an unfiltered
 *    browse capture is NEVER called "recall-eligible").
 *  - Fix 4: the honest search result carries the store's configured recall floor
 *    so a surface can state it without hardcoding 60.
 */

import { describe, expect, test } from 'bun:test';
import { buildRecallSnapshot } from '../packages/sdk/src/platform/runtime/memory-spine/recall-snapshot.js';
import {
  runHonestMemorySearch,
  MIN_PROMPT_MEMORY_CONFIDENCE,
  type HonestMemorySearchResult,
} from '../packages/sdk/src/platform/state/memory-recall-contract.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';

function record(id: string, confidence: number, reviewState: MemoryRecord['reviewState'] = 'fresh'): MemoryRecord {
  return {
    id, scope: 'project', cls: 'fact', summary: `summary-${id}`, tags: [], provenance: [],
    reviewState, confidence, createdAt: 0, updatedAt: 0,
  } as MemoryRecord;
}

function result(records: MemoryRecord[], recallFiltered: boolean): HonestMemorySearchResult {
  return {
    records, mode: 'literal', requestedSemantic: false, indexUnavailableReason: null,
    caveat: null, recallFiltered, excludedFlaggedCount: 0, excludedBelowFloorCount: 0,
    totalBeforeRecallFilter: records.length, recallFloor: MIN_PROMPT_MEMORY_CONFIDENCE,
  };
}

describe('recall-snapshot note — freshness vocabulary (Fix 3)', () => {
  test('a fresh snapshot reads lowercase with humanized seconds, never raw ms', () => {
    const snap = buildRecallSnapshot(result([record('a', 70)], true), 'local', 1_000, 30_000, 6_000);
    expect(snap.stale).toBe(false);
    expect(snap.note).toContain('captured 5s ago');
    expect(snap.note).not.toMatch(/\d+ms ago/);
    expect(snap.note).not.toContain('STALE');
  });

  test('a stale snapshot is hedged "may be stale" with humanized seconds, never uppercase or ms', () => {
    const snap = buildRecallSnapshot(result([record('a', 70)], true), 'client', 0, 30_000, 45_000);
    expect(snap.stale).toBe(true);
    expect(snap.note).toContain('may be stale');
    expect(snap.note).toContain('45s ago');
    expect(snap.note).toContain('30s freshness window');
    expect(snap.note).not.toContain('STALE');
    expect(snap.note).not.toMatch(/\d+ms ago/);
    expect(snap.note).not.toMatch(/\d+ms freshness/);
  });
});

describe('recall-snapshot note — honest count label vs the recall flag (Fix 3)', () => {
  test('a recall-filtered capture labels its count "recall-eligible"', () => {
    const snap = buildRecallSnapshot(result([record('a', 70)], true), 'local', 0, 30_000, 1_000);
    expect(snap.note).toContain('1 record(s) recall-eligible');
    expect(snap.note).not.toContain('browse set');
  });

  test('an UNFILTERED browse capture is never labeled recall-eligible', () => {
    // recall:false → the count is the unfiltered browse set, not the eligible set.
    const snap = buildRecallSnapshot(result([record('a', 70), record('b', 10)], false), 'local', 0, 30_000, 1_000);
    expect(snap.note).not.toContain('recall-eligible');
    expect(snap.note).toContain('2 record(s) in the browse set');
    expect(snap.note).toContain('recall floor not applied');
  });
});

describe('honest search result carries the recall floor (Fix 4)', () => {
  const store = {
    search: (_: unknown) => [record('a', 70), record('b', 30)],
    searchSemantic: (_: unknown) => [],
    vectorStats: () => ({ enabled: false, available: false, indexedRecords: 0, embeddingProviderId: 'none' }),
  } as never;

  test('recall:false (browse) still reports the floor it would judge against', () => {
    const res = runHonestMemorySearch(store, {}, { recall: false });
    expect(res.recallFloor).toBe(MIN_PROMPT_MEMORY_CONFIDENCE);
    expect(res.recallFiltered).toBe(false);
  });

  test('recall:true (injection) reports the floor it judged against', () => {
    const res = runHonestMemorySearch(store, {}, { recall: true });
    expect(res.recallFloor).toBe(MIN_PROMPT_MEMORY_CONFIDENCE);
    expect(res.recallFiltered).toBe(true);
  });

  test('the memory-search wire schema exposes recallFloor', async () => {
    const { MEMORY_RECORD_SEARCH_OUTPUT_SCHEMA } = await import(
      '../packages/sdk/src/platform/control-plane/operator-contract-schemas-runtime.js'
    );
    const schema = MEMORY_RECORD_SEARCH_OUTPUT_SCHEMA as { properties?: Record<string, unknown>; required?: string[] };
    expect('recallFloor' in (schema.properties ?? {})).toBe(true);
    expect(schema.required ?? []).toContain('recallFloor');
  });
});
