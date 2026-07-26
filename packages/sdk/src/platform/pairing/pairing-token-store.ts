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

/**
 * A pairing was refused because the paired-node cap is full.
 *
 * Carries the setting name, the cap and the live count so the refusal a caller
 * renders says what to change and what the current state is, rather than a bare
 * "failed". `code` is what the control-plane verbs map to their wire error.
 */
export class PairingLimitReachedError extends Error {
  readonly code = 'DEVICE_NODES_MAX_PAIRED';
  readonly setting = 'device.nodes.maxPaired';
  constructor(readonly maxPaired: number, readonly pairedCount: number) {
    super(
      `Cannot pair another device: device.nodes.maxPaired is ${maxPaired} and ${pairedCount} `
      + `${pairedCount === 1 ? 'device is' : 'devices are'} already paired. `
      + 'Unpair a device, or raise device.nodes.maxPaired.',
    );
    this.name = 'PairingLimitReachedError';
  }
}

/** How the store learns the live cap. Absent ⇒ unbounded, exactly as before. */
export interface PairingTokenManagerOptions {
  /**
   * Reads `device.nodes.maxPaired` at mint time. A function, not a number, so a
   * cap change takes effect on the next pairing without re-constructing the
   * store — and so this module never has to depend on ConfigManager.
   */
  readonly maxPaired?: (() => number | undefined) | undefined;
}

export class PairingTokenManager {
  private readonly filePath: string;
  private snapshot: PairingTokenSnapshot;
  /** hash -> record, for O(1) synchronous auth lookup. */
  private index = new Map<string, StoredPairingToken>();
  private lastSeenFlushAt = 0;
  private readonly readMaxPaired: (() => number | undefined) | null;

  constructor(filePath: string, options: PairingTokenManagerOptions = {}) {
    this.filePath = filePath;
    this.readMaxPaired = options.maxPaired ?? null;
    this.snapshot = this.load();
    this.reindex();
  }

  /**
   * The configured cap, or null when there is none / it is unusable.
   *
   * A non-positive or non-finite value is treated as "no cap" rather than "no
   * device may ever pair": a broken setting must not lock the owner out of
   * their own daemon.
   */
  private currentCap(): number | null {
    if (!this.readMaxPaired) return null;
    let raw: number | undefined;
    try {
      raw = this.readMaxPaired();
    } catch {
      return null;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.floor(raw);
  }

  /** How many paired device nodes exist right now — one record per node. */
  pairedCount(): number {
    return this.snapshot.tokens.length;
  }

  /**
   * Whether `name` is a node that is already paired (case/whitespace-insensitive).
   *
   * The pairing exchange carries a name and nothing else, so the name IS the
   * node's identity here. A device re-pairing under the name it already holds is
   * the same node, not an additional one.
   */
  private findByName(name: string): StoredPairingToken | undefined {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return undefined;
    return this.snapshot.tokens.find((t) => t.name.trim().toLowerCase() === normalized);
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

  /**
   * Mint a new named per-device token. The plaintext is returned only here.
   *
   * Bounded by `device.nodes.maxPaired` when the host supplied a reader for it.
   * The rules, all of which are exercised by tests:
   *
   * - Below the cap nothing changes at all — same append, same result.
   * - At the cap, a NEW node is refused with {@link PairingLimitReachedError},
   *   which names the setting, the cap and the live count.
   * - At the cap, a node that is ALREADY paired (same name) is never refused: it
   *   supersedes its own record, so re-pairing a phone that is already in the
   *   list keeps working and the count does not creep past the cap. Nobody
   *   else's pairing is touched.
   * - Lowering the cap below the current count unpairs NO ONE: existing tokens
   *   keep authenticating; only the next NEW pairing is refused, until enough
   *   devices are unpaired to fit under the cap again.
   */
  mint(input: { readonly name: string }): MintedPairingToken {
    return this.mintInternal(input, { enforceCap: true });
  }

  private mintInternal(
    input: { readonly name: string },
    options: { readonly enforceCap: boolean },
  ): MintedPairingToken {
    const cap = options.enforceCap ? this.currentCap() : null;
    if (cap !== null && this.snapshot.tokens.length >= cap) {
      const existing = this.findByName(input.name);
      if (!existing) {
        throw new PairingLimitReachedError(cap, this.snapshot.tokens.length);
      }
      // The same node pairing again. Its previous token is superseded (and
      // therefore stops authenticating), which is what "re-pair this device"
      // means; it is not an unpairing of some other device.
      logger.info('Pairing at the device.nodes.maxPaired cap: re-pairing an already paired node', {
        name: existing.name,
        maxPaired: cap,
        pairedCount: this.snapshot.tokens.length,
      });
      this.snapshot.tokens = this.snapshot.tokens.filter((t) => t.id !== existing.id);
      this.reindex();
    }
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
   * token. The "one receipt" is this single return; it does NOT revoke the
   * shared token (that is a separate, explicit step).
   *
   * Deliberately EXEMPT from `device.nodes.maxPaired`: this device is already
   * using this daemon on the shared token. Refusing it would strand a working
   * device on a credential it is being asked to give up, which is a worse
   * outcome than being one over a cap that no longer describes reality. A new
   * device pairing for the first time is still bounded.
   */
  mintForMigration(input: { readonly name: string }): MintedPairingToken {
    return this.mintInternal(input, { enforceCap: false });
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
