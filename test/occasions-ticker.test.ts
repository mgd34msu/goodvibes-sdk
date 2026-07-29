/**
 * occasions-ticker.test.ts
 *
 * The repeating pass that makes the feature proactive rather than something
 * that only happens when a verb asks. Driven with an injected scheduler, so
 * every property is asserted by advancing a counter rather than by waiting.
 *
 * The through-line: the loop cannot stop. Not on an error, not on a slow pass,
 * and not because a setting changed under it.
 */
import { describe, expect, test } from 'bun:test';
import { startOccasionSweepTicker, type TickerScheduler } from '../packages/sdk/src/platform/occasions/ticker.ts';

interface FakeClock extends TickerScheduler {
  /** Run the pending timer, if there is one. Returns whether one fired. */
  fire(): boolean;
  /** The delay the pending timer was armed with. */
  readonly pendingMs: number | null;
  readonly armCount: number;
  readonly clearCount: number;
}

function fakeClock(): FakeClock {
  let pending: { handler: () => void; ms: number } | null = null;
  let armCount = 0;
  let clearCount = 0;
  return {
    setTimeout(handler, ms) {
      pending = { handler, ms };
      armCount += 1;
      return pending;
    },
    clearTimeout(handle) {
      if (handle === pending) pending = null;
      clearCount += 1;
    },
    fire() {
      const due = pending;
      if (due === null) return false;
      pending = null;
      due.handler();
      return true;
    },
    get pendingMs() { return pending?.ms ?? null; },
    get armCount() { return armCount; },
    get clearCount() { return clearCount; },
  };
}

describe('the sweep ticker', () => {
  test('arms immediately and runs one pass per tick', async () => {
    const clock = fakeClock();
    let passes = 0;
    const ticker = startOccasionSweepTicker({
      sweep: async () => { passes += 1; },
      intervalMs: () => 60_000,
      scheduler: clock,
    });
    expect(clock.pendingMs).toBe(60_000);
    expect(passes).toBe(0);

    clock.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(passes).toBe(1);
    // And it re-armed, so the loop continues.
    expect(clock.pendingMs).toBe(60_000);
    ticker.stop();
  });

  test('the interval is re-read every tick, so the setting is live', async () => {
    const clock = fakeClock();
    let minutes = 60;
    const ticker = startOccasionSweepTicker({
      sweep: async () => undefined,
      intervalMs: () => minutes * 60_000,
      scheduler: clock,
    });
    expect(clock.pendingMs).toBe(3_600_000);
    minutes = 5;
    clock.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pendingMs).toBe(300_000);
    ticker.stop();
  });

  test('a pass that throws does not end the loop', async () => {
    const clock = fakeClock();
    const seen: unknown[] = [];
    let passes = 0;
    const ticker = startOccasionSweepTicker({
      sweep: async () => {
        passes += 1;
        if (passes === 1) throw new Error('transient');
      },
      intervalMs: () => 60_000,
      scheduler: clock,
      onError: (error) => seen.push(error),
    });
    clock.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(clock.pendingMs).toBe(60_000);

    clock.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(passes).toBe(2);
    expect(seen).toHaveLength(1);
    ticker.stop();
  });

  test('passes are serial — nothing is armed while one is in flight', async () => {
    const clock = fakeClock();
    let started = 0;
    let release: (() => void) | null = null;
    const ticker = startOccasionSweepTicker({
      sweep: () => {
        started += 1;
        return new Promise<void>((resolve) => { release = resolve; });
      },
      intervalMs: () => 60_000,
      scheduler: clock,
    });

    clock.fire();
    await Promise.resolve();
    expect(started).toBe(1);
    expect(ticker.running).toBe(true);
    // Nothing is armed, so no second pass can start on top of this one and
    // deliver the same batch twice. That is a property of when the re-arm
    // happens, not a guard that could be forgotten.
    expect(clock.pendingMs).toBeNull();

    (release as (() => void) | null)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ticker.running).toBe(false);
    expect(started).toBe(1);
    // And the loop continues once the pass is done.
    expect(clock.pendingMs).toBe(60_000);
    ticker.stop();
  });

  test('stop cancels the pending timer and does not re-arm', async () => {
    const clock = fakeClock();
    let passes = 0;
    const ticker = startOccasionSweepTicker({
      sweep: async () => { passes += 1; },
      intervalMs: () => 60_000,
      scheduler: clock,
    });
    ticker.stop();
    expect(clock.clearCount).toBe(1);
    expect(clock.fire()).toBe(false);
    expect(passes).toBe(0);
    // Idempotent.
    ticker.stop();
  });

  test('stopping mid-pass leaves nothing armed behind it', async () => {
    const clock = fakeClock();
    let release: (() => void) | null = null;
    const ticker = startOccasionSweepTicker({
      sweep: () => new Promise<void>((resolve) => { release = resolve; }),
      intervalMs: () => 60_000,
      scheduler: clock,
    });
    clock.fire();
    await Promise.resolve();
    ticker.stop();
    (release as (() => void) | null)?.();
    await Promise.resolve();
    await Promise.resolve();
    // The `finally` re-arm is refused once stopped, so nothing keeps ticking
    // after a dispose that raced a pass.
    expect(clock.pendingMs).toBeNull();
  });

  test('an interval of zero is clamped rather than becoming a busy loop', () => {
    const clock = fakeClock();
    const ticker = startOccasionSweepTicker({
      sweep: async () => undefined,
      intervalMs: () => 0,
      scheduler: clock,
    });
    expect(clock.pendingMs).toBe(1);
    ticker.stop();
  });
});
