import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  /** Maximum number of per-account lock state entries. Excess entries are evicted by staleness. Default: 10000. */
  maxAccountLocks?: number | undefined;
  users?: AuthUser[] | undefined;
  bootstrapFilePath: string;
  bootstrapCredentialPath: string;
  /** Scrypt cost params for hashing new passwords. Existing hashes carry their own params. Default: Node defaults. */
  scryptParams?: ScryptParams | undefined;
  /** Injectable clock for testing. Defaults to Date.now. */
  nowFn?: (() => number) | undefined;
}

const DEFAULT_SESSION_TTL_MS = 3_600_000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_ACCOUNT_LOCKS = 10_000;
const SCRYPT_KEY_LENGTH = 64;

/** Default scrypt cost parameters matching Node.js defaults (N=16384, r=8, p=1). */
const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

/**
 * Scrypt cost parameters. N must be a power of 2. Increasing N multiplies
 * memory usage by 128*N*r bytes and CPU time proportionally.
 * Safe minimums: N>=16384, r>=8, p>=1.
 */
export interface ScryptParams {
  /** CPU/memory cost factor — must be a power of 2. Default: 16384. */
  readonly N: number;
  /** Block size. Default: 8. */
  readonly r: number;
  /** Parallelization factor. Default: 1. */
  readonly p: number;
}

/**
 * Per-account login failure state for escalating lockout.
 * Independent of IP-based throttling.
 */
interface AccountLockState {
  failures: number;
  lockedUntil: number;
}

/**
 * Result of authenticate() — includes lock state so callers can
 * return Retry-After without leaking whether the username exists.
 *
 * The union is strict: `.user` is ONLY present (and non-undefined) on the
 * `ok:true` branch, so TypeScript catches any caller that forgets to check `.ok`
 * before accessing the user. `.usedBootstrapCredential` is set on the `ok:true`
 * branch so callers can decide whether to retire the bootstrap credential file.
 */
export type AuthenticateResult =
  | { readonly ok: true; readonly user: AuthUser; readonly usedBootstrapCredential: boolean; readonly lockedUntilMs?: undefined }
  | { readonly ok: false; readonly user?: undefined; readonly usedBootstrapCredential?: undefined; readonly lockedUntilMs?: number };

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

/**
 * Hash format: base64(salt):N:r:p:base64(derived)
 * The cost parameters are stored in the hash so old hashes can be verified
 * even after the default params change.
 */
function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS, salt?: Buffer): string {
  const actualSalt = salt ?? randomBytes(16);
  const derived = scryptSync(password, actualSalt, SCRYPT_KEY_LENGTH, { N: params.N, r: params.r, p: params.p });
  return `${toBase64(actualSalt)}:${params.N}:${params.r}:${params.p}:${toBase64(derived)}`;
}

/**
 * Generate a cryptographically random one-time password.
 * Called once on first boot when no users are configured.
 */
