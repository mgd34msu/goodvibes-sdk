/**
 * SEC-01: auth-user store (scrypt password hashes) must be written with mode 0600.
 *
 * Covers:
 *   - writeBootstrapUsers (via internal persist() path)
 *   - loadOrBootstrapUsers bootstrap path (new file created from scratch)
 *   - rotatePassword (triggers re-persist)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../packages/sdk/src/platform/security/user-auth.js';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-sec01-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('SEC-01: auth-user store file permissions', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir('auth'); });
  afterEach(() => { cleanup(dir); });

  test('bootstrap write: auth-users.json is created with mode 0600', () => {
    const bootstrapFilePath = join(dir, 'auth-users.json');
    const bootstrapCredentialPath = join(dir, 'auth-bootstrap.txt');
    // Constructing UserAuthManager with no users triggers bootstrap write
    const mgr = new UserAuthManager({ bootstrapFilePath, bootstrapCredentialPath });
    void mgr;

    expect(existsSync(bootstrapFilePath)).toBe(true);
    const mode = statSync(bootstrapFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('addUser + persist: auth-users.json remains 0600 after user added', () => {
    const bootstrapFilePath = join(dir, 'auth-users.json');
    const bootstrapCredentialPath = join(dir, 'auth-bootstrap.txt');
    const mgr = new UserAuthManager({ bootstrapFilePath, bootstrapCredentialPath });
    mgr.addUser('alice', 'alicepass123', ['admin']);

    const mode = statSync(bootstrapFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('rotatePassword: auth-users.json remains 0600 after password rotation', () => {
    const bootstrapFilePath = join(dir, 'auth-users.json');
    const bootstrapCredentialPath = join(dir, 'auth-bootstrap.txt');
    const mgr = new UserAuthManager({ bootstrapFilePath, bootstrapCredentialPath });
    // admin is created during bootstrap; rotate its password
    mgr.rotatePassword('admin', 'newpassword999');

    const mode = statSync(bootstrapFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('deleteUser + persist: auth-users.json remains 0600 after deletion', () => {
    const bootstrapFilePath = join(dir, 'auth-users.json');
    const bootstrapCredentialPath = join(dir, 'auth-bootstrap.txt');
    const mgr = new UserAuthManager({ bootstrapFilePath, bootstrapCredentialPath });
    mgr.addUser('bob', 'bobpassword1', ['admin']);
    mgr.deleteUser('bob');

    const mode = statSync(bootstrapFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
