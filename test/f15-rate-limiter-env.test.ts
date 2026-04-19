/**
 * F15: Rate-limiter environment variable override tests.
 *
 * GOODVIBES_CHAT_LIMITER_THRESHOLD=<int> overrides the per-session rate limit.
 * Precedence: explicit config > env var > default (10).
 */
import { describe, expect, test } from 'bun:test';
import {
  CompanionChatRateLimiter,
  readThresholdFromEnv,
  DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION,
} from '../packages/sdk/src/_internal/platform/companion/companion-chat-rate-limiter.ts';

// ---------------------------------------------------------------------------
// readThresholdFromEnv
// ---------------------------------------------------------------------------

describe('readThresholdFromEnv', () => {
  test('returns undefined when env var is absent', () => {
    expect(readThresholdFromEnv({})).toBeUndefined();
  });

  test('returns undefined when env var is empty string', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: '' })).toBeUndefined();
  });

  test('returns undefined when env var is non-numeric', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: 'abc' })).toBeUndefined();
  });

  test('returns undefined when env var is zero', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: '0' })).toBeUndefined();
  });

  test('returns undefined when env var is negative', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: '-5' })).toBeUndefined();
  });

  test('returns parsed integer when valid positive integer', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: '7' })).toBe(7);
  });

  test('truncates decimal via parseInt', () => {
    expect(readThresholdFromEnv({ GOODVIBES_CHAT_LIMITER_THRESHOLD: '3.9' })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CompanionChatRateLimiter constructor — threshold precedence
// ---------------------------------------------------------------------------

describe('CompanionChatRateLimiter threshold precedence', () => {
  test('uses default when neither config nor env is set', () => {
    const limiter = new CompanionChatRateLimiter({}, {});
    // Send DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION messages — should all pass
    for (let i = 0; i < DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION; i++) {
      expect(() => limiter.check('session-a', '')).not.toThrow();
    }
    // Next one should throw (limit exhausted)
    expect(() => limiter.check('session-a', '')).toThrow();
  });

  test('env var overrides default threshold', () => {
    const env = { GOODVIBES_CHAT_LIMITER_THRESHOLD: '2' };
    const limiter = new CompanionChatRateLimiter({}, env);
    // First 2 should succeed
    expect(() => limiter.check('session-b', '')).not.toThrow();
    expect(() => limiter.check('session-b', '')).not.toThrow();
    // 3rd should be rejected (429 semantics)
    expect(() => limiter.check('session-b', '')).toThrow();
  });

  test('explicit config option overrides env var', () => {
    const env = { GOODVIBES_CHAT_LIMITER_THRESHOLD: '2' };
    // Config says 5 — env says 2; config must win
    const limiter = new CompanionChatRateLimiter({ perSessionLimit: 5 }, env);
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check('session-c', '')).not.toThrow();
    }
    // 6th should be rejected
    expect(() => limiter.check('session-c', '')).toThrow();
  });

  test('F15 spec: env=2, fire 3 requests, 3rd returns rate-limit error', () => {
    const env = { GOODVIBES_CHAT_LIMITER_THRESHOLD: '2' };
    const limiter = new CompanionChatRateLimiter({}, env);

    // Request 1 — OK
    expect(() => limiter.check('session-f15', 'client-1')).not.toThrow();
    // Request 2 — OK
    expect(() => limiter.check('session-f15', 'client-1')).not.toThrow();
    // Request 3 — must throw with rate-limit category
    let caught: unknown;
    try {
      limiter.check('session-f15', 'client-1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // GoodVibesSdkError should have category 'rate_limit'
    expect((caught as { category?: string }).category).toBe('rate_limit');
  });
});
