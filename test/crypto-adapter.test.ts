/**
 * Unit tests for the crypto adapter.
 *
 * Verifies that the Web Crypto adapter (used in React Native / browser)
 * produces outputs consistent with the Node.js crypto adapter.
 * Both adapters must produce identical results for the same inputs.
 */

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createSha256Hash,
  randomBytesBase64url,
} from '../packages/sdk/src/_internal/platform/runtime/auth/crypto-adapter.js';

// Bun provides globalThis.crypto (Web Crypto API), so the Web adapter works
// in the test environment without any mocking.

describe('crypto-adapter (Web Crypto implementation)', () => {
  describe('createSha256Hash', () => {
    test('returns base64url string', async () => {
      const result = await createSha256Hash('hello');
      expect(typeof result).toBe('string');
      // base64url: no +, /, or = characters
      expect(result).not.toMatch(/[+/=]/);
    });

    test('matches node:crypto SHA-256 output for known input', async () => {
      const input = 'pkce-verifier-test-string';
      const nodeDigest = createHash('sha256').update(input).digest('base64url');
      const webDigest = await createSha256Hash(input);
      expect(webDigest).toBe(nodeDigest);
    });

    test('is deterministic for identical inputs', async () => {
      const input = 'deterministic-test';
      const a = await createSha256Hash(input);
      const b = await createSha256Hash(input);
      expect(a).toBe(b);
    });

    test('returns different hash for different inputs', async () => {
      const a = await createSha256Hash('input-a');
      const b = await createSha256Hash('input-b');
      expect(a).not.toBe(b);
    });

    test('SHA-256 produces 32-byte (43 base64url char) output', async () => {
      // 32 bytes → 43 base64url chars (ceil(32*4/3) without padding)
      const result = await createSha256Hash('test');
      expect(result.length).toBe(43);
    });
  });

  describe('randomBytesBase64url', () => {
    test('returns a string', () => {
      const result = randomBytesBase64url(32);
      expect(typeof result).toBe('string');
    });

    test('returns base64url string without +, /, or =', () => {
      const result = randomBytesBase64url(32);
      expect(result).not.toMatch(/[+/=]/);
    });

    test('returns different values on each call', () => {
      const a = randomBytesBase64url(32);
      const b = randomBytesBase64url(32);
      // With 32 random bytes, collision probability is negligible
      expect(a).not.toBe(b);
    });

    test('24-byte output matches expected base64url length', () => {
      // 24 bytes → 32 base64url chars
      const result = randomBytesBase64url(24);
      expect(result.length).toBe(32);
    });

    test('32-byte output matches expected base64url length', () => {
      // 32 bytes → 43 base64url chars
      const result = randomBytesBase64url(32);
      expect(result.length).toBe(43);
    });

    test('output matches length from equivalent node:crypto call', () => {
      const n = 32;
      const nodeResult = randomBytes(n).toString('base64url');
      const webResult = randomBytesBase64url(n);
      // Lengths must match even though values differ
      expect(webResult.length).toBe(nodeResult.length);
    });
  });
});
