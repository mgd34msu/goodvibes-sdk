import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager, SecretStoreUnreadableError } from '../packages/sdk/src/platform/config/secrets.js';
import { keyFingerprint, loadOrCreateKeyfile } from '../packages/sdk/src/platform/config/secrets-keyfile.js';

/**
 * Key-mismatch hardening (2026-07 incident: a lost keyfile + non-exclusive
 * regeneration + per-process key caching produced stores nobody could read,
 * surfacing days later as bare GCM auth failures). Pins the three guards:
 *
 *   1. losing the keyfile-creation race ADOPTS the winner's key
 *   2. a write with a cached key the keyfile no longer backs is REFUSED,
 *      and a missing keyfile is RESTORED from the cached key
 *   3. a fingerprint mismatch reads back as a precise reason, not a bare
 *      authentication failure
 */
describe('SecretsManager key-mismatch guards', () => {
  const scratchDirs: string[] = [];

  function makeScratch(): { home: string; project: string; keyfile: string; store: string } {
    const root = mkdtempSync(join(tmpdir(), 'gv-secrets-guards-'));
    scratchDirs.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    return {
      home,
      project,
      keyfile: join(home, '.goodvibes', 'secrets.key'),
      store: join(home, '.goodvibes', 'tui', 'secrets.enc'),
    };
  }

  function makeManager(dirs: { home: string; project: string }): SecretsManager {
    return new SecretsManager({
      projectRoot: dirs.project,
      globalHome: dirs.home,
      surfaceRoot: 'tui',
    });
  }

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('losing the keyfile-creation race adopts the existing key instead of minting a private one', () => {
    const dirs = makeScratch();
    // "Winner" process creates the keyfile first.
    const winner = loadOrCreateKeyfile(dirs.keyfile);
    // "Loser" arrives later: must return the winner's key byte-for-byte.
    const loser = loadOrCreateKeyfile(dirs.keyfile);
    expect(loser.equals(winner)).toBe(true);
  });

  test('a write is refused when the keyfile changed under a cached key, and the old store survives', async () => {
    const dirs = makeScratch();
    const sm = makeManager(dirs);
    await sm.set('FIRST_SECRET', 'first-value', { scope: 'user', mode: 'secure' });
    const storeBytesBefore = readFileSync(dirs.store, 'utf-8');

    // Simulate an external keyfile regeneration while sm keeps its cached key.
    writeFileSync(dirs.keyfile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf-8', mode: 0o600 });

    await expect(sm.set('SECOND_SECRET', 'second-value', { scope: 'user', mode: 'secure' })).rejects.toThrow(SecretStoreUnreadableError);
    await expect(sm.set('SECOND_SECRET', 'second-value', { scope: 'user', mode: 'secure' })).rejects.toThrow(/no longer matches the keyfile/);
    // The refused write must not have clobbered the store on disk.
    expect(readFileSync(dirs.store, 'utf-8')).toBe(storeBytesBefore);
  });

  test('a missing keyfile is restored from the cached key so stores stay readable across restarts', async () => {
    const dirs = makeScratch();
    const sm = makeManager(dirs);
    await sm.set('FIRST_SECRET', 'first-value', { scope: 'user', mode: 'secure' });
    const originalKey = readFileSync(dirs.keyfile, 'utf-8');

    unlinkSync(dirs.keyfile);
    await sm.set('SECOND_SECRET', 'second-value', { scope: 'user', mode: 'secure' });

    // Keyfile restored with the SAME key, and a fresh manager (fresh cache) reads both values.
    expect(existsSync(dirs.keyfile)).toBe(true);
    expect(readFileSync(dirs.keyfile, 'utf-8')).toBe(originalKey);
    const fresh = makeManager(dirs);
    expect(await fresh.get('FIRST_SECRET')).toBe('first-value');
    expect(await fresh.get('SECOND_SECRET')).toBe('second-value');
  });

  test('a key mismatch reads back as a precise fingerprint reason, not a bare auth failure', async () => {
    const dirs = makeScratch();
    const writer = makeManager(dirs);
    await writer.set('ORPHANED_SECRET', 'value', { scope: 'user', mode: 'secure' });
    const writerKey = loadOrCreateKeyfile(dirs.keyfile);

    // The keyfile is replaced; a fresh process now holds a different key.
    const replacement = randomBytes(32);
    writeFileSync(dirs.keyfile, `${replacement.toString('hex')}\n`, { encoding: 'utf-8', mode: 0o600 });

    const reader = makeManager(dirs);
    expect(await reader.get('ORPHANED_SECRET')).toBeNull();
    const review = await reader.inspect();
    const warning = review.warnings.find((w: string) => w.includes('cannot be read'));
    expect(warning).toBeDefined();
    expect(warning!).toContain(`written with encryption key ${keyFingerprint(writerKey)}`);
    expect(warning!).toContain(keyFingerprint(replacement));
    expect(warning!).not.toContain('Unsupported state');
  });

  test('stores written before the fingerprint field still decrypt (no keyId → normal decrypt path)', async () => {
    const dirs = makeScratch();
    const sm = makeManager(dirs);
    await sm.set('PLAIN_OLD_SECRET', 'old-value', { scope: 'user', mode: 'secure' });

    // Strip keyId from the envelope to simulate a store written by an older SDK.
    const envelope = JSON.parse(readFileSync(dirs.store, 'utf-8')) as Record<string, unknown>;
    delete envelope.keyId;
    writeFileSync(dirs.store, `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8');

    const fresh = makeManager(dirs);
    expect(await fresh.get('PLAIN_OLD_SECRET')).toBe('old-value');
  });
});