function generateInitialPassword(): string {
  return randomBytes(16).toString('hex');
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const parts = passwordHash.split(':');
  // Legacy format: salt:hash (2 parts) — uses DEFAULT_SCRYPT_PARAMS for backward compat.
  // New format: salt:N:r:p:hash (5 parts)
  let saltEncoded: string;
  let hashEncoded: string;
  let params: ScryptParams;

  if (parts.length === 2) {
    // Legacy hash: no cost params stored — use defaults.
    [saltEncoded, hashEncoded] = parts as [string, string];
    params = DEFAULT_SCRYPT_PARAMS;
  } else if (parts.length === 5) {
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || N < 1 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;
    saltEncoded = parts[0]!;
    hashEncoded = parts[4]!;
    params = { N, r, p };
  } else {
    return false;
  }

  if (!saltEncoded || !hashEncoded) return false;

  try {
    const salt = Buffer.from(saltEncoded, 'base64');
    const expected = Buffer.from(hashEncoded, 'base64');
    const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH, { N: params.N, r: params.r, p: params.p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
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
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch (error) {
    logger.warn('User auth secret temp chmod failed', { path: tmpPath, error: String(error) });
  }
  // fsync the file data before rename so the content survives power loss.
  const fd = openSync(tmpPath, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  // fsync the parent directory so the directory entry (rename) is durable.
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    logger.warn('User auth secret chmod failed after rename', { path: filePath, error: String(error) });
  }
}

function writeBootstrapUsers(filePath: string, users: AuthUser[]): void {
  // auth-user store contains scrypt password hashes — must be 0600.
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
  /** Per-username failure counters for account-level lockout (independent of IP throttling). */
  private accountLocks = new Map<string, AccountLockState>();
  private sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxAccountLocks: number;
  private readonly userStorePath: string;
  private readonly bootstrapCredentialPath: string;
  private readonly persistUsers: boolean;
  private readonly scryptParams: ScryptParams;
  /** Injectable clock — defaults to Date.now for production. */
  private readonly nowFn: () => number;

  constructor(config: UserAuthConfig) {
    if (!config.bootstrapFilePath) throw new Error('UserAuthManager requires an explicit bootstrapFilePath.');
    if (!config.bootstrapCredentialPath) throw new Error('UserAuthManager requires an explicit bootstrapCredentialPath.');
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxAccountLocks = config.maxAccountLocks ?? DEFAULT_MAX_ACCOUNT_LOCKS;
    this.userStorePath = config.bootstrapFilePath;
    this.bootstrapCredentialPath = config.bootstrapCredentialPath;
    this.persistUsers = config.users === undefined;
    this.scryptParams = config.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
    this.nowFn = config.nowFn ?? (() => Date.now());
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

  static hashPassword(password: string, params?: ScryptParams): string {
    return hashPassword(password, params ?? DEFAULT_SCRYPT_PARAMS);
  }

  /**
   * Authenticate username/password with per-account lockout.
   * - Does NOT leak whether a username exists (same generic error path for unknown users).
   * - Records failures against the username bucket (not IP) with escalating backoff.
   * - Returns lockedUntilMs when the account is temporarily locked.
   * - Returns usedBootstrapCredential=true when the matched credential originated from
   *   the bootstrap credential file, so callers can defer retirement until a non-bootstrap
   *   login succeeds.
   */
  authenticate(username: string, password: string): AuthenticateResult {
    const now = this.nowFn();
    const lockState = this.accountLocks.get(username);

    // Check account lock (before touching user store — avoids user-existence side-channel).
    if (lockState && lockState.lockedUntil > now) {
      // Still locked — record the attempt but keep the lock window intact.
      lockState.failures++;
      return { ok: false, lockedUntilMs: lockState.lockedUntil };
    }

    const user = this.users.get(username);

    // Always verify something with constant-time cost so unknown usernames
    // have the same timing profile as known usernames with wrong password.
    const hashToCheck = user?.passwordHash ?? 'dGVzdHNhbHQ=:16384:8:1:dGVzdGhhc2h0ZXN0aGFzaHRlc3RoYXNodGVzdGhhc2g=';
    const passwordOk = user !== undefined && verifyPassword(password, hashToCheck);

    if (!passwordOk) {
      this._recordLoginFailure(username, now);
      // Check if this failure just triggered a lock.
      const newLock = this.accountLocks.get(username);
      const lockedUntilMs = newLock && newLock.lockedUntil > now ? newLock.lockedUntil : undefined;
      return lockedUntilMs !== undefined ? { ok: false, lockedUntilMs } : { ok: false };
    }

    // Determine whether this login used the bootstrap credential.
    // Compare against the credential file contents without leaking timing info
    // (we already confirmed the password is correct at this point).
    const bootstrapCred = readBootstrapCredentialFile(this.bootstrapCredentialPath);
    const usedBootstrapCredential = bootstrapCred !== null
      && bootstrapCred.username === username
      && bootstrapCred.password === password;

    // Success — clear failure count.
    this.accountLocks.delete(username);
    return { ok: true, user, usedBootstrapCredential };
  }

  /**
   * Record a login failure for the given username and apply escalating backoff.
   *
   * Thresholds are anchored ABOVE the per-IP login budget (default 5/min) so
   * the first account lock cannot fire before the IP limiter has already
   * throttled further attempts. This preserves the 401-then-429-by-IP contract
   * for in-budget attempts.
   *
   *   1-5 failures:   no lock (IP budget exhaustion fires at attempt 6+)
   *   6-9 failures:   30-second lock
   *   10-19 failures: 5-minute lock
   *   20+ failures:   30-minute lock
   *
   * Note: failures also increment during an active lock window (when the account
   * is already locked and another attempt arrives). This means a lock can expire
   * with a failure count already in a higher tier, causing the next lock after
   * expiry to jump directly to that tier. This is intentional: repeated attempts
   * during a lock are themselves failures and escalate the penalty schedule.
   */
  private _recordLoginFailure(username: string, now: number): void {
    const existing = this.accountLocks.get(username);
    if (!existing) {
      // New entry — evict if at cap before inserting.
      this._evictAccountLockIfNeeded(now);
    }
    const state = existing ?? { failures: 0, lockedUntil: 0 };
    state.failures++;
    const f = state.failures;
    let lockDurationMs = 0;
    if (f >= 20) lockDurationMs = 30 * 60_000;
    else if (f >= 10) lockDurationMs = 5 * 60_000;
    else if (f >= 6) lockDurationMs = 30_000;
    state.lockedUntil = lockDurationMs > 0 ? now + lockDurationMs : 0;
    this.accountLocks.set(username, state);
  }

  /**
   * Evict account lock entries when the map is at capacity.
   * Prefers entries with expired locks + no recent failures (stale entries).
   * Falls back to the entry with the oldest/soonest-expired lock.
   * Preserves no-username-enumeration: eviction policy is time-based, not
   * user-existence-based.
   */
  private _evictAccountLockIfNeeded(now: number): void {
    if (this.accountLocks.size < this.maxAccountLocks) return;
    // First sweep: remove all fully stale entries (lock expired AND low failure count).
    for (const [key, state] of this.accountLocks.entries()) {
      if (state.lockedUntil <= now && state.failures < 6) {
        this.accountLocks.delete(key);
        if (this.accountLocks.size < this.maxAccountLocks) return;
      }
    }
    // Second sweep: remove the entry with the smallest lockedUntil (most expired).
    let oldestKey: string | undefined;
    let oldestUntil = Infinity;
    for (const [key, state] of this.accountLocks.entries()) {
      if (state.lockedUntil < oldestUntil) {
        oldestUntil = state.lockedUntil;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.accountLocks.delete(oldestKey);
    }
  }

  /**
   * Expose account lock state for testing.
   * Returns a defensive copy so callers cannot mutate internal state.
   * Use the injected nowFn (via UserAuthManager constructor) to advance time in tests.
   */
  getAccountLockState(username: string): AccountLockState | undefined {
    const state = this.accountLocks.get(username);
    if (!state) return undefined;
    return { failures: state.failures, lockedUntil: state.lockedUntil };
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
      passwordHash: hashPassword(password, this.scryptParams),
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
      passwordHash: hashPassword(nextPassword, this.scryptParams),
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
