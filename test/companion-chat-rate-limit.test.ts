/**
 * companion-chat-rate-limit.test.ts
 *
 * Verifies the rate-limiting behaviour of CompanionChatManager.
 *
 * RL1: (N+1)-th message in 1 minute throws GoodVibesSdkError{kind:'rate-limit'} (per-session).
 * RL2: Per-client limit is enforced across sessions.
 * RL3: Error includes retryAfterMs inside the configured window.
 * RL4: Rate limiter can be disabled via `rateLimiter: false`.
 * RL5: Different sessions share client-level limit.
 */

import { describe, expect, test } from 'bun:test';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import {
  CompanionChatRateLimiter,
  DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION,
} from '../packages/sdk/src/platform/companion/companion-chat-rate-limiter.js';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield { type: 'text_delta', delta: 'ok' } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

interface ManagerOptions {
  perSessionLimit?: number;
  perClientLimit?: number;
  windowMs?: number;
}

function makeManager(opts: ManagerOptions = {}): CompanionChatManager {
  return new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: { publishEvent() {} },
    gcIntervalMs: 999_999,
    persist: false,
    rateLimiter: {
      perSessionLimit: opts.perSessionLimit ?? 3,
      perClientLimit: opts.perClientLimit ?? 5,
      windowMs: opts.windowMs ?? 60_000,
    },
  });
}

// ---------------------------------------------------------------------------
// RL1: Per-session limit — (N+1)-th message throws
// ---------------------------------------------------------------------------

describe('RL1: per-session rate limit — (N+1)-th message throws', () => {
  test('sends exactly perSessionLimit messages then throws on the next', async () => {
    const PER_SESSION = 3;
    const manager = makeManager({ perSessionLimit: PER_SESSION, perClientLimit: 100 });
    const session = manager.createSession();

    // Send exactly N messages (should succeed)
    for (let i = 0; i < PER_SESSION; i++) {
      await manager.postMessage(session.id, `message ${i}`);
    }

    // The (N+1)-th should throw
    let threw = false;
    try {
      await manager.postMessage(session.id, 'over the limit');
    } catch (err: unknown) {
      threw = true;
      expect(err).toBeInstanceOf(GoodVibesSdkError);
      const sdkErr = err as GoodVibesSdkError;
      expect(sdkErr.kind).toBe('rate-limit');
      expect(sdkErr.category).toBe('rate_limit');
      expect(sdkErr.recoverable).toBe(true);
    }
    expect(threw).toBe(true);

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// RL6: Runtime config manager overrides per-session limit
// ---------------------------------------------------------------------------

describe('RL6: runtime configManager overrides per-session limit', () => {
  test('uses configManager value when it returns a positive integer', () => {
    let configValue: number | undefined = 5;
    const configManager = { get: (_key: string) => configValue };

    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: 2, // constructor-time baseline
      configManager,
    });

    // configManager returns 5 — we should be able to send exactly 5 before throwing
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check('sess-1', '')).not.toThrow();
    }
    // 6th should throw (configManager limit = 5)
    expect(() => limiter.check('sess-1', '')).toThrow();
  });

  test('falls back to constructor baseline when configManager returns non-positive', () => {
    const configManager = { get: (_key: string) => 0 }; // 0 is not a positive integer

    const limiter = new CompanionChatRateLimiter({
      perSessionLimit: 2,
      configManager,
    });

    // Baseline is 2 — exactly 2 succeed
    expect(() => limiter.check('sess-2', '')).not.toThrow();
    expect(() => limiter.check('sess-2', '')).not.toThrow();
    // 3rd should throw
    expect(() => limiter.check('sess-2', '')).toThrow();
  });

  test('falls back to DEFAULT when configManager returns undefined', () => {
    const configManager = { get: (_key: string) => undefined };

    const limiter = new CompanionChatRateLimiter({ configManager });
    // Default per-session limit = DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION (10)
    for (let i = 0; i < DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION; i++) {
      expect(() => limiter.check(`sess-3`, '')).not.toThrow();
    }
    expect(() => limiter.check('sess-3', '')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RL2: Per-client limit enforced
// ---------------------------------------------------------------------------

describe('RL2: per-client rate limit — enforced across messages', () => {
  test('throws GoodVibesSdkError after perClientLimit messages from same client', async () => {
    const PER_CLIENT = 4;
    // Set per-session high so client limit triggers first
    const manager = makeManager({ perSessionLimit: 100, perClientLimit: PER_CLIENT });
    const session = manager.createSession();
    const clientId = 'test-client-abc';

    for (let i = 0; i < PER_CLIENT; i++) {
      await manager.postMessage(session.id, `msg ${i}`, clientId);
    }

    let threw = false;
    try {
      await manager.postMessage(session.id, 'client over limit', clientId);
    } catch (err: unknown) {
      threw = true;
      expect(err).toBeInstanceOf(GoodVibesSdkError);
      const sdkErr = err as GoodVibesSdkError;
      expect(sdkErr.kind).toBe('rate-limit');
      expect(sdkErr.code).toBe('COMPANION_CHAT_CLIENT_RATE_LIMIT');
    }
    expect(threw).toBe(true);

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// RL3: Error includes retryAfterMs inside the rate-limit window
// ---------------------------------------------------------------------------

describe('RL3: rate-limit error includes retryAfterMs inside the rate-limit window', () => {
  test('retryAfterMs is bounded by the configured window on session limit breach', async () => {
    const manager = makeManager({ perSessionLimit: 1, perClientLimit: 100 });
    const session = manager.createSession();

    await manager.postMessage(session.id, 'first');

    const err = await manager.postMessage(session.id, 'second — over limit').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoodVibesSdkError);
    const sdkErr = err as GoodVibesSdkError;
    expect(sdkErr.retryAfterMs).toBeGreaterThanOrEqual(59_000);
    expect(sdkErr.retryAfterMs).toBeLessThanOrEqual(60_001);

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// RL4: Rate limiter can be disabled
// ---------------------------------------------------------------------------

describe('RL4: rate limiter can be disabled entirely', () => {
  test('many messages succeed when rateLimiter: false', async () => {
    const manager = new CompanionChatManager({
      provider: makeMockProvider(),
      eventPublisher: { publishEvent() {} },
      gcIntervalMs: 999_999,
      persist: false,
      rateLimiter: false,
    });

    const session = manager.createSession();

    // Should not throw even with 20 messages
    for (let i = 0; i < 20; i++) {
      await manager.postMessage(session.id, `message ${i}`);
    }

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// RL5: Per-client limit spans multiple sessions
// ---------------------------------------------------------------------------

describe('RL5: client limit spans multiple sessions', () => {
  test('client limit is shared across different sessions', async () => {
    const PER_CLIENT = 3;
    const manager = makeManager({ perSessionLimit: 100, perClientLimit: PER_CLIENT });
    const clientId = 'shared-client';

    const session1 = manager.createSession();
    const session2 = manager.createSession();

    // Exhaust limit across two sessions
    await manager.postMessage(session1.id, 'a', clientId);
    await manager.postMessage(session2.id, 'b', clientId);
    await manager.postMessage(session1.id, 'c', clientId);

    // (N+1) on either session should throw
    let threw = false;
    try {
      await manager.postMessage(session2.id, 'd', clientId);
    } catch (err: unknown) {
      threw = true;
      expect(err).toBeInstanceOf(GoodVibesSdkError);
      const sdkErr = err as GoodVibesSdkError;
      expect(sdkErr.kind).toBe('rate-limit');
    }
    expect(threw).toBe(true);

    manager.dispose();
  });
});
