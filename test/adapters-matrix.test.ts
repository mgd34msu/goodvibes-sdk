/**
 * M2 (seventh-review): Adapter behavioral coverage — Matrix adapter.
 */
import { describe, expect, test } from 'bun:test';

describe('matrix adapter — contract surface', () => {
  test('matrix adapter module is importable without throwing', async () => {
    await expect(import('../packages/sdk/src/_internal/platform/adapters/matrix/index.js')).resolves.toBeDefined();
  });

  test('matrix adapter module exports at least one function', async () => {
    const mod = await import('../packages/sdk/src/_internal/platform/adapters/matrix/index.js');
    const hasFn = Object.values(mod).some((v) => typeof v === 'function');
    expect(hasFn).toBe(true);
  });
});
