/**
 * auto-refresh-clock-seam.test.ts
 *
 * The expiry comparisons in AutoRefreshCoordinator read a clock. With that
 * clock hard-wired to `Date.now`, exercising the leeway window and the
 * definitely-expired branch meant minting tokens whose real wall-clock
 * timestamps happened to straddle the boundary — a test that is slow, or
 * timing-dependent, or both.
 *
 * `AutoRefreshOptions.now` makes those branches addressable directly. It is a
 * test seam, not a behaviour knob: anything other than a monotonic wall clock
 * makes token expiry meaningless.
 */

import { expect, test } from 'bun:test';

import { AutoRefreshCoordinator } from '../packages/sdk/src/client-auth/auto-refresh.ts';

const EXPIRES_AT = 1_000_000;

function coordinatorAt(now: number, refreshLeewayMs: number): {
  coordinator: AutoRefreshCoordinator;
  refreshCalls: () => number;
} {
  let calls = 0;
  const coordinator = new AutoRefreshCoordinator({
    tokenStore: {
      getToken: async () => 'stale-token',
      setToken: async () => undefined,
      getTokenEntry: async () => ({ token: 'stale-token', expiresAt: EXPIRES_AT }),
    } as never,
    autoRefresh: true,
    refreshLeewayMs,
    now: () => now,
    refresh: async () => {
      calls += 1;
      return { token: 'fresh-token', expiresAt: now + 3_600_000 };
    },
  });
  return { coordinator, refreshCalls: () => calls };
}

test('a token comfortably inside its lifetime is not refreshed', async () => {
  const { coordinator, refreshCalls } = coordinatorAt(EXPIRES_AT - 600_000, 60_000);
  await coordinator.ensureFreshToken();
  expect(refreshCalls()).toBe(0);
});

test('a token inside the leeway window is refreshed ahead of expiry', async () => {
  // 30s remaining against a 60s leeway: not expired, but due.
  const { coordinator, refreshCalls } = coordinatorAt(EXPIRES_AT - 30_000, 60_000);
  await coordinator.ensureFreshToken();
  expect(refreshCalls()).toBe(1);
});

test('a token past its expiry is refreshed', async () => {
  const { coordinator, refreshCalls } = coordinatorAt(EXPIRES_AT + 1, 60_000);
  await coordinator.ensureFreshToken();
  expect(refreshCalls()).toBe(1);
});

test('the seam defaults to the real clock when no override is given', () => {
  // Absent `now`, construction must still work and use Date.now — the option is
  // additive, and every existing caller passes nothing.
  expect(() => new AutoRefreshCoordinator({
    tokenStore: { getToken: async () => null, setToken: async () => undefined } as never,
    autoRefresh: true,
    refreshLeewayMs: 60_000,
  })).not.toThrow();
});
