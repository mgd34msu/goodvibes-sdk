/**
 * routes/checkpoint-restore-tokens.ts
 *
 * In-memory, single-use, short-lived confirmation tokens for the
 * `checkpoints.restore` server-side confirmation gate.
 *
 * `checkpoints.restorePreview` mints a token bound to the checkpoint id it
 * previewed; the matching `checkpoints.restore` call consumes it exactly once.
 * A token expires ~2 minutes after issue and is destroyed the moment it is
 * consumed, so it can neither be replayed nor outlive the caller's decision.
 * This is deliberately NOT a durable, cross-process two-phase protocol — it is
 * a lightweight acknowledgment that a preview was seen, held only in the live
 * daemon process that will perform the restore.
 */
import { randomUUID } from 'node:crypto';

/** ~2 minutes: long enough for a human to read a preview and confirm, short enough to not linger. */
export const RESTORE_TOKEN_TTL_MS = 120_000;

interface StoredToken {
  readonly checkpointId: string;
  readonly expiresAt: number;
}

export interface IssuedRestoreToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * A tiny map-backed store of restore-confirmation tokens. Not exported through
 * the SDK public surface — constructed once per daemon at checkpoint-route
 * registration and shared between the preview and restore handlers.
 */
export class RestoreTokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = RESTORE_TOKEN_TTL_MS,
  ) {}

  /** Mint a fresh single-use token bound to `checkpointId`. */
  issue(checkpointId: string): IssuedRestoreToken {
    this.pruneExpired();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { checkpointId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Consume `token` for a restore of `checkpointId`. Returns true only when the
   * token exists, has not expired, and was minted for this exact checkpoint id.
   * The token is removed on any consume attempt that finds it (success or
   * checkpoint-id mismatch), so it can never be reused.
   */
  consume(token: string, checkpointId: string): boolean {
    const stored = this.tokens.get(token);
    if (!stored) return false;
    // Single-use: found means spent, regardless of the outcome below.
    this.tokens.delete(token);
    if (stored.expiresAt <= this.now()) return false;
    if (stored.checkpointId !== checkpointId) return false;
    return true;
  }

  /** Drop every token past its TTL. Called opportunistically on issue. */
  private pruneExpired(): void {
    const cutoff = this.now();
    for (const [token, stored] of this.tokens) {
      if (stored.expiresAt <= cutoff) this.tokens.delete(token);
    }
  }
}
