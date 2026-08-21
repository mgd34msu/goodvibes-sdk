/**
 * companion-token-rotation.test.ts
 *
 * The rotation verb behind /qrcode regenerate.
 *
 * regenerateCompanionToken re-keys the SAME operator-token store
 * (<daemonHomeDir>/operator-tokens.json): it issues a fresh token + peerId and
 * overwrites the file, so the previously-issued token is no longer present in
 * the store and is honestly rejected on the next auth. Rotation reuses the
 * exact machinery getOrCreateCompanionToken persists through, no second store.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getOrCreateCompanionToken,
  regenerateCompanionToken,
  type CompanionTokenRecord,
} from '../packages/sdk/src/platform/pairing/companion-token.ts';

const roots: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'gv-companion-rotate-'));
  roots.push(d);
  return d;
}
afterEach(() => {
  for (const d of roots.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function readStore(daemonHomeDir: string): CompanionTokenRecord {
  return JSON.parse(readFileSync(join(daemonHomeDir, 'operator-tokens.json'), 'utf-8')) as CompanionTokenRecord;
}

describe('regenerateCompanionToken (rotation)', () => {
  test('issues a new token + peerId, invalidating the old one', () => {
    const daemonHomeDir = tempHome();
    const original = getOrCreateCompanionToken({ daemonHomeDir });

    const rotated = regenerateCompanionToken({ daemonHomeDir });
    expect(rotated.token).not.toBe(original.token);
    expect(rotated.peerId).not.toBe(original.peerId);
    expect(rotated.token.startsWith('gv_')).toBe(true);

    // The store now holds ONLY the rotated token, the old token is gone.
    const stored = readStore(daemonHomeDir);
    expect(stored.token).toBe(rotated.token);
    expect(stored.token).not.toBe(original.token);
  });

  test('a subsequent get returns the rotated token (old token never resurfaces)', () => {
    const daemonHomeDir = tempHome();
    const original = getOrCreateCompanionToken({ daemonHomeDir });
    const rotated = regenerateCompanionToken({ daemonHomeDir });

    const afterRotate = getOrCreateCompanionToken({ daemonHomeDir });
    expect(afterRotate.token).toBe(rotated.token);
    expect(afterRotate.token).not.toBe(original.token);
  });

  test('rotation via the surface form (surface, options) also re-keys', () => {
    const daemonHomeDir = tempHome();
    const original = getOrCreateCompanionToken('tui', { daemonHomeDir });
    const rotated = getOrCreateCompanionToken('tui', { daemonHomeDir, regenerate: true });
    expect(rotated.token).not.toBe(original.token);
    expect(readStore(daemonHomeDir).token).toBe(rotated.token);
  });

  test('the rotated store keeps owner-only (0600) permissions', () => {
    const daemonHomeDir = tempHome();
    getOrCreateCompanionToken({ daemonHomeDir });
    regenerateCompanionToken({ daemonHomeDir });
    const mode = statSync(join(daemonHomeDir, 'operator-tokens.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// An unreadable token store
// ---------------------------------------------------------------------------
//
// The store is a fleet's shared secret. When it could not be read the code
// fell through and minted a new token OVER the top of it: every paired client
// 401s, the bytes they were holding are gone, and nothing anywhere says why.

describe('an operator token store that cannot be read', () => {
  test.each([
    ['not valid JSON', 'this is not json at all'],
    ['a torn write', ''],
    ['a JSON value that is not a token record', '[1,2,3]'],
    ['a record with no token', JSON.stringify({ peerId: 'abc', createdAt: 1 })],
  ])('%s is moved aside, not silently overwritten', (_label, contents) => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'operator-token-quarantine-'));
    try {
      const tokenPath = join(daemonHomeDir, 'operator-tokens.json');
      writeFileSync(tokenPath, contents);

      const result = getOrCreateCompanionToken({ daemonHomeDir });

      expect(result.token).toStartWith('gv_');
      expect(result.quarantined).toBeDefined();
      expect(result.quarantined!.from).toBe(tokenPath);
      expect(result.quarantined!.to).toBe(`${tokenPath}.unrecognized`);
      expect(result.quarantined!.reason).toBeTruthy();
      // The old bytes are still on disk, exactly as they were.
      expect(readFileSync(`${tokenPath}.unrecognized`, 'utf-8')).toBe(contents);
      // And the store now holds the new token.
      expect(readStore(daemonHomeDir).token).toBe(result.token);
    } finally {
      rmSync(daemonHomeDir, { recursive: true, force: true });
    }
  });

  test('the quarantine is recorded as a receipt saying clients must pair again', () => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'operator-token-receipt-'));
    try {
      writeFileSync(join(daemonHomeDir, 'operator-tokens.json'), '{ truncated');
      const receipts: string[] = [];

      getOrCreateCompanionToken({ daemonHomeDir, receipts: { record: (text) => receipts.push(text) } });

      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toContain('pair again');
      expect(receipts[0]).toContain('.unrecognized');
    } finally {
      rmSync(daemonHomeDir, { recursive: true, force: true });
    }
  });

  test('a second unreadable store does not overwrite the first one moved aside', () => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'operator-token-second-'));
    try {
      const tokenPath = join(daemonHomeDir, 'operator-tokens.json');
      writeFileSync(tokenPath, 'first corruption');
      getOrCreateCompanionToken({ daemonHomeDir });
      writeFileSync(tokenPath, 'second corruption');
      const second = getOrCreateCompanionToken({ daemonHomeDir });

      expect(second.quarantined!.to).toBe(`${tokenPath}.unrecognized.2`);
      expect(readFileSync(`${tokenPath}.unrecognized`, 'utf-8')).toBe('first corruption');
      expect(readFileSync(`${tokenPath}.unrecognized.2`, 'utf-8')).toBe('second corruption');
    } finally {
      rmSync(daemonHomeDir, { recursive: true, force: true });
    }
  });

  test('a readable store is untouched and reports no quarantine', () => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'operator-token-intact-'));
    try {
      const first = getOrCreateCompanionToken({ daemonHomeDir });
      const second = getOrCreateCompanionToken({ daemonHomeDir });

      expect(second.token).toBe(first.token);
      expect(second.quarantined).toBeUndefined();
      expect(existsSync(join(daemonHomeDir, 'operator-tokens.json.unrecognized'))).toBe(false);
    } finally {
      rmSync(daemonHomeDir, { recursive: true, force: true });
    }
  });
});
