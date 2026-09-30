import { describe, test, expect } from 'bun:test';
import { REASONING_BUDGET_MAP } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// REASONING_BUDGET_MAP constant
// ---------------------------------------------------------------------------
describe('REASONING_BUDGET_MAP', () => {
  test('instant maps to 0', () => {
    expect(REASONING_BUDGET_MAP['instant']).toBe(0);
  });

  test('low maps to 2048', () => {
    expect(REASONING_BUDGET_MAP['low']).toBe(2048);
  });

  test('medium maps to 8192', () => {
    expect(REASONING_BUDGET_MAP['medium']).toBe(8192);
  });

  test('high maps to 32768', () => {
    expect(REASONING_BUDGET_MAP['high']).toBe(32768);
  });

  test('unknown level returns undefined (no silent fallback)', () => {
    expect(REASONING_BUDGET_MAP['unknown']).toBeUndefined();
  });
});
