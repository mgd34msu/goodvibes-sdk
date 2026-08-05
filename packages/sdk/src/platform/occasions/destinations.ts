/**
 * destinations.ts — where a nudge goes, and what it looks like when it lands.
 *
 * Split out of service.ts so the two questions live together: a destination's
 * surface kind decides both whether it may be pushed at and how the text has to
 * be framed when it gets there, and those answers drifting apart is what put a
 * bare sentence about the owner's birthday into the middle of a wake-word
 * debugging session.
 */
import { AGENT_NOTICE_HEADING, composeAgentNotice } from './nudge.js';
import type { OccasionNudge } from './types.js';

/** Surfaces a proactive personal nudge is never delivered to. */
export const NUDGE_FORBIDDEN_SURFACES: readonly string[] = ['tui'];

/** The delivery surface that means the agent's own conversation. */
export const NUDGE_AGENT_SURFACE = 'agent';

/** The surface kind of one destination, lower-cased. */
export function nudgeDestinationSurface(destination: string): string {
  return (destination.split(':', 1)[0] ?? '').trim().toLowerCase();
}

/**
 * The channels a nudge may go to. Empty means pull-only.
 *
 * The setting is a comma-separated list — the same shape `payments.notifyChannels`
 * and the trigger backoff ladder use — because the owner's ruling was Telegram
 * AND the agent, and a single-valued setting would have made that a choice
 * between them. Each entry is `surfaceKind` or `surfaceKind:address`, matching
 * the channel delivery router's own form, so `telegram:12345,agent` is a valid
 * pair. Duplicates collapse: a list that names one destination twice must not
 * push the same nudge to it twice.
 *
 * The TUI is refused HERE rather than left unconfigured, because "nobody set it
 * to the TUI" is not the same guarantee as "it cannot be the TUI", and the
 * owner's ruling generalises beyond this feature: the TUI is a work interface,
 * and life-admin belongs on Telegram and the agent. A list that names the TUI
 * alongside real destinations loses the TUI entry and keeps the rest — the
 * exclusion is structural, not a reason to drop everything he asked for.
 */
export function resolveNudgeDestinations(channel: string): readonly string[] {
  const destinations: string[] = [];
  for (const entry of channel.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (NUDGE_FORBIDDEN_SURFACES.includes(nudgeDestinationSurface(trimmed))) continue;
    if (destinations.includes(trimmed)) continue;
    destinations.push(trimmed);
  }
  return destinations;
}


/** The title and body a nudge takes on ONE destination. */
export interface NudgeDeliveryText {
  readonly title: string;
  readonly body: string;
}

/**
 * How a nudge reads when it arrives on a given destination.
 *
 * Every destination but one is a message channel, where an arriving message is
 * self-evidently a new message and `nudge.message` needs no frame. The agent's
 * own conversation is not a message channel: text placed into it is
 * indistinguishable from the conversation unless it says what it is. Delivered
 * bare, "Mike's birthday is very close now." arrived mid-way through a session
 * about wake-word debugging and was simply spoken aloud, twice, as though it
 * were a thought the assistant had just had.
 *
 * So the agent gets the framed, self-contained notice and every other surface
 * gets the plain line. One function, so a new delivery path cannot get this
 * wrong by forgetting the special case — there is nowhere else to ask.
 */
export function nudgeDeliveryText(destination: string, nudge: OccasionNudge): NudgeDeliveryText {
  if (nudgeDestinationSurface(destination) === NUDGE_AGENT_SURFACE) {
    return { title: AGENT_NOTICE_HEADING, body: composeAgentNotice(nudge) };
  }
  return { title: 'A date is coming up', body: nudge.message };
}
