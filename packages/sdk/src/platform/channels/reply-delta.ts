/**
 * Delivery watermark for channel replies.
 *
 * A progress notification should carry what just happened, not the whole
 * accumulated log replayed from the top. Tracking which events have already
 * been published is what turns a stream of ever-growing, mostly-identical
 * bodies into one short line per real event.
 *
 * The watermark is a set of event ids rather than an index because the event
 * buffer is trimmed from the front when it hits its cap, which would silently
 * shift any index-based mark.
 */
import type { ChannelRenderEvent } from './types.js';

/** Cap; keeps the watermark from growing without bound on a long run. */
export const MAX_DELIVERED_EVENT_IDS = 512;

export interface DeliveryWatermark {
  readonly deliveredEventIds: Set<string>;
}

/** Events not yet published, in buffer order. */
export function selectUndeliveredEvents(
  state: DeliveryWatermark,
  events: readonly ChannelRenderEvent[],
): ChannelRenderEvent[] {
  return events.filter((event) => !state.deliveredEventIds.has(event.id));
}

/** Record events as published, dropping the oldest marks past the cap. */
export function markEventsDelivered(
  state: DeliveryWatermark,
  events: readonly ChannelRenderEvent[],
): void {
  for (const event of events) state.deliveredEventIds.add(event.id);
  if (state.deliveredEventIds.size <= MAX_DELIVERED_EVENT_IDS) return;
  const excess = state.deliveredEventIds.size - MAX_DELIVERED_EVENT_IDS;
  let dropped = 0;
  for (const id of state.deliveredEventIds) {
    if (dropped >= excess) break;
    state.deliveredEventIds.delete(id);
    dropped += 1;
  }
}
