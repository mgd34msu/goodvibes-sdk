/**
 * consumer-conflict-backoff.ts — how long to wait before contesting a surface
 * again after the provider refused it.
 *
 * A consumer conflict is not a transient network fault. It means a DIFFERENT
 * process holds the credential — Telegram answers the second getUpdates on one
 * bot token with a 409 naming the other consumer — and no amount of retrying
 * decides which process should have it. Only a person can.
 *
 * That makes a flat retry interval a hot loop against somebody else's API. On a
 * node with no peer to hand the surface to, every retry resigns, re-probes,
 * wins its own election again, restarts the consumer and is refused again.
 * Measured live on a two-node group with a 4s master timeout before this
 * existed: 44 getUpdates calls in 40 seconds, every one refused. At the shipped
 * 90s timeout the same loop simply runs every 15s, forever.
 *
 * Kept out of election.ts because it is a policy with no dependency on the
 * state machine — the same reason `shouldYieldSurface` lives in ranking.ts —
 * and because it can then be tested directly instead of through a cluster.
 */

/** What the caller carries between refusals. */
export interface ConsumerConflictBackoffState {
  /** Consecutive refusals, counting the one being handled. */
  readonly streak: number;
  /** The delay returned for the previous refusal. */
  readonly lastDelayMs: number;
}

export const INITIAL_CONSUMER_CONFLICT_STATE: ConsumerConflictBackoffState = {
  streak: 0,
  lastDelayMs: 0,
};

export interface ConsumerConflictBackoffInput {
  /**
   * How long the consumer actually RAN before this refusal.
   *
   * This, not the wall clock since the previous refusal, is what decides
   * whether the streak resets. Time since the previous refusal includes the
   * backoff and the re-probe that follow one, so early on it always exceeds
   * the delay just waited and the streak would reset every round — which is
   * exactly the flat retry rate this exists to remove.
   */
  readonly servedForMs: number;
  /** Shortest interval, used for the first refusal in a streak. */
  readonly floorMs: number;
  /** Longest interval; the doubling stops here. */
  readonly ceilingMs: number;
  /**
   * Serving for longer than this counts as "it worked, then something
   * changed", so the next refusal starts from the floor again.
   */
  readonly servedLongEnoughMs: number;
}

/**
 * The next state and the delay to wait, doubling per consecutive refusal up to
 * the ceiling.
 */
export function nextConsumerConflictBackoff(
  state: ConsumerConflictBackoffState,
  input: ConsumerConflictBackoffInput,
): ConsumerConflictBackoffState {
  const servedLongEnough = input.servedForMs > Math.max(input.servedLongEnoughMs, state.lastDelayMs);
  const streak = (servedLongEnough ? 0 : state.streak) + 1;
  // 2 ** n overflows to Infinity long before any realistic streak, and Infinity
  // would sail past a Math.min against a finite ceiling in the wrong direction
  // if the ceiling were ever non-finite, so the ceiling is chosen explicitly.
  const doubled = input.floorMs * 2 ** (streak - 1);
  const lastDelayMs = Math.min(Number.isFinite(doubled) ? doubled : input.ceilingMs, input.ceilingMs);
  return { streak, lastDelayMs };
}
