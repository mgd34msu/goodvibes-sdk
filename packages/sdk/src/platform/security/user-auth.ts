import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface AuthUser {
  username: string;
  passwordHash: string;
  roles?: string[] | undefined;
}

export interface AuthSession {
  token: string;
  username: string;
  expiresAt: number;
}

interface UserAuthConfig {
  sessionTtlMs?: number | undefined;
  maxSessions?: number | undefined;
  users?: AuthUser[] | undefined;
  bootstrapFilePath: string;
  bootstrapCredentialPath: string;
}

const DEFAULT_SESSION_TTL_MS = 3_600_000;
const DEFAULT_MAX_SESSIONS = 1000;
const SCRYPT_KEY_LENGTH = 64;

interface AuthUserStore {
  readonly version: 1;
  readonly users: AuthUser[];
}

export interface AuthUserRecord {
  readonly username: string;
  readonly roles: readonly string[];
}

export interface AuthSessionRecord {
  readonly tokenFingerprint: string;
  readonly username: string;
  readonly expiresAt: number;
}

export interface LocalAuthSnapshot {
  readonly userStorePath: string;
  readonly bootstrapCredentialPath: string;
  readonly persisted: boolean;
  readonly bootstrapCredentialPresent: boolean;
  readonly userCount: number;
  readonly sessionCount: number;
  readonly users: readonly AuthUserRecord[];
  readonly sessions: readonly AuthSessionRecord[];
}

function toBase64(value: Buffer): string {
  return value.toString('base64');
}

function hashPassword(password: string, salt?: Buffer): string {
  const actualSalt = salt ?? randomBytes(16);
  const derived = scryptSync(password, actualSalt, SCRYPT_KEY_LENGTH);
  return `${toBase64(actualSalt)}:${toBase64(derived)}`;
}

/**
 * Generate a cryptographically random one-time password.
 * Called once on first boot when no users are configured.
 */
function generateInitialPassword(): string {
  return randomBytes(16).toString('hex');
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const [saltEncoded, hashEncoded] = passwordHash.split(':');
  if (!saltEncoded || !hashEncoded) return false;

  const salt = Buffer.from(saltEncoded, 'base64');
  const expected = Buffer.from(hashEncoded, 'base64');
  const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function readBootstrapUsers(filePath: string): AuthUser[] | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthUserStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.users)) return null;
    const users = parsed.users.filter((user): user is AuthUser =>
      Boolean(user)
      && typeof user.username === 'string'
      && typeof user.passwordHash === 'string'
      && (user.roles === undefined || Array.isArray(user.roles))
    );
    return users.length > 0 ? users : null;
  } catch {
    return null;
  }
}

/**
 * Write secret file content atomically at 0600 (owner read/write only).
 * Uses write-to-tmp-then-rename for atomicity; chmod applied at both
 * sides to defeat filesystem-reset behaviour on rename (observed on
 * some Linux fs drivers).
 */
function atomicWriteSecretFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch (error) {
    logger.warn('User auth secret temp chmod failed', { path: tmpPath, error: String(error) });
  }
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    logger.warn('User auth secret chmod failed after rename', { path: filePath, error: String(error) });
  }
}

