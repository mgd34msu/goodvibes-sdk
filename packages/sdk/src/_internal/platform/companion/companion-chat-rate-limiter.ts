/**
 * companion-chat-rate-limiter.ts
 *
 * Token-bucket rate limiter for CompanionChatManager.
 *
 * Enforces two independent limits:
 *   - per-client: max N messages/minute across all sessions for a given clientId.
 *   - per-session: max M messages/minute for a given sessionId regardless of client.
 *
 * When a limit is exceeded, throws GoodVibesSdkError with kind='rate-limit',
 * including an actionable message following the Wave 6 three-part standard:
 *   [what happened] · [why] · [what to do]
 */

import { GoodVibesSdkError } from '../../errors/index.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MESSAGES_PER_MINUTE_PER_CLIENT = 30;
export const DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION = 10;

// ---------------------------------------------------------------------------
// Bucket state
// ---------------------------------------------------------------------------

interface Bucket {
  /** Timestamps of recent messages within the rolling window. */
  timestamps: number[];
}

// ---------------------------------------------------------------------------
// CompanionChatRateLimiter
// ---------------------------------------------------------------------------

export interface CompanionChatRateLimiterOptions {
  /** Max messages per 60-second window per clientId. Default: 30. */
  readonly perClientLimit?: number;
  /** Max messages per 60-second window per sessionId. Default: 10. */
  readonly perSessionLimit?: number;
  /** Window size in ms. Default: 60000 (1 minute). */
  readonly windowMs?: number;
}

export class CompanionChatRateLimiter {
  private readonly perClientLimit: number;
  private readonly perSessionLimit: number;
  private readonly windowMs: number;

  /** clientId → bucket */
  private readonly clientBuckets = new Map<string, Bucket>();
  /** sessionId → bucket */
  private readonly sessionBuckets = new Map<string, Bucket>();

  constructor(options: CompanionChatRateLimiterOptions = {}) {
    this.perClientLimit = options.perClientLimit ?? DEFAULT_MESSAGES_PER_MINUTE_PER_CLIENT;
    this.perSessionLimit = options.perSessionLimit ?? DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION;
    this.windowMs = options.windowMs ?? 60_000;
  }

  /**
   * Check and record a message attempt.
   *
   * Throws GoodVibesSdkError{kind:'rate-limit'} if either limit is exceeded.
   * On success, the attempt is recorded in both buckets.
   *
   * @param sessionId - The session receiving the message.
   * @param clientId  - The client sending the message (use '' to skip per-client check).
   */
  check(sessionId: string, clientId: string): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // --- Per-session check ---
    const sessionBucket = this.getOrCreate(this.sessionBuckets, sessionId, cutoff);
    if (sessionBucket.timestamps.length >= this.perSessionLimit) {
      const oldestTs = sessionBucket.timestamps[0]!;
      const retryAfterMs = this.windowMs - (now - oldestTs) + 1;
      throw new GoodVibesSdkError(
        `Companion chat session rate limit exceeded: this session has sent ${this.perSessionLimit} messages in the last minute. ` +
          `Each session is limited to ${this.perSessionLimit} messages per minute to prevent runaway conversations. ` +
          `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before sending the next message, or create a new session.`,
        {
          category: 'rate_limit',
          source: 'runtime',
          recoverable: true,
          retryAfterMs,
          code: 'COMPANION_CHAT_SESSION_RATE_LIMIT',
        },
      );
    }

    // --- Per-client check (skip when clientId is empty) ---
    if (clientId) {
      const clientBucket = this.getOrCreate(this.clientBuckets, clientId, cutoff);
      if (clientBucket.timestamps.length >= this.perClientLimit) {
        const oldestTs = clientBucket.timestamps[0]!;
        const retryAfterMs = this.windowMs - (now - oldestTs) + 1;
        throw new GoodVibesSdkError(
          `Companion chat client rate limit exceeded: client '${clientId}' has sent ${this.perClientLimit} messages in the last minute. ` +
            `Each client is limited to ${this.perClientLimit} messages per minute across all sessions. ` +
            `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before sending the next message.`,
          {
            category: 'rate_limit',
            source: 'runtime',
            recoverable: true,
            retryAfterMs,
            code: 'COMPANION_CHAT_CLIENT_RATE_LIMIT',
          },
        );
      }
      clientBucket.timestamps.push(now);
    }

    // Record in session bucket (after both checks pass)
    sessionBucket.timestamps.push(now);
  }

  /** Remove stale buckets to prevent unbounded memory growth. */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, bucket] of this.sessionBuckets) {
      prune(bucket, cutoff);
      if (bucket.timestamps.length === 0) this.sessionBuckets.delete(id);
    }
    for (const [id, bucket] of this.clientBuckets) {
      prune(bucket, cutoff);
      if (bucket.timestamps.length === 0) this.clientBuckets.delete(id);
    }
  }

  private getOrCreate(
    map: Map<string, Bucket>,
    key: string,
    cutoff: number,
  ): Bucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      map.set(key, bucket);
    } else {
      prune(bucket, cutoff);
    }
    return bucket;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prune(bucket: Bucket, cutoff: number): void {
  // Remove timestamps older than the rolling window cutoff
  let i = 0;
  while (i < bucket.timestamps.length && bucket.timestamps[i]! <= cutoff) i++;
  if (i > 0) bucket.timestamps.splice(0, i);
}
