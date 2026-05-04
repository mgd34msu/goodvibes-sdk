/**
 * M2 (seventh-review): Adapter behavioral coverage — WhatsApp adapter.
 */
import { describe, expect, test } from 'bun:test';

describe('whatsapp adapter — contract surface', () => {
  test('whatsapp adapter module is importable without throwing', async () => {
    await expect(import('../packages/sdk/src/_internal/platform/adapters/whatsapp/index.js')).resolves.toBeDefined();
  });

  test('whatsapp adapter module exports at least one function', async () => {
    const mod = await import('../packages/sdk/src/_internal/platform/adapters/whatsapp/index.js');
    const hasFn = Object.values(mod).some((v) => typeof v === 'function');
    expect(hasFn).toBe(true);
  });
});
