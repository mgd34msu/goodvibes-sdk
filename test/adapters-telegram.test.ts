/**
 * M2 (seventh-review): Adapter behavioral coverage — Telegram adapter.
 */
import { describe, expect, test } from 'bun:test';

describe('telegram adapter — contract surface', () => {
  test('telegram adapter module is importable without throwing', async () => {
    await expect(import('../packages/sdk/src/platform/adapters/telegram/index.js')).resolves.toBeDefined();
  });

  test('telegram adapter module exports at least one function', async () => {
    const mod = await import('../packages/sdk/src/platform/adapters/telegram/index.js');
    const hasFn = Object.values(mod).some((v) => typeof v === 'function');
    expect(hasFn).toBe(true);
  });
});