function writeBootstrapUsers(filePath: string, users: AuthUser[]): void {
  // SEC-01: auth-user store contains scrypt password hashes — must be 0600.
  const payload: AuthUserStore = { version: 1, users };
  atomicWriteSecretFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeBootstrapCredentialFile(filePath: string, username: string, password: string): void {
  atomicWriteSecretFile(
    filePath,
    [
      'GoodVibes bootstrap auth',
      `username=${username}`,
      `password=${password}`,
      'purpose=Use these credentials only for local daemon/http listener /login routes when those surfaces are enabled.',
      'note=Normal SDK host usage does not require these credentials.',
    ].join('\n') + '\n',
  );
}

function loadOrBootstrapUsers(filePath: string, credentialPath: string): AuthUser[] {
  const existing = readBootstrapUsers(filePath);
  if (existing) return existing;

  const initialPassword = generateInitialPassword();
  const username = 'admin';
  const users: AuthUser[] = [
    {
      username,
      passwordHash: hashPassword(initialPassword),
      roles: ['admin'],
    },
  ];
  writeBootstrapUsers(filePath, users);
  writeBootstrapCredentialFile(credentialPath, username, initialPassword);
  return users;
}

interface BootstrapCredentialRecord {
  readonly username: string;
  readonly password: string;
}

function readBootstrapCredentialFile(filePath: string): BootstrapCredentialRecord | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    let username: string | undefined;
    let password: string | undefined;
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('username=')) username = line.slice('username='.length);
      else if (line.startsWith('password=')) password = line.slice('password='.length);
    }
    if (!username || !password) return null;
    return { username, password };
  } catch {
    return null;
  }
}

/**
 * Detects when the bootstrap credential file has drifted from the persisted
 * user store — typically after someone manually edits `auth-bootstrap.txt`
 * without rotating the password through the UserAuthManager. The daemon's
 * /login route will reject the edited password because the hash in
 * `auth-users.json` no longer matches. Left silent, this wastes hours of
 * debugging; loudly warning is cheap.
 */
function detectBootstrapCredentialDrift(
  users: AuthUser[],
  credentialPath: string,
  userStorePath: string,
): void {
  const credential = readBootstrapCredentialFile(credentialPath);
  if (!credential) return;
  const storedUser = users.find((user) => user.username === credential.username);
  if (!storedUser) {
    logger.warn(
      'Bootstrap credential file references a user not present in the auth store; /login with this username will fail',
      { credentialPath, userStorePath, username: credential.username },
    );
    return;
  }
  if (!verifyPassword(credential.password, storedUser.passwordHash)) {
    logger.warn(
      'Bootstrap credential file password does not match the stored hash; /login with this password will fail. Rotate the password via UserAuthManager.rotatePassword() or regenerate the credential by deleting both files so they are re-created in sync.',
      {
        credentialPath,
        userStorePath,
        username: credential.username,
        hint: 'Manual edits to auth-bootstrap.txt do not update auth-users.json. The bootstrap file is an output, not an input.',
      },
    );
  }
}

export class UserAuthManager {
  private users = new Map<string, AuthUser>();
  private sessions = new Map<string, AuthSession>();
  private sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly userStorePath: string;
  private readonly bootstrapCredentialPath: string;
  private readonly persistUsers: boolean;

  constructor(config: UserAuthConfig) {
    if (!config.bootstrapFilePath) throw new Error('UserAuthManager requires an explicit bootstrapFilePath.');
    if (!config.bootstrapCredentialPath) throw new Error('UserAuthManager requires an explicit bootstrapCredentialPath.');
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.userStorePath = config.bootstrapFilePath;
    this.bootstrapCredentialPath = config.bootstrapCredentialPath;
    this.persistUsers = config.users === undefined;
    const seedUsers = config.users ?? loadOrBootstrapUsers(this.userStorePath, this.bootstrapCredentialPath);

    for (const user of seedUsers) {
      this.users.set(user.username, user);
    }

    // Only run drift detection when we own the file-backed store — test
    // configs that pass explicit `users` opt out of filesystem bootstrap and
    // should not trigger spurious warnings.
    if (this.persistUsers) {
      detectBootstrapCredentialDrift(seedUsers, this.bootstrapCredentialPath, this.userStorePath);
    }
  }

  static hashPassword(password: string): string {
    return hashPassword(password);
  }

  authenticate(username: string, password: string): AuthUser | null {
    const user = this.users.get(username);
    if (!user) return null;
    return verifyPassword(password, user.passwordHash) ? user : null;
  }

  getUser(username: string): AuthUserRecord | null {
    const user = this.users.get(username);
    if (!user) return null;
    return {
      username: user.username,
      roles: Object.freeze([...(user.roles ?? [])]),
    };
  }

