/**
 * pairing/pairing-token-store.ts
 *
 * Per-pairing operator tokens: every device/browser that pairs mints its OWN
 * named, individually-revocable token, instead of everyone sharing the one
 * operator token. Revoking one device leaves the others working.
 *
 * Custody: only a SHA-256 hash of each token is persisted. The plaintext secret
 * is returned exactly once, at mint time (for the QR / pairing hand-off); after
 * that the daemon authenticates by hashing the presented token and looking the
 * hash up, so the listable record never contains the secret. `list()` hands
 * back name / created / last-seen only — never the hash, never the secret.
 *
 * Revocation is immediate: `revoke()` deletes the record, so the very next
 * `authenticate()` of that token misses and the request is unauthorized.
 *
 * The legacy single shared token keeps working (authenticated elsewhere) until
 * it is revoked here via `revokeLegacyShared()`; a client on the shared token
 * calls `mintForMigration()` once to move to its own per-device token.
 *
 * Storage is synchronous JSON at mode 0600 (the same custody posture as the
 * shared operator token file), because the auth path that consults it is itself
 * synchronous — one in-memory index, flushed on every mutation.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

const TOKEN_PREFIX = 'gvp_';
/** Do not thrash the disk stamping last-seen on every request. */
const LAST_SEEN_FLUSH_INTERVAL_MS = 10_000;

/** A per-pairing token as stored on disk — the hash, never the secret. */
interface StoredPairingToken {
  readonly id: string;
  name: string;
  /** SHA-256 hex of the token value. The plaintext is never persisted. */
  readonly tokenHash: string;
  readonly createdAt: number;
  lastSeenAt?: number | undefined;
}

interface PairingTokenSnapshot {
  tokens: StoredPairingToken[];
  /** Once true, the legacy single shared token no longer authenticates. */
  legacyRevoked?: boolean | undefined;
}

/** The redacted, wire-safe view of a pairing token — no hash, no secret. */
export interface PublicPairingToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number | undefined;
}

/** The result of minting a token — the ONLY time the plaintext secret is exposed. */
export interface MintedPairingToken {
  readonly id: string;
  readonly name: string;
  /** The plaintext token — returned once, never stored, never listed again. */
  readonly token: string;
  readonly createdAt: number;
}

/** What a successful authenticate resolves to: the identity behind the token. */
export interface AuthenticatedPairingToken {
  readonly id: string;
  readonly name: string;
  /** Stable per-token principal id (`pairing:<id>`), so step-up keys per token. */
  readonly principalId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

/** The `pairing:<id>` principal id a pairing-token request authenticates as. */
export function pairingPrincipalId(tokenId: string): string {
  return `pairing:${tokenId}`;
}

export class PairingTokenManager {
  private readonly filePath: string;
  private snapshot: PairingTokenSnapshot;
  /** hash -> record, for O(1) synchronous auth lookup. */
  private index = new Map<string, StoredPairingToken>();
  private lastSeenFlushAt = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.snapshot = this.load();
    this.reindex();
  }

  private load(): PairingTokenSnapshot {
    if (!existsSync(this.filePath)) return { tokens: [] };
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PairingTokenSnapshot;
      return {
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
        legacyRevoked: parsed.legacyRevoked === true,
      };
    } catch {
      // A corrupt file must not brick auth: start clean rather than throw.
      return { tokens: [] };
    }
  }

  private reindex(): void {
    this.index = new Map(this.snapshot.tokens.map((t) => [t.tokenHash, t]));
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        chmodSync(this.filePath, 0o600);
      } catch (error) {
        logger.warn('Pairing token chmod failed after write', { path: this.filePath, error: String(error) });
      }
    } catch (error) {
      logger.warn('Pairing token store flush failed', { path: this.filePath, error: String(error) });
    }
  }

  /** Mint a new named per-device token. The plaintext is returned only here. */
  mint(input: { readonly name: string }): MintedPairingToken {
    const token = generateTokenValue();
    const record: StoredPairingToken = {
      id: `pair-${randomUUID()}`,
      name: input.name.trim() || 'Unnamed device',
      tokenHash: hashToken(token),
      createdAt: Date.now(),
    };
    this.snapshot.tokens.push(record);
    this.index.set(record.tokenHash, record);
    this.flush();
    return { id: record.id, name: record.name, token, createdAt: record.createdAt };
  }

  /**
   * A client currently on the legacy shared token moves to its own per-device
   * token. Identical to mint — the "one receipt" is this single return; it does
   * NOT revoke the shared token (that is a separate, explicit step).
   */
  mintForMigration(input: { readonly name: string }): MintedPairingToken {
    return this.mint(input);
  }

  /**
   * Authenticate a presented token by hashing it and looking the hash up.
   * Immediate revocation: a revoked (deleted) token misses here and the caller
   * treats the request as unauthorized. Stamps last-seen (throttled to disk).
   */
  authenticate(token: string): AuthenticatedPairingToken | null {
    const normalized = token.trim();
    if (!normalized.startsWith(TOKEN_PREFIX)) return null;
    const record = this.index.get(hashToken(normalized));
    if (!record) return null;
    const now = Date.now();
    record.lastSeenAt = now;
    if (now - this.lastSeenFlushAt >= LAST_SEEN_FLUSH_INTERVAL_MS) {
      this.lastSeenFlushAt = now;
      this.flush();
    }
    return { id: record.id, name: record.name, principalId: pairingPrincipalId(record.id) };
  }

  /** Every per-pairing token, redacted (name / created / last-seen), never the secret. */
  list(): PublicPairingToken[] {
    return this.snapshot.tokens.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      ...(t.lastSeenAt !== undefined ? { lastSeenAt: t.lastSeenAt } : {}),
    }));
  }

  /** Rename a token's user-visible label. False when the id is unknown. */
  rename(id: string, name: string): boolean {
    const record = this.snapshot.tokens.find((t) => t.id === id);
    if (!record) return false;
    record.name = name.trim() || record.name;
    this.flush();
    return true;
  }

  /**
   * Revoke a single device's token. Delete means delete: the record is dropped
   * and the token fails the very next authenticate. False when already absent.
   */
  revoke(id: string): boolean {
    const before = this.snapshot.tokens.length;
    this.snapshot.tokens = this.snapshot.tokens.filter((t) => t.id !== id);
    if (this.snapshot.tokens.length === before) return false;
    this.reindex();
    this.flush();
    return true;
  }

  /** Whether the legacy single shared token has been revoked here. */
  isLegacyRevoked(): boolean {
    return this.snapshot.legacyRevoked === true;
  }

  /** Revoke the legacy single shared token; it stops authenticating immediately. */
  revokeLegacyShared(): void {
    if (this.snapshot.legacyRevoked === true) return;
    this.snapshot.legacyRevoked = true;
    this.flush();
  }
}
