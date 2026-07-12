/**
 * companion-token-rotation.test.ts
 *
 * The rotation verb behind /qrcode regenerate.
 *
 * regenerateCompanionToken re-keys the SAME operator-token store
 * (<daemonHomeDir>/operator-tokens.json): it issues a fresh token + peerId and
 * overwrites the file, so the previously-issued token is no longer present in
 * the store and is honestly rejected on the next auth. Rotation reuses the
 * exact machinery getOrCreateCompanionToken persists through — no second store.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
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

    // The store now holds ONLY the rotated token — the old token is gone.
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
