/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { AgentRecord } from './manager.js';

/**
 * Returns true when an agent is active (running or pending).
 *
 * Pure predicate with no runtime dependencies — intentionally a leaf module so
 * core/orchestrator code can share it without importing the heavier
 * `compaction-sections` module. Importing the predicate from `compaction-sections`
 * previously pulled that module into the orchestrator turn-loop graph, creating a
 * circular import that left the tool-loop circuit-breaker threshold constant in
 * its temporal dead zone (undefined) at runtime, so the breaker never tripped and
 * all-failed tool turns looped forever.
 */
export function isActiveAgent(a: Pick<AgentRecord, 'status'>): boolean {
  return a.status === 'running' || a.status === 'pending';
}
