/**
 * sec-06-rate-limiter-lru.test.ts
 *
 * SEC-06: CompanionChatRateLimiter Map bounded at MAX_RATE_LIMITER_BUCKETS.
 * Verifies LRU eviction: when both clientBuckets and sessionBuckets reach
 * MAX_RATE_LIMITER_BUCKETS, the least-recently-used entry is evicted on the
 * next insert, keeping the map at capacity.
 */

import { describe, expect, test } from 'bun:test';
import {
  CompanionChatRateLimiter,
  MAX_RATE_LIMITER_BUCKETS,
} from '../packages/sdk/src/platform/companion/companion-chat-rate-limiter.ts';

// Use very high limits so we don't hit the rate limit during the fill loop.
const BIG_LIMIT = MAX_RATE_LIMITER_BUCKETS * 10;

describe('SEC-06: CompanionChatRateLimiter LRU cap', () => {
  test('sessionBuckets does not exceed MAX_RATE_LIMITER_BUCKETS', () => {
    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: BIG_LIMIT,
      perClientLimit: BIG_LIMIT,
    });

    // Each unique sessionId creates a new bucket entry
    for (let i = 0; i <= MAX_RATE_LIMITER_BUCKETS; i++) {
      limiter.check(`sess-${i}`, '');
    }

    const sessionBuckets = (limiter as unknown as { sessionBuckets: Map<string, unknown> }).sessionBuckets;
    expect(sessionBuckets.size).toBe(MAX_RATE_LIMITER_BUCKETS);
  });

  test('clientBuckets does not exceed MAX_RATE_LIMITER_BUCKETS', () => {
    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: BIG_LIMIT,
      perClientLimit: BIG_LIMIT,
    });

    // Each unique clientId+unique sessionId combination creates new entries in both maps
    for (let i = 0; i <= MAX_RATE_LIMITER_BUCKETS; i++) {
      limiter.check(`sess-${i}`, `client-${i}`);
    }

    const clientBuckets = (limiter as unknown as { clientBuckets: Map<string, unknown> }).clientBuckets;
    expect(clientBuckets.size).toBe(MAX_RATE_LIMITER_BUCKETS);
  });

  test('LRU entry (first inserted) is evicted when cap is exceeded', () => {
    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: BIG_LIMIT,
      perClientLimit: BIG_LIMIT,
    });
    const sessionBuckets = (limiter as unknown as { sessionBuckets: Map<string, unknown> }).sessionBuckets;

    // Insert a small set of named sessions first
    const named = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const id of named) {
      limiter.check(id, '');
    }

    // Fill the rest of the cap with filler entries
    const fillCount = MAX_RATE_LIMITER_BUCKETS - named.length;
    for (let i = 0; i < fillCount; i++) {
      limiter.check(`filler-${i}`, '');
    }

    // At this point sessionBuckets.size === MAX_RATE_LIMITER_BUCKETS
    // 'alpha' was the first inserted and is now LRU
    expect(sessionBuckets.size).toBe(MAX_RATE_LIMITER_BUCKETS);
    expect(sessionBuckets.has('alpha')).toBe(true);

    // Inserting one more should evict 'alpha'
    limiter.check('omega', '');
    expect(sessionBuckets.has('alpha')).toBe(false);
    expect(sessionBuckets.size).toBe(MAX_RATE_LIMITER_BUCKETS);
  });

  test('recently accessed session is promoted to MRU (not evicted first)', () => {
    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: BIG_LIMIT,
      perClientLimit: BIG_LIMIT,
    });
    const sessionBuckets = (limiter as unknown as { sessionBuckets: Map<string, unknown> }).sessionBuckets;

    // Insert two sessions: 'first' then 'second'
    limiter.check('first', '');
    limiter.check('second', '');

    // Fill to exactly MAX_RATE_LIMITER_BUCKETS - 2 more so next insert will evict
    for (let i = 0; i < MAX_RATE_LIMITER_BUCKETS - 2; i++) {
      limiter.check(`fill-${i}`, '');
    }

    // Re-access 'first' to promote it to MRU
    limiter.check('first', '');

    // Insert one more: 'second' is now LRU and should be evicted
    limiter.check('new-entry', '');

    expect(sessionBuckets.has('second')).toBe(false);
    expect(sessionBuckets.has('first')).toBe(true);
  });
});
