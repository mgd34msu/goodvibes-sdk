import { describe, expect, test } from 'bun:test';
import type { MemoryConsolidationRunReceipt } from '../packages/sdk/src/platform/state/index.ts';
import { formatConsolidationReceipt } from '../packages/sdk/src/platform/state/consolidation-receipt.ts';

// ---------------------------------------------------------------------------
// A consolidation run that changed something renders as one honest line; a run
// that changed nothing renders as nothing at all.
// ---------------------------------------------------------------------------

function receipt(partial: Partial<MemoryConsolidationRunReceipt>): MemoryConsolidationRunReceipt {
  return {
    runId: 'run-1',
    ranAt: new Date().toISOString(),
    trigger: 'idle',
    idle: true,
    scanned: 42,
    merged: [],
    archived: [],
    decayed: [],
    proposed: [],
    usageSignalAvailable: false,
    note: '',
    ...partial,
  } as MemoryConsolidationRunReceipt;
}

describe('formatConsolidationReceipt', () => {
  test('a run that changed something is one honest line', () => {
    const text = formatConsolidationReceipt(receipt({
      merged: [{}, {}] as never,
      archived: [{}] as never,
      decayed: [{}, {}, {}] as never,
    }));
    expect(text).toBe('Memory consolidation: 2 merged, 1 archived, 3 decayed (scanned 42).');
  });

  test('a quiet run (nothing merged/archived/decayed/proposed) yields null — no notice', () => {
    expect(formatConsolidationReceipt(receipt({}))).toBeNull();
  });

  test('a run with proposals points at the real command and tab (the TUI\'s only pointer to WHAT was proposed)', () => {
    const text = formatConsolidationReceipt(receipt({ proposed: [{}, {}] as never }));
    expect(text).toBe('Memory consolidation: 2 proposed (scanned 42). Review the 2 proposed changes with /memory (Proposals tab).');
  });

  test('a single proposal uses singular "change", still naming /memory and its Proposals tab', () => {
    const text = formatConsolidationReceipt(receipt({ merged: [{}] as never, proposed: [{}] as never }));
    expect(text).toBe('Memory consolidation: 1 merged, 1 proposed (scanned 42). Review the 1 proposed change with /memory (Proposals tab).');
  });
});
