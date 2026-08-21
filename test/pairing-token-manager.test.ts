/**
 * pairing-token-manager.test.ts
 *
 * The PairingTokenManager in isolation: per-device tokens are hashed (never
 * stored/listed in plaintext), authenticate by hash, revoke immediately, and
 * the legacy shared token can be turned off. Custody + revocation semantics,
 * proven against a temp file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PairingTokenManager } from '../packages/sdk/src/platform/pairing/pairing-token-store.ts';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-tok-'));
  dirs.push(dir);
  return join(dir, 'control-plane', 'pairing-tokens.json');
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('PairingTokenManager', () => {
  test('mint returns the secret once; the secret is never persisted or listed', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    const minted = mgr.mint({ name: 'Pixel' });
    expect(minted.token).toStartWith('gvp_');
    expect(minted.name).toBe('Pixel');

    // The on-disk record holds only a hash, never the plaintext.
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(minted.token);
    expect(raw).toContain('tokenHash');

    // The listable view never carries the secret or the hash.
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(minted.token);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
    expect(list[0]).toMatchObject({ id: minted.id, name: 'Pixel' });
  });

  test('authenticate matches by hash and revoke is immediate', () => {
    const mgr = new PairingTokenManager(tempFile());
    const a = mgr.mint({ name: 'Laptop' });
    const b = mgr.mint({ name: 'Phone' });

    expect(mgr.authenticate(a.token)?.id).toBe(a.id);
    expect(mgr.authenticate(b.token)?.id).toBe(b.id);
    expect(mgr.authenticate('gvp_not-a-real-token')).toBeNull();

    // Revoke one device, it fails immediately, the other still works.
    expect(mgr.revoke(a.id)).toBe(true);
    expect(mgr.authenticate(a.token)).toBeNull();
    expect(mgr.authenticate(b.token)?.id).toBe(b.id);
    // A second revoke of the same id is an honest false.
    expect(mgr.revoke(a.id)).toBe(false);
  });

  test('revocation and records survive a reload (persisted)', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    const a = mgr.mint({ name: 'A' });
    const b = mgr.mint({ name: 'B' });
    mgr.revoke(a.id);

    const reloaded = new PairingTokenManager(file);
    expect(reloaded.authenticate(a.token)).toBeNull();
    expect(reloaded.authenticate(b.token)?.id).toBe(b.id);
    expect(reloaded.list().map((t) => t.id)).toEqual([b.id]);
  });

  test('rename changes the visible name; the principal id is stable per token', () => {
    const mgr = new PairingTokenManager(tempFile());
    const a = mgr.mint({ name: 'Old' });
    expect(mgr.rename(a.id, 'New')).toBe(true);
    expect(mgr.list()[0]?.name).toBe('New');
    expect(mgr.authenticate(a.token)?.principalId).toBe(`pairing:${a.id}`);
    expect(mgr.rename('pair-missing', 'x')).toBe(false);
  });

  test('the legacy shared token can be revoked and the flag persists', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    expect(mgr.isLegacyRevoked()).toBe(false);
    mgr.revokeLegacyShared();
    expect(mgr.isLegacyRevoked()).toBe(true);
    expect(new PairingTokenManager(file).isLegacyRevoked()).toBe(true);
  });
});

describe('PairingTokenManager: the store file itself', () => {
  test('the store is written owner-only, through a temp file that never survives the write', () => {
    const file = tempFile();
    new PairingTokenManager(file).mint({ name: 'Pixel' });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const temps = readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.tmp-`));
    expect(temps).toEqual([]);
  });

  test('a corrupt store does not brick auth, and is preserved rather than overwritten', () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    // A torn write: valid JSON with a zero tail, the shape a crash leaves.
    writeFileSync(file, Buffer.concat([Buffer.from('{"tokens":[]}', 'utf-8'), Buffer.from([0, 0])]));

    const mgr = new PairingTokenManager(file);
    // Auth still works, it starts clean rather than throwing on construction.
    expect(mgr.list()).toEqual([]);

    // And the bytes it could not read were moved aside with a receipt, so the
    // operator can see which devices have to pair again.
    const quarantined = readdirSync(dirname(file))
      .filter((name) => name.startsWith(`${basename(file)}.corrupt-`) && !name.endsWith('.why'));
    expect(quarantined.length).toBe(1);
    expect(existsSync(join(dirname(file), `${quarantined[0]}.why`))).toBe(true);

    // A fresh mint then round-trips through the new file.
    const minted = mgr.mint({ name: 'Pixel' });
    expect(new PairingTokenManager(file).authenticate(minted.token)).not.toBeNull();
  });
});
