import { afterEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager, SecretStoreUnreadableError } from '../packages/sdk/src/platform/config/secrets.js';

/**
 * Reproduces the store format written by SDKs that derived the encryption key
 * from hostname + username: an aes-256-gcm envelope with no version field.
 */
function writeLegacyStore(
  filePath: string,
  secrets: Record<string, string>,
  identity: { hostname: string; username: string },
): string {
  const key = createHash('sha256')
    .update(identity.hostname + identity.username + 'goodvibes-secrets', 'utf8')
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  const store = {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: encrypted.toString('hex'),
  };
  mkdirSync(join(filePath, '..'), { recursive: true });
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  writeFileSync(filePath, serialized, 'utf-8');
  return serialized;
}

describe('SecretsManager keyfile-encrypted store', () => {
  const scratchDirs: string[] = [];

  function makeScratch(): { home: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), 'gv-secrets-keyfile-'));
    scratchDirs.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    return { home, project };
  }

  function makeManager(
    dirs: { home: string; project: string },
    identity: { hostname: string; username: string },
  ): SecretsManager {
    return new SecretsManager({
      projectRoot: dirs.project,
      globalHome: dirs.home,
      surfaceRoot: 'testsurface',
      policy: 'require_secure',
      legacyIdentity: identity,
    });
  }

  function userStorePath(home: string): string {
    return join(home, '.goodvibes', 'testsurface', 'secrets.enc');
  }

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy store migrates to the keyfile envelope on first read without losing data', async () => {
    const dirs = makeScratch();
    const identity = { hostname: 'origin-host', username: 'origin-user' };
    const storePath = userStorePath(dirs.home);
    writeLegacyStore(storePath, { API_TOKEN: 'legacy-value', OTHER: 'kept' }, identity);

    const manager = makeManager(dirs, identity);
    expect(await manager.get('API_TOKEN')).toBe('legacy-value');
    expect(await manager.get('OTHER')).toBe('kept');

    const envelope = JSON.parse(readFileSync(storePath, 'utf-8')) as { version?: number };
    expect(envelope.version).toBe(2);

    const keyFile = join(dirs.home, '.goodvibes', 'secrets.key');
    expect(readFileSync(keyFile, 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a migrated store still decrypts after hostname and username change', async () => {
    const dirs = makeScratch();
    const originalIdentity = { hostname: 'origin-host', username: 'origin-user' };
    const storePath = userStorePath(dirs.home);
    writeLegacyStore(storePath, { API_TOKEN: 'portable-value' }, originalIdentity);

    // First read on the original machine performs the migration.
    expect(await makeManager(dirs, originalIdentity).get('API_TOKEN')).toBe('portable-value');

    // Same store directory, but the machine now reports a different identity
    // (renamed host, renamed user, or the directory copied to a new machine).
    const movedManager = makeManager(dirs, { hostname: 'new-host', username: 'new-user' });
    expect(await movedManager.get('API_TOKEN')).toBe('portable-value');
  });

  test('an unmigrated legacy store under a changed identity refuses writes instead of clobbering', async () => {
    const dirs = makeScratch();
    const storePath = userStorePath(dirs.home);
    const originalBytes = writeLegacyStore(
      storePath,
      { API_TOKEN: 'unreachable-but-precious' },
      { hostname: 'origin-host', username: 'origin-user' },
    );

    const manager = makeManager(dirs, { hostname: 'new-host', username: 'new-user' });
    // The store cannot be decrypted: it must read as unavailable, not empty.
    expect(await manager.get('API_TOKEN')).toBeNull();
    // And a write must refuse rather than overwrite the file.
    await expect(manager.set('NEW_KEY', 'value', { scope: 'user', medium: 'secure' }))
      .rejects.toBeInstanceOf(SecretStoreUnreadableError);
    expect(readFileSync(storePath, 'utf-8')).toBe(originalBytes);
  });

  test('a tampered keyfile-format store refuses writes and keeps its bytes', async () => {
    const dirs = makeScratch();
    const identity = { hostname: 'host', username: 'user' };
    const manager = makeManager(dirs, identity);
    await manager.set('API_TOKEN', 'value-one', { scope: 'user', medium: 'secure' });

    const storePath = userStorePath(dirs.home);
    const envelope = JSON.parse(readFileSync(storePath, 'utf-8')) as { data: string };
    envelope.data = envelope.data.replace(/^../, envelope.data.startsWith('00') ? '11' : '00');
    const tamperedBytes = `${JSON.stringify(envelope, null, 2)}\n`;
    writeFileSync(storePath, tamperedBytes, 'utf-8');

    const rereader = makeManager(dirs, identity);
    expect(await rereader.get('API_TOKEN')).toBeNull();
    await expect(rereader.set('API_TOKEN', 'value-two', { scope: 'user', medium: 'secure' }))
      .rejects.toBeInstanceOf(SecretStoreUnreadableError);
    expect(readFileSync(storePath, 'utf-8')).toBe(tamperedBytes);
  });

  test('a missing store file is a legitimately empty store and accepts writes', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs, { hostname: 'host', username: 'user' });
    expect(await manager.get('API_TOKEN')).toBeNull();
    await manager.set('API_TOKEN', 'fresh', { scope: 'user', medium: 'secure' });
    expect(await manager.get('API_TOKEN')).toBe('fresh');
  });

  test('an unreadable store is reported by inspect as existing but not readable', async () => {
    const dirs = makeScratch();
    const storePath = userStorePath(dirs.home);
    writeLegacyStore(storePath, { API_TOKEN: 'x' }, { hostname: 'origin-host', username: 'origin-user' });

    const manager = makeManager(dirs, { hostname: 'new-host', username: 'new-user' });
    const review = await manager.inspect();
    const location = review.locations.find((entry) => entry.path === storePath);
    expect(location?.exists).toBe(true);
    expect(location?.readable).toBe(false);
    expect(review.warnings.some((warning) => warning.includes(storePath))).toBe(true);
  });

  test('keyfile, store file, and keyfile directory carry restrictive permissions', async () => {
    const dirs = makeScratch();
    const manager = makeManager(dirs, { hostname: 'host', username: 'user' });
    await manager.set('API_TOKEN', 'value', { scope: 'user', medium: 'secure' });

    const keyFile = join(dirs.home, '.goodvibes', 'secrets.key');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dirs.home, '.goodvibes')).mode & 0o777).toBe(0o700);
    expect(statSync(userStorePath(dirs.home)).mode & 0o777).toBe(0o600);
  });

  test('plaintext writes also land with owner-only file permissions', async () => {
    const dirs = makeScratch();
    const manager = new SecretsManager({
      projectRoot: dirs.project,
      globalHome: dirs.home,
      surfaceRoot: 'testsurface',
      policy: 'plaintext_allowed',
      legacyIdentity: { hostname: 'host', username: 'user' },
    });
    await manager.set('API_TOKEN', 'value', { scope: 'user', medium: 'plaintext' });
    const plaintextPath = join(dirs.home, '.goodvibes', 'testsurface.secrets.json');
    expect(statSync(plaintextPath).mode & 0o777).toBe(0o600);
  });

  test('secret updates after migration stay readable and preserve neighbors', async () => {
    const dirs = makeScratch();
    const identity = { hostname: 'origin-host', username: 'origin-user' };
    const storePath = userStorePath(dirs.home);
    writeLegacyStore(storePath, { KEEP_ME: 'still-here', REPLACE_ME: 'old' }, identity);

    const manager = makeManager(dirs, identity);
    await manager.set('REPLACE_ME', 'new', { scope: 'user', medium: 'secure' });

    const rereader = makeManager(dirs, { hostname: 'elsewhere', username: 'someone-else' });
    expect(await rereader.get('KEEP_ME')).toBe('still-here');
    expect(await rereader.get('REPLACE_ME')).toBe('new');
  });
});
