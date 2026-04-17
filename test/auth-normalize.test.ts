import { describe, expect, test } from 'bun:test';
import { normalizeAuthToken } from '../packages/transport-http/src/auth.ts';

describe('normalizeAuthToken', () => {
  test('string input — resolver yields the string', async () => {
    const resolver = normalizeAuthToken('my-token');
    const result = await resolver();
    expect(result).toBe('my-token');
  });

  test('{ token } object — resolver yields token property', async () => {
    const resolver = normalizeAuthToken({ token: 'wrapped-token' });
    const result = await resolver();
    expect(result).toBe('wrapped-token');
  });

  test('sync function — resolver awaits and returns the result', async () => {
    const resolver = normalizeAuthToken(() => 'sync-token');
    const result = await resolver();
    expect(result).toBe('sync-token');
  });

  test('async function — resolver awaits and returns the result', async () => {
    const resolver = normalizeAuthToken(async () => 'async-token');
    const result = await resolver();
    expect(result).toBe('async-token');
  });

  test('undefined — resolver yields undefined', async () => {
    const resolver = normalizeAuthToken(undefined);
    const result = await resolver();
    expect(result).toBeUndefined();
  });

  test('async function returning undefined — resolver yields undefined', async () => {
    const resolver = normalizeAuthToken(async () => undefined);
    const result = await resolver();
    expect(result).toBeUndefined();
  });

  test('error in sync resolver — propagates as rejected promise', async () => {
    const resolver = normalizeAuthToken(() => {
      throw new Error('token error');
    });
    await expect(resolver()).rejects.toThrow('token error');
  });

  test('error in async resolver — propagates as rejected promise', async () => {
    const resolver = normalizeAuthToken(async () => {
      throw new Error('async token error');
    });
    await expect(resolver()).rejects.toThrow('async token error');
  });

  test('resolver is called fresh each invocation (dynamic token support)', async () => {
    let current = 'token-v1';
    const resolver = normalizeAuthToken(() => current);
    expect(await resolver()).toBe('token-v1');
    current = 'token-v2';
    expect(await resolver()).toBe('token-v2');
  });
});
