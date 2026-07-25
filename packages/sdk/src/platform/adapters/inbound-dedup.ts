/**
 * Inbound message de-duplication, shared across ingress paths.
 *
 * A surface can reach the adapter through more than one route. ntfy is the
 * proven case: the same message arrives on the long-lived JSON subscription
 * AND on the HTTP webhook route, and the subscription's own seen-id cache is
 * scoped to a single subscribe call, so it cannot see the webhook's copy (or
 * its own copy after a reconnect). Each delivery ran the full pipeline, which
 * is how one message produced two agents.
 *
 * This store is deliberately module-scoped rather than per-context: the
 * adapter context is rebuilt per inbound message, so anything held on the
 * context would be a fresh, empty cache every time and would dedupe nothing.
 *
 * Bounded and expiring — a dedup cache that grows forever is its own defect.
 */

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 2_048;

export class InboundMessageDedup {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claim a message id. Returns true on the FIRST delivery and false for every
   * repeat inside the TTL, so callers read as
   * `if (!dedup.claim(key)) return alreadyHandledResponse;`.
   */
  claim(key: string): boolean {
    if (!key) return true; // No id to key on — cannot dedupe; process it.
    const now = this.now();
    this.prune(now);
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < this.ttlMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxEntries) {
      const excess = this.seen.size - this.maxEntries;
      let dropped = 0;
      for (const id of this.seen.keys()) {
        if (dropped >= excess) break;
        this.seen.delete(id);
        dropped += 1;
      }
    }
    return true;
  }

  has(key: string): boolean {
    const seenAt = this.seen.get(key);
    return seenAt !== undefined && this.now() - seenAt < this.ttlMs;
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt >= this.ttlMs) this.seen.delete(key);
      else break; // Map preserves insertion order; the rest are newer.
    }
  }
}

/**
 * Build a dedup key from a surface, a scope (topic/channel/chat), and the
 * provider's own message id. A missing id yields '' so {@link
 * InboundMessageDedup.claim} lets the message through rather than collapsing
 * every id-less message onto one key.
 */
export function inboundDedupKey(
  surface: string,
  scope: string | undefined,
  messageId: string | undefined,
): string {
  if (!messageId || !messageId.trim()) return '';
  return `${surface}:${scope ?? ''}:${messageId.trim()}`;
}

/** The ntfy adapter's shared cache — see the module docstring for why it is here. */
export const ntfyInboundDedup = new InboundMessageDedup();
