/**
 * Reconnect backoff: exponential, ceilinged, and FULL-jittered.
 *
 * Why the jitter is not a refinement
 * ──────────────────────────────────
 * The failure this guards against is not one client retrying too fast. It is
 * every mailbox of every restarted daemon retrying at the same instant. A
 * provider outage disconnects them all within the same second; an unjittered
 * schedule then has all of them reconnect at t+1s, all fail, all retry at t+3s,
 * and so on — a synchronised storm that arrives precisely when the provider is
 * least able to absorb it, and that keeps arriving on a schedule the outage
 * itself set. The same thing happens after our own auto-update restart, which
 * restarts every mailbox at once by design.
 *
 * So the delay is `random() * min(ceiling, initial * factor^attempt)` — FULL
 * jitter, the whole window, not `base/2 + jitter`. Full jitter spreads a
 * cohort across the entire window from the first attempt onwards; the
 * half-window variants keep a visible pulse at the base delay, which is the
 * thing being removed. The cost is that an individual retry can come back very
 * quickly, and for a reconnect that is a feature: the mailbox that gets lucky
 * reconnects immediately.
 *
 * Nothing here sleeps. `next()` returns a duration and the caller waits on the
 * injected clock, so a test drives a fifty-attempt escalation without a
 * fifty-attempt wall-clock cost.
 */

import type { RandomSource } from './ports.js';

/** The shape of the escalation. All three are bounds, not suggestions. */
export interface BackoffPolicy {
  /** The first window's width. Attempt 0 draws from `[0, initialMs)`. */
  readonly initialMs: number;
  /** The widest the window ever gets, however many attempts have failed. */
  readonly ceilingMs: number;
  /** What the window is multiplied by per failed attempt. */
  readonly factor: number;
}

/**
 * Exponential from one second, doubling to a five-minute ceiling.
 *
 * Five minutes bounds the worst-case silence after a provider outage while not
 * asking a dead server every second on the way there.
 */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  ceilingMs: 300_000,
  factor: 2,
};

/**
 * The width of the window for `attempt`, before jitter.
 *
 * Computed by repeated multiplication with an early exit rather than by
 * `Math.pow`, because `initial * 2 ** 900` is `Infinity` and
 * `Math.min(Infinity, ceiling)` only accidentally gives the right answer —
 * a policy with a factor below 1, or a caller that passes a huge attempt
 * count, should reach the ceiling and stay there by construction.
 */
export function backoffWindowMs(policy: BackoffPolicy, attempt: number): number {
  const ceiling = Math.max(0, policy.ceilingMs);
  const initial = Math.max(0, policy.initialMs);
  if (attempt <= 0) return Math.min(initial, ceiling);
  let window = initial;
  for (let step = 0; step < attempt; step += 1) {
    window *= policy.factor;
    if (window >= ceiling) return ceiling;
  }
  return Math.min(window, ceiling);
}

/**
 * The delay to actually wait before attempt number `attempt` (0-based).
 *
 * Full jitter: uniform over the whole window. The result is always in
 * `[0, window]` and therefore always at or below the ceiling, which is the
 * property a caller can rely on without knowing the attempt count.
 */
export function fullJitterDelayMs(
  policy: BackoffPolicy,
  attempt: number,
  random: RandomSource,
): number {
  const window = backoffWindowMs(policy, attempt);
  if (window <= 0) return 0;
  const draw = random();
  // A source that hands back something outside [0, 1) must not be able to
  // produce a delay outside the window — including a negative one, which
  // would turn a backoff into a busy loop.
  const bounded = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 1;
  return Math.floor(window * bounded);
}

/**
 * One connection's escalation, with its attempt count.
 *
 * Stateful on purpose: "how many times has THIS mailbox failed in a row" is
 * exactly what the caller must not have to track, and resetting it on a
 * successful connection is the one thing that is easy to forget and invisible
 * when forgotten — a watcher that never resets converges on the ceiling and
 * stays there for the life of the process, so its first reconnect after a week
 * of health takes five minutes.
 */
export class BackoffSchedule {
  private readonly policy: BackoffPolicy;
  private readonly random: RandomSource;
  private failures = 0;

  constructor(policy: BackoffPolicy, random: RandomSource) {
    this.policy = policy;
    this.random = random;
  }

  /** Consecutive failures since the last `reset()`. */
  get attempts(): number {
    return this.failures;
  }

  /** The width of the window the NEXT `next()` will draw from. */
  get windowMs(): number {
    return backoffWindowMs(this.policy, this.failures);
  }

  /**
   * Count one more failure and return how long to wait before retrying.
   *
   * `ceilingOverrideMs` widens (or narrows) the ceiling for THIS draw without
   * disturbing the attempt count. It exists for the simultaneous-connection
   * limit, which wants a longer ceiling than an ordinary reconnect but is
   * still the same run of consecutive failures — a second schedule with its
   * own counter would let a mailbox alternating between the two failures
   * escalate neither.
   */
  next(ceilingOverrideMs?: number): number {
    const policy = ceilingOverrideMs === undefined
      ? this.policy
      : { ...this.policy, ceilingMs: ceilingOverrideMs };
    const delay = fullJitterDelayMs(policy, this.failures, this.random);
    this.failures += 1;
    return delay;
  }

  /** A connection succeeded. The next failure starts from the first window. */
  reset(): void {
    this.failures = 0;
  }
}