  createSession(username: string): AuthSession {
    this.pruneExpiredSessions();
    if (this.sessions.size >= this.maxSessions) {
      // Evict the session with the earliest expiry to make room.
      let oldestToken: string | undefined;
      let oldestExpiry = Infinity;
      for (const [token, session] of this.sessions.entries()) {
        if (session.expiresAt < oldestExpiry) {
          oldestExpiry = session.expiresAt;
          oldestToken = token;
        }
      }
      if (oldestToken !== undefined) {
        this.sessions.delete(oldestToken);
      }
    }
    const token = randomBytes(32).toString('hex');
    const session: AuthSession = {
      token,
      username,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  validateSession(token: string): AuthSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revokeSession(token: string): boolean {
    if (this.sessions.delete(token)) return true;
    for (const sessionToken of this.sessions.keys()) {
      if (fingerprintToken(sessionToken) === token) {
        this.sessions.delete(sessionToken);
        return true;
      }
    }
    return false;
  }

  revokeSessionsForUser(username: string): number {
    let removed = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) {
        this.sessions.delete(token);
        removed++;
      }
    }
    return removed;
  }

  listUsers(): AuthUserRecord[] {
    return [...this.users.values()]
      .map((user) => ({
        username: user.username,
        roles: Object.freeze([...(user.roles ?? [])]),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  listSessions(): AuthSessionRecord[] {
    this.pruneExpiredSessions();
    return [...this.sessions.values()]
      .map((session) => ({
        tokenFingerprint: fingerprintToken(session.token),
        username: session.username,
        expiresAt: session.expiresAt,
      }))
      .sort((a, b) => a.username.localeCompare(b.username) || a.expiresAt - b.expiresAt);
  }

  addUser(username: string, password: string, roles: readonly string[] = ['admin']): AuthUserRecord {
    const normalized = username.trim();
    if (!normalized) throw new Error('Username is required.');
    if (this.users.has(normalized)) throw new Error(`User already exists: ${normalized}`);
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
    const user: AuthUser = {
      username: normalized,
      passwordHash: hashPassword(password),
      roles: [...new Set(roles.filter(Boolean))],
    };
    this.users.set(normalized, user);
    this.persist();
    return { username: user.username, roles: Object.freeze([...(user.roles ?? [])]) };
  }

  deleteUser(username: string): boolean {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) return false;
    if (this.users.size <= 1) {
      throw new Error('Cannot delete the last local auth user.');
    }
    this.users.delete(normalized);
    this.revokeSessionsForUser(normalized);
    this.persist();
    return true;
  }

  rotatePassword(username: string, nextPassword: string): void {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) throw new Error(`Unknown local auth user: ${normalized}`);
    if (!nextPassword || nextPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    this.users.set(normalized, {
      ...existing,
      passwordHash: hashPassword(nextPassword),
    });
    this.revokeSessionsForUser(normalized);
    this.persist();
    if (normalized === 'admin') {
      writeBootstrapCredentialFile(this.bootstrapCredentialPath, normalized, nextPassword);
    }
  }

  inspect(): LocalAuthSnapshot {
    this.pruneExpiredSessions();
    return Object.freeze({
      userStorePath: this.userStorePath,
      bootstrapCredentialPath: this.bootstrapCredentialPath,
      persisted: this.persistUsers,
      bootstrapCredentialPresent: existsSync(this.bootstrapCredentialPath),
      userCount: this.users.size,
      sessionCount: this.sessions.size,
      users: Object.freeze(this.listUsers()),
      sessions: Object.freeze(this.listSessions()),
    });
  }

  clearBootstrapCredentialFile(): boolean {
    if (!existsSync(this.bootstrapCredentialPath)) return false;
    rmSync(this.bootstrapCredentialPath, { force: true });
    return true;
  }

  getBootstrapCredentialPath(): string {
    return this.bootstrapCredentialPath;
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }

  private persist(): void {
    if (!this.persistUsers) return;
    writeBootstrapUsers(this.userStorePath, [...this.users.values()]);
  }
}
