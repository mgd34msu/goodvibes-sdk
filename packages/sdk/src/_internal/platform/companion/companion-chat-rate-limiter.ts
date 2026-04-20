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
import type { ConfigManager } from '../config/manager.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MESSAGES_PER_MINUTE_PER_CLIENT = 30;
export const DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION = 10;

/**
 * Maximum number of distinct clientId/sessionId buckets to track concurrently.
 * A slow attacker sending requests with distinct IDs would otherwise grow the
 * Map without bound between cleanup() cycles. LRU eviction caps the attack
 * surface at O(MAX_BUCKETS) entries per map (SEC-06).
 */
export const MAX_RATE_LIMITER_BUCKETS = 10_000;

/**
 * Read the per-session threshold override from the environment.
 * GOODVIBES_CHAT_LIMITER_THRESHOLD=<int> overrides the per-session limit.
 * Returns undefined when unset or not a positive integer.
 */
export function readThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['GOODVIBES_CHAT_LIMITER_THRESHOLD'];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

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
  /**
   * Max messages per 60-second window per sessionId. Default: 10.
   *
   * **Startup-time env var**: `GOODVIBES_CHAT_LIMITER_THRESHOLD` is read **once** at
   * constructor time and used as a fallback when this option is not provided. It
   * cannot be changed at runtime without a daemon restart.
   *
   * **Runtime config key**: `runtime.companionChatLimiter.perSessionLimit` is read
   * on every `check()` call (when a `configManager` is provided) and takes
   * precedence over the env-var-captured fallback.
   */
  readonly perSessionLimit?: number;
  /** Window size in ms. Default: 60000 (1 minute). */
  readonly windowMs?: number;
  /**
   * Optional ConfigManager for runtime lookup of
   * `runtime.companionChatLimiter.perSessionLimit`.
   * When provided, `check()` reads this key on each call and uses it as the
   * effective per-session limit (falling back to the constructor-time value
   * when the config key is absent or not a positive integer).
   */
  readonly configManager?: Pick<ConfigManager, 'get'> | null;
}

export class CompanionChatRateLimiter {
  private readonly perClientLimit: number;
  /**
   * Base per-session limit: resolved at constructor time from explicit option >
   * env var > compile-time default. May be overridden per-call by the config
   * manager when `configManager` is provided.
   *
   * **Note**: `GOODVIBES_CHAT_LIMITER_THRESHOLD` is read **once** at constructor
   * time and cached here. Changing the env var after daemon startup has no effect
   * without a daemon restart. Use the `runtime.companionChatLimiter.perSessionLimit`
   * config key for live changes.
   */
  private readonly perSessionLimitBase: number;
  private readonly windowMs: number;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;

  /** clientId → bucket */
  private readonly clientBuckets = new Map<string, Bucket>();
  /** sessionId → bucket */
  private readonly sessionBuckets = new Map<string, Bucket>();

  constructor(options: CompanionChatRateLimiterOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    // Precedence: explicit config option > env var > compile-time default
    const envThreshold = readThresholdFromEnv(env);
    this.perClientLimit = options.perClientLimit ?? DEFAULT_MESSAGES_PER_MINUTE_PER_CLIENT;
    this.perSessionLimitBase = options.perSessionLimit ?? envThreshold ?? DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION;
    this.windowMs = options.windowMs ?? 60_000;
    this.configManager = options.configManager ?? null;
  }

  /**
   * Resolve the effective per-session limit for the current call.
   *
   * Runtime config key `runtime.companionChatLimiter.perSessionLimit` takes
   * precedence over the constructor-time baseline when it resolves to a
   * positive integer.
   */
  private resolvePerSessionLimit(): number {
    if (this.configManager) {
      const raw = this.configManager.get('runtime.companionChatLimiter.perSessionLimit');
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
        return raw;
      }
    }
    return this.perSessionLimitBase;
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
    const perSessionLimit = this.resolvePerSessionLimit();
    const sessionBucket = this.getOrCreate(this.sessionBuckets, sessionId, cutoff);
    if (sessionBucket.timestamps.length >= perSessionLimit) {
      const oldestTs = sessionBucket.timestamps[0]!;
      const retryAfterMs = this.windowMs - (now - oldestTs) + 1;
      throw new GoodVibesSdkError(
        `Companion chat session rate limit exceeded: this session has sent ${perSessionLimit} messages in the last minute. ` +
          `Each session is limited to ${perSessionLimit} messages per minute to prevent runaway conversations. ` +
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
      // SEC-06: LRU eviction — evict the least-recently-used entry when the map
      // is at capacity. JS Map preserves insertion order; the first key is LRU.
      if (map.size >= MAX_RATE_LIMITER_BUCKETS) {
        const lruKey = map.keys().next().value as string;
        map.delete(lruKey);
      }
      bucket = { timestamps: [] };
      map.set(key, bucket);
    } else {
      // Promote to MRU position via delete + re-set (O(1)).
      map.delete(key);
      prune(bucket, cutoff);
      map.set(key, bucket);
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
