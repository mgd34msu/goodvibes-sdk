/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * dependency-gate.ts — the per-tick dependency pre-pass (BIG-3 item 2),
 * extracted from engine.ts so the engine stays under its line cap. Pure but for
 * the item-state mutations and the events it emits through the injected `emit`.
 */
import { dependencyStatus, firstPhase } from './scheduler.js';
import type { OrchestrationEvent, Workstream } from './types.js';

/**
 * Dependency-gate pre-pass, run at the top of every tick BEFORE computeClaims.
 * For each item still sitting at its FIRST phase in a pre-claim state (pending /
 * awaiting-capacity / blocked-dependency) with declared dependencies, classify
 * those dependencies and either release or refuse the item:
 *   - every dependency 'passed' → RELEASE: if it was 'blocked-dependency',
 *     restore it to 'pending' and clear blockedReason (emit
 *     item-dependency-cleared) so computeClaims can pick it up this same tick.
 *   - any dependency unmet → REFUSE: set 'blocked-dependency' with an honest
 *     blockedReason ('waiting on: …' or 'dependency failed: …'), recomputed
 *     every tick so it stays current as dependencies change; emit
 *     item-blocked-dependency only on a NEW block (never once per idle tick).
 *
 * Only FIRST-phase items are gated. Once an item's dependencies are all passed
 * at its first claim they stay passed (passed is terminal), so a mid-pipeline
 * item (currentPhaseId past the first phase) is never re-gated. A retried item
 * (engine.retryItem) is reset back to the first phase and is therefore re-gated
 * here — which is exactly why a failed dependency's dependents recover only once
 * the dependency is retried AND passes. A FAILED dependency keeps the dependent
 * blocked (recoverable), never fails it — refuse-not-kill.
 */
export function applyDependencyGates(workstream: Workstream, emit: (event: OrchestrationEvent) => void): void {
  const first = firstPhase(workstream);
  if (!first) return;
  for (const item of workstream.items) {
    if (item.dependsOn.length === 0) continue;
    if (item.currentPhaseId !== first.id) continue; // only gate at entry (first phase)
    if (item.state !== 'pending' && item.state !== 'awaiting-capacity' && item.state !== 'blocked-dependency') continue;
    const status = dependencyStatus(workstream, item);
    if (status.ready) {
      if (item.state === 'blocked-dependency') {
        item.state = 'pending';
        item.blockedReason = undefined;
        emit({ type: 'item-dependency-cleared', workstreamId: workstream.id, itemId: item.id });
      }
      continue;
    }
    const reason = status.failed.length > 0
      ? `dependency failed: ${status.failed.join(', ')}`
      : `waiting on: ${status.waiting.join(', ')}`;
    const wasAlreadyBlocked = item.state === 'blocked-dependency';
    item.state = 'blocked-dependency';
    item.blockedReason = reason;
    if (!wasAlreadyBlocked) {
      emit({
        type: 'item-blocked-dependency',
        workstreamId: workstream.id,
        itemId: item.id,
        phaseId: item.currentPhaseId ?? '',
        reason,
        deps: [...item.dependsOn],
      });
    }
  }
}
