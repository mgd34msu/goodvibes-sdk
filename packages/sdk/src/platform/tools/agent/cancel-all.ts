/**
 * cancel-all.ts
 *
 * Cancel every agent run a graph is still hosting, over `AgentManager`'s public
 * surface. A free function rather than a method because `manager.ts` sits at its
 * grandfathered line ceiling (scripts/line-cap-grandfather.json) with no room,
 * and it needs nothing private: `list()` and `cancel()` are both public and are
 * exactly the ordinary operator kill path.
 */

import type { AgentRecord } from './manager.js';

/** The slice of `AgentManager` this needs. Structural, so a test can stand in for it. */
export interface CancellableAgentRuns {
  list(): AgentRecord[];
  cancel(id: string, kind?: 'interrupt' | 'kill'): boolean;
}

/**
 * Cancel every pending or running agent. Returns how many were cancelled.
 *
 * Called when the runtime graph is disposed. By that point the fleet registry,
 * orchestration engine, process registry and event bus these runs report
 * through have all been taken down, so an agent still "running" has nowhere to
 * publish progress, nothing to write results into and no operator left to
 * answer it, it is orphaned, not preserved.
 *
 * It is also the only shutdown-reachable way into an in-flight provider call:
 * each record's cancellation signal is what aborts the HTTP request and cuts
 * short the retry backoff, which otherwise keeps a dead daemon's turn sleeping
 * through as much as 30 seconds per attempt.
 *
 * Goes through the ordinary cancel path, so every record ends in the same state
 * an operator kill produces, no new terminal state and the same events.
 */
export function cancelAllAgentRuns(manager: CancellableAgentRuns): number {
  let cancelled = 0;
  for (const record of manager.list()) {
    if (record.status !== 'pending' && record.status !== 'running') continue;
    if (manager.cancel(record.id, 'kill')) cancelled += 1;
  }
  return cancelled;
}
