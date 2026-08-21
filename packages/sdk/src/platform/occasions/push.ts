/**
 * push.ts, getting one nudge out of the daemon, and remembering that it landed.
 *
 * Split out of service.ts, which owns the SEQUENCE of a sweep rather than the
 * mechanics of a send. Both functions here are about the same honesty problem:
 * what actually reached the owner, as opposed to what was attempted.
 */
import { summarizeError } from '../utils/error-display.js';
import type { IsoDate } from './dates.js';
import type { OccasionNudge, OpenItem } from './types.js';

/** How a nudge leaves the daemon. Bound to the channel delivery router. */
export interface OccasionNudgeDeliverer {
  deliver(input: {
    readonly channel: string;
    readonly nudge: OccasionNudge;
  }): Promise<string | undefined>;
}

/**
 * One destination a nudge was pushed to, and what came of it.
 *
 * Per destination rather than one verdict for the batch, because with two
 * channels configured "delivered: false" would say nothing about WHICH one went
 * quiet, and a channel the owner believes is reaching them and is not is the failure
 * this whole feature exists to avoid.
 */
export interface NudgeDelivery {
  /** The destination as configured: `surfaceKind` or `surfaceKind:address`. */
  readonly channel: string;
  readonly delivered: boolean;
  readonly deliveryId: string | null;
  /** Why this one did not land, when it did not. */
  readonly failure: string | null;
}

/**
 * Push one nudge to every configured destination, independently.
 *
 * A destination that throws is RECORDED and the next one is still tried. The
 * alternative, letting the first failure escape, means an expired Telegram
 * token stops the agent hearing about the owner's wife's birthday, and the two have
 * nothing to do with each other. Nothing is swallowed: each failure comes back
 * in the outcome, the router has already logged it against its surface and
 * strategy, and the sweep's caller logs the count.
 */
export async function pushNudge(
  deliverer: OccasionNudgeDeliverer | undefined,
  nudge: OccasionNudge,
  destinations: readonly string[],
): Promise<readonly NudgeDelivery[]> {
  if (deliverer === undefined) return [];
  const results: NudgeDelivery[] = [];
  for (const channel of destinations) {
    try {
      const deliveryId = (await deliverer.deliver({ channel, nudge })) ?? null;
      results.push({ channel, delivered: true, deliveryId, failure: null });
    } catch (error) {
      results.push({ channel, delivered: false, deliveryId: null, failure: summarizeError(error) });
    }
  }
  return results;
}

/**
 * Remember that the agent has these items in hand, for TODAY.
 *
 * Written AFTER the push rather than folded into the raise, so an item is never
 * marked as spoken by a delivery that had not happened yet.
 *
 * The stamp carries the day and the pull compares it against today, so it
 * suppresses a duplicate within one conversation and nothing beyond that. It
 * used to be read as permanent, which under a cadence that now pushes twice
 * would have hidden an occasion from "anything coming up?" for the entire
 * stretch between its two boundaries.
 */
export async function stampSpokenToAgent(
  put: (item: OpenItem) => Promise<unknown>,
  raised: readonly OpenItem[],
  today: IsoDate,
): Promise<void> {
  for (const item of raised) {
    if (item.kind !== 'nudge') continue;
    await put({ ...item, agentPushedOn: today });
  }
}
