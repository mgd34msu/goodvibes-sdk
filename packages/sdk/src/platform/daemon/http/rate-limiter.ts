// ---------------------------------------------------------------------------
// Rate limiter (sliding window per IP, in-memory)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
/** Entries older than this are eligible for TTL eviction. Default: 10 minutes. */
const RATE_TTL_MS = 10 * 60_000;
/** Maximum number of IP entries kept in the limiter at any time (LRU eviction). */
const RATE_MAX_ENTRIES = 10_000;
/** How often the background sweep runs to evict expired entries (ms). */
const RATE_SWEEP_INTERVAL_MS = 60_000;

export class RateLimiter {
  /** hits[ip] = sorted ascending array of request timestamps within the window */
  private counts = new Map<string, number[]>();
  /**
   * O(1) LRU tracking via Map insertion-order semantics.
   * Key = ip, value = last-seen timestamp.
   * To promote an entry to MRU: delete it and re-set it (both O(1)).
   * The Map iterator yields entries in insertion order, so the first entry is
   * the least-recently-used — perfect for LRU eviction without any indexOf scan.
   *
   */
  private lruMap = new Map<string, number>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private limit: number) {
    // Periodic sweep to evict entries whose TTL has expired.
    this.sweepInterval = setInterval(() => this._sweep(), RATE_SWEEP_INTERVAL_MS);
    // Don't block clean process exit.
    (this.sweepInterval as unknown as { unref?: () => void }).unref?.();
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    const hits = (this.counts.get(ip) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    this.counts.set(ip, hits);

    // Promote to MRU: delete then re-set (both O(1) Map operations).
    this.lruMap.delete(ip);
    this.lruMap.set(ip, now);

    // Evict least-recently-used entry when cap is exceeded.
    if (this.lruMap.size > RATE_MAX_ENTRIES) {
      const evict = this.lruMap.keys().next().value;
      if (evict !== undefined) {
        this.lruMap.delete(evict);
        this.counts.delete(evict);
      }
    }

    return hits.length <= this.limit;
  }

  /** Stop the background sweep interval. Call this when the listener stops. */
  stop(): void {
    if (this.sweepInterval !== null) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /** Evict entries whose last-seen timestamp is older than RATE_TTL_MS. */
  private _sweep(): void {
    const cutoff = Date.now() - RATE_TTL_MS;
    for (const [ip, lastSeen] of this.lruMap) {
      // Map iteration is insertion-order; first entries are oldest.
      // Break early once we hit a non-expired entry (all subsequent are newer).
      if (lastSeen >= cutoff) break;
      this.lruMap.delete(ip);
      this.counts.delete(ip);
    }
  }
}
