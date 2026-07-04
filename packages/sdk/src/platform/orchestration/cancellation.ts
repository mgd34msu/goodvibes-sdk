/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Per-work-item cancellation registry (Wave 4, wo701) — the deferred W0.1
 * cooperative-cancellation piece.
 *
 * One AbortController per in-flight WorkItem. `engine.kill(itemId)` aborts
 * the controller here AND calls `agentManager.cancel(agentId, 'kill')` — the
 * same mechanism every agent in the system already uses to stop at its next
 * turn boundary (orchestrator-runner.ts's `record.status === 'cancelled'`
 * poll). That covers "no orphaned AGENT" unconditionally.
 *
 * The AbortSignal this registry hands out is ALSO registered on AgentManager
 * (registerCancellationSignal) so opted-in tools (exec, fetch) can abort an
 * in-flight child process/request immediately instead of waiting for that
 * turn boundary — see AgentManager.getCancellationSignal /
 * AgentOrchestrator.setCancellationSource / orchestrator-runner.ts's
 * `context.getCancellationSignal?.(record.id)` threaded into
 * `toolRegistry.execute` opts.
 */
export interface CancellationRegistry {
  /** Create (replacing any prior registration) the controller for a work item and return its signal. */
  start(itemId: string): AbortSignal;
  /** Abort the item's controller, if one is registered. Returns false when nothing was registered (already terminal, or never started). */
  abort(itemId: string): boolean;
  /** Drop the registration once the item's phase run has ended (success, failure, or cancel). Safe to call unconditionally. */
  release(itemId: string): void;
  /** True when this item currently has a live (non-aborted) registration. */
  isActive(itemId: string): boolean;
}

export function createCancellationRegistry(): CancellationRegistry {
  const controllers = new Map<string, AbortController>();

  function start(itemId: string): AbortSignal {
    controllers.get(itemId)?.abort();
    const controller = new AbortController();
    controllers.set(itemId, controller);
    return controller.signal;
  }

  function abort(itemId: string): boolean {
    const controller = controllers.get(itemId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  function release(itemId: string): void {
    controllers.delete(itemId);
  }

  function isActive(itemId: string): boolean {
    const controller = controllers.get(itemId);
    return controller !== undefined && !controller.signal.aborted;
  }

  return { start, abort, release, isActive };
}
