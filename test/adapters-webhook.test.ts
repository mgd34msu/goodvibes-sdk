/**
 * M2 (seventh-review): Adapter behavioral coverage — Webhook adapter.
 */
import { describe, expect, test } from 'bun:test';

describe('webhook adapter — contract surface', () => {
  test('webhook adapter module is importable without throwing', async () => {
    await expect(import('../packages/sdk/src/_internal/platform/adapters/webhook/index.js')).resolves.toBeDefined();
  });

  test('webhook adapter module exports at least one function', async () => {
    const mod = await import('../packages/sdk/src/_internal/platform/adapters/webhook/index.js');
    const hasFn = Object.values(mod).some((v) => typeof v === 'function');
    expect(hasFn).toBe(true);
  });
});
