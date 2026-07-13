/**
 * ci-watch/poller.ts — the daemon polls registered CI watches.
 *
 * checkWatch (service.ts) does the whole job — status source, persisted
 * store, notifier, fix-session offer/starter — but used to be invoked ONLY by
 * the manual `ci.watches.run` verb, so a "standing watch" stood still unless
 * someone poked it. This module registers the recurring check on the daemon's
 * EXISTING scheduling machinery — the watcher registry's polling watcher
 * (the same host the daemon heartbeat runs on) — so the fleet/watcher surface
 * shows it, its heartbeat/failure states are the registry's own, and stop
 * semantics come for free.
 *
 * Rate-limit posture: one sequential pass over all watches per tick (never
 * parallel gh calls), a floor on the cadence, and an overlap guard so a slow
 * pass can never stack a second one on top.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CiWatchService } from './service.js';

/** Default poll cadence. */
export const DEFAULT_CI_POLL_INTERVAL_MS = 60_000;
/** The cadence floor — polls faster than this hammer the status source's rate limits. */
export const MIN_CI_POLL_INTERVAL_MS = 15_000;
/** The polling watcher's stable id on the watcher registry. */
export const CI_WATCH_POLLER_ID = 'ci-watch-poller';

/** The slice of the watcher registry the poller registers on. */
export interface CiPollingHost {
  registerPollingWatcher(input: {
    id: string;
    label: string;
    source: {
      id: string;
      kind: 'watcher';
      label: string;
      enabled: boolean;
      createdAt: number;
      updatedAt: number;
      metadata: Record<string, never>;
    };
    intervalMs: number;
    run: () => Promise<string | void> | string | void;
  }): unknown;
  startWatcher(id: string): unknown;
}

/** The slice of the CI-watch service one poll pass needs. */
export type CiWatchPollTarget = Pick<CiWatchService, 'listWatches' | 'checkWatch'>;

/**
 * One poll pass: check every registered watch, sequentially, never throwing —
 * a single repo's failure must not starve the rest. Returns a one-line
 * checkpoint summary for the watcher registry's heartbeat trail. Exported so
 * tests drive passes directly without timers.
 */
export async function runCiWatchPollPass(service: CiWatchPollTarget): Promise<string> {
  const watches = await service.listWatches();
  if (watches.length === 0) return 'no watches registered';
  let checked = 0;
  let retired = 0;
  let failedChecks = 0;
  for (const watch of watches) {
    try {
      const result = await service.checkWatch(watch.id);
      checked += 1;
      if (result.retired) retired += 1;
    } catch (error) {
      failedChecks += 1;
      logger.warn('[ci-watch] poll check failed', { watchId: watch.id, repo: watch.repo, error: summarizeError(error) });
    }
  }
  return `checked ${checked}/${watches.length} watch(es)${retired > 0 ? `, ${retired} retired` : ''}${failedChecks > 0 ? `, ${failedChecks} check(s) failed` : ''}`;
}

/**
 * Register (and start) the recurring CI-watch poll on the watcher registry.
 * The cadence is clamped to {@link MIN_CI_POLL_INTERVAL_MS}; an in-flight
 * pass suppresses the next tick (overlap guard) so a slow status source can
 * never stack passes.
 */
export function registerCiWatchPolling(
  host: CiPollingHost,
  service: CiWatchPollTarget,
  options: { readonly intervalMs?: number | undefined } = {},
): void {
  const intervalMs = Math.max(MIN_CI_POLL_INTERVAL_MS, options.intervalMs ?? DEFAULT_CI_POLL_INTERVAL_MS);
  let inFlight = false;
  const now = Date.now();
  host.registerPollingWatcher({
    id: CI_WATCH_POLLER_ID,
    label: 'CI watch poller',
    source: {
      id: `source:${CI_WATCH_POLLER_ID}`,
      kind: 'watcher',
      label: 'CI watch poller',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    intervalMs,
    run: async (): Promise<string> => {
      if (inFlight) return 'previous pass still running — skipped (overlap guard)';
      inFlight = true;
      try {
        return await runCiWatchPollPass(service);
      } finally {
        inFlight = false;
      }
    },
  });
  host.startWatcher(CI_WATCH_POLLER_ID);
}
