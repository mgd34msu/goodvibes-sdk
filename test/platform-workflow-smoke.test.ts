/**
 * platform/workflow/ smoke test.
 * Verifies that the workflow trigger executor is importable and exports the
 * fireTriggers function with the correct arity.
 */
import { describe, expect, test } from 'bun:test';

describe('platform/workflow — smoke', () => {
  test('fireTriggers has arity >= 1 (accepts trigger config)', async () => {
    const { fireTriggers } = await import('../packages/sdk/src/platform/workflow/index.js');
    expect(fireTriggers.length).toBeGreaterThanOrEqual(1);
  });

  test('fireTriggers resolves to empty array when triggerManager has no triggers', async () => {
    const { fireTriggers } = await import('../packages/sdk/src/platform/workflow/index.js');
    // fireTriggers(event, triggerManager) — stub a manager with no triggers
    const event = { path: 'test/event', payload: {} };
    const emptyManager = { list: () => [] };
    const result = await fireTriggers(
      event as Parameters<typeof fireTriggers>[0],
      emptyManager as Parameters<typeof fireTriggers>[1],
    );
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(0);
  });
});
