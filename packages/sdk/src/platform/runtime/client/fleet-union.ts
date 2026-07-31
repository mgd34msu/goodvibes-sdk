/**
 * fleet-union.ts — a fleet view shows everything running, not just what this
 * surface started.
 *
 * ── What a fleet panel used to show, and why that stopped being enough ─────
 *
 * A fleet view reads one `ProcessRegistry`: the agents, chains, workflows,
 * watchers and background processes THIS process spawned. While the surface
 * hosted a daemon, that registry was also the daemon's, so "everything running"
 * and "everything I started" were the same list.
 *
 * They are not any more. The daemon runs work of its own — scheduled jobs,
 * channel-driven runs, sessions other surfaces started, the external coding
 * agents it observes on this machine — and none of it appears in a registry
 * this process owns. A view that quietly showed half the fleet would be worse
 * than one that showed none: the half it showed would look complete.
 *
 * ── What is here, and what deliberately is not ────────────────────────────
 *
 * Here: the daemon-rows POLL and the MERGE rule. Both are policy — how often
 * the remote half is re-read, what happens to the last known rows when a poll
 * fails, which copy of a row wins when both halves carry the same node id, and
 * what a surface says when asked to act on a row it does not own.
 *
 * Not here: how a product renders rows, sorts them, or builds its own snapshot
 * type. Those are surface idioms, and a product binds them by calling
 * {@link mergeFleetNodes} and passing the result to its own snapshot builder —
 * so the rollups, the cost/token totals and the ordering are computed once,
 * over the whole fleet, rather than summed from two halves.
 *
 * ── Who wins ──────────────────────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for processes this surface spawned. They are
 * live — the registry pushes on every state change, with sub-second latency —
 * and they carry the capabilities that make a row actionable here (interrupt,
 * resume, kill, steer all reach a real child process). The daemon's copy of the
 * same row, arriving over a poll, is necessarily staler; where both describe
 * the same node id, the local one is kept.
 *
 * Daemon rows fill in everything else. They are interval-refreshed rather than
 * streamed, on the same reasoning the cross-surface session union already uses:
 * a fleet view is read at human pace, a poll survives a suspended laptop and a
 * dropped tunnel with no reconnect state machine, and the rows that genuinely
 * need per-keystroke latency are the local ones, which are not polled at all.
 *
 * ── Acting on a row you do not own ────────────────────────────────────────
 *
 * `interrupt`/`resume`/`kill`/`steer` reach this process's own children. A
 * daemon row has no child here to signal, so those refuse — and `steer`, which
 * has a reason channel, says why rather than returning a bare false that reads
 * as "the agent ignored you". A product's own act surface drives the daemon's
 * verbs for the acts the daemon serves.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { ProcessNode } from '../fleet/index.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';

/** How often the daemon's rows are re-read. A local half is push-driven. */
export const DEFAULT_FLEET_REFRESH_MS = 15_000;

/** A daemon that answered, or an honest absence. Never a fabricated empty fleet. */
export interface DaemonFleetRows {
  readonly nodes: readonly ProcessNode[];
  readonly capturedAt: number;
}

/**
 * Read `fleet.snapshot`'s payload. Returns null — not an empty fleet — when the
 * shape is not what a daemon answers with, so "nobody answered" and "nothing is
 * running" stay distinguishable all the way to the view.
 */
export function readDaemonFleetRows(payload: unknown, now: () => number = Date.now): DaemonFleetRows | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nodes = Array.isArray(record['nodes']) ? record['nodes'] as readonly ProcessNode[] : null;
  if (!nodes) return null;
  const capturedAt = typeof record['capturedAt'] === 'number' ? record['capturedAt'] : now();
  return { nodes, capturedAt };
}

/**
 * The merge rule: every local node, then every daemon node whose id no local
 * node already carries. Order is local-first so a product that renders in array
 * order shows the rows it can act on at the top.
 */
export function mergeFleetNodes(
  localNodes: readonly ProcessNode[],
  daemonNodes: readonly ProcessNode[],
): readonly ProcessNode[] {
  const owned = new Set(localNodes.map((node) => node.id));
  return [...localNodes, ...daemonNodes.filter((node) => !owned.has(node.id))];
}

/**
 * What a surface says when asked to act on a row the daemon is running.
 *
 * A reason, not a bare false: "the agent ignored you" and "this act does not
 * reach that process" are different facts and a person acting on a fleet row
 * needs to be able to tell them apart.
 */
export function daemonOnlyFleetActRefusal(nodeId: string, surfaceLabel: string): string {
  return `${nodeId} is running on the daemon, not in ${surfaceLabel} — this act reaches only processes started here`;
}

export interface DaemonFleetRowsPollerOptions {
  readonly verbs: DaemonVerbCaller;
  readonly refreshIntervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug'>;
  readonly now?: () => number;
}

export interface DaemonFleetRowsPoller {
  /** The last rows the daemon answered with, or null before the first one lands. */
  rows(): DaemonFleetRows | null;
  /** Re-read the daemon's rows now. Never throws. */
  refresh(): Promise<void>;
  /** Called whenever a refresh changed the rows. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stop the refresh timer and drop the listeners. Idempotent. */
  stop(): void;
}

/**
 * Poll the adopted daemon's fleet rows on an interval.
 *
 * Inert until the first refresh lands: before then, and whenever the daemon
 * cannot answer, `rows()` is null — which is the honest answer, not a degraded
 * one. A daemon that stops answering keeps its LAST known rows rather than
 * dropping them, so a momentary blip does not make half the fleet blink out and
 * back.
 */
export function createDaemonFleetRowsPoller(options: DaemonFleetRowsPollerOptions): DaemonFleetRowsPoller {
  const log = options.log ?? logger;
  const now = options.now ?? Date.now;
  let current: DaemonFleetRows | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const listeners = new Set<() => void>();

  const refresh = async (): Promise<void> => {
    if (inFlight) return;
    const probe = options.verbs.probe();
    if (!probe.available) return; // no daemon configured: the local view IS the fleet
    inFlight = true;
    try {
      const next = readDaemonFleetRows(await options.verbs.invoke('fleet.snapshot', {}), now);
      if (next) {
        current = next;
        for (const listener of listeners) listener();
      }
    } catch (error) {
      // Keep the last known rows. A failed poll is a stale view, which the
      // capturedAt on the snapshot already discloses; dropping them would make
      // the daemon's half of the fleet disappear on one bad request.
      log.debug('[fleet] the daemon\'s rows could not be refreshed; keeping the last set', {
        error: summarizeError(error),
      });
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => { void refresh(); }, options.refreshIntervalMs ?? DEFAULT_FLEET_REFRESH_MS);
  timer.unref?.();
  void refresh();

  return {
    rows: () => current,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      listeners.clear();
    },
  };
}
