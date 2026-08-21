/**
 * owner-alert.ts, reaching the owner when the thing that broke is a channel.
 *
 * The ordinary notice path takes a binding and sends on it. That is not enough
 * for an alert whose SUBJECT is a channel failing, because the obvious binding
 * to use is the one on the surface that just failed. Two facts from the
 * incident this exists for decide the ordering:
 *
 * 1. Inbound and outbound fail independently. Telegram's sends worked all day
 *    while its receives were being dropped. So the failing surface's own
 *    conversation is still the FIRST choice, it is where the owner is already
 *    looking, and it usually still works.
 * 2. But it might not. So a refusal is not the end: the alert falls back to the
 *    most recently used conversation on any OTHER surface, which is what "ntfy
 *    exists as a fallback" means in practice without naming ntfy specifically,
 *    whatever the owner actually has connected and has used most recently.
 *
 * Never silent: if nothing accepted it, that is logged at error with every
 * refusal reason, because an alert nobody received is the same failure one
 * level up.
 */

import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/route-manager.js';
import type { ChannelSurface } from '../channels/types.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import { ChannelIngressAlarm } from '../channels/ingress-alarm.js';
import { logger } from '../utils/logger.js';

/**
 * THE per-surface ingress alarm for a daemon: one instance shared by every
 * inbound path there is, the Telegram poller, the shared webhook seam in
 * `ChannelPluginRegistry` (which covers the eleven webhook-delivered surfaces
 * at a stroke), the three streaming surfaces in
 * `ChannelProviderRuntimeManager`, and the two detached slash-command paths.
 *
 * One instance, because "have I already told the owner Telegram is failing" is a
 * question about the SURFACE, not about which of those mechanisms noticed.
 */
export function createChannelIngressAlarm(
  routeBindings: RouteBindingManager,
  delivery: Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
): ChannelIngressAlarm {
  return new ChannelIngressAlarm({
    notify: (surface, text) => { void deliverOwnerAlert(routeBindings, delivery, surface, text); },
  });
}

/** Newest-first by last use, which is the best available proxy for "works". */
function byMostRecentlySeen(bindings: readonly AutomationRouteBinding[]): AutomationRouteBinding[] {
  return [...bindings].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * The conversations to try, in order: the failing surface's own newest first,
 * then every other surface's, newest first.
 *
 * `preferred` is null when the alert is not ABOUT a channel, the daemon
 * failing to update itself, for instance. There is no surface to try first
 * then, so the order is simply newest-used first, which is the same
 * "best available proxy for works" the rest of this file runs on.
 */
export function orderOwnerAlertRoutes(
  bindings: readonly AutomationRouteBinding[],
  preferred: ChannelSurface | null,
): AutomationRouteBinding[] {
  const ordered = byMostRecentlySeen(bindings);
  if (preferred === null) return ordered;
  return [
    ...ordered.filter((binding) => binding.surfaceKind === preferred),
    ...ordered.filter((binding) => binding.surfaceKind !== preferred),
  ];
}

/**
 * Put one line in front of the owner, trying conversations until one accepts.
 *
 * Returns the binding it was delivered on, or null when nothing took it.
 */
export async function deliverOwnerAlert(
  routeBindings: RouteBindingManager,
  delivery: Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
  preferred: ChannelSurface | null,
  text: string,
): Promise<AutomationRouteBinding | null> {
  let candidates: AutomationRouteBinding[];
  try {
    candidates = orderOwnerAlertRoutes(routeBindings.listBindings(), preferred);
  } catch (error) {
    // Route binding can be switched off entirely, in which case listing throws
    // rather than returning nothing. That is a real answer, there is no route
    // to alert on, and it must not take down the caller reporting a failure.
    logger.error('An alert for the owner could not be routed: route bindings are unavailable', {
      preferred,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const refusals: string[] = [];
  for (const binding of candidates) {
    const result = await delivery.deliverSurfaceNotice(binding, text);
    if (result.delivered) return binding;
    refusals.push(`${binding.surfaceKind}:${result.reason ?? 'unknown'}`);
  }
  logger.error('An alert for the owner reached no channel at all', {
    preferred,
    text,
    triedRoutes: candidates.length,
    refusals,
  });
  return null;
}
