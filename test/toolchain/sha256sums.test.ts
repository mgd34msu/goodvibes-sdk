import { describe, expect, test } from 'bun:test';
import { generateSha256Sums, verifySha256Sums, parseSha256Manifest } from '@pellux/goodvibes-toolchain';

const files: Record<string, Uint8Array> = {
  'goodvibes-linux-x64': new TextEncoder().encode('binary-a'),
  'goodvibes-daemon-linux-x64': new TextEncoder().encode('binary-b'),
};
const readBytes = (p: string): Uint8Array | null => files[p] ?? null;
// Deterministic fake hash for the test (length-prefixed content marker).
const fakeHash = (b: Uint8Array): string => `${b.length}`.padStart(64, '0');

describe('sha256sums', () => {
  test('generates a two-space manifest for present assets', () => {
    const result = generateSha256Sums(
      [{ name: 'goodvibes-linux-x64', path: 'goodvibes-linux-x64' }, { name: 'goodvibes-daemon-linux-x64', path: 'goodvibes-daemon-linux-x64' }],
      readBytes,
      fakeHash,
    );
    expect(result.ok).toBe(true);
    expect(result.manifest).toContain('  goodvibes-linux-x64');
    expect(parseSha256Manifest(result.manifest).size).toBe(2);
  });

  test('hard-fails when an asset is missing', () => {
    const result = generateSha256Sums([{ name: 'absent', path: 'absent' }], readBytes, fakeHash);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('absent');
    expect(result.manifest).toBe('');
  });

  test('verify detects a mismatched hash', () => {
    const manifest = 'deadbeef'.repeat(8) + '  goodvibes-linux-x64\n';
    const realHash = (b: Uint8Array): string => Buffer.from(b).toString('hex').padStart(64, '0').slice(0, 64);
    const result = verifySha256Sums(manifest, readBytes, realHash);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain('goodvibes-linux-x64');
  });
});
