/**
 * orchestrator-usage.ts, the running token totals, as a name.
 *
 * `Orchestrator.usage` was an inferred object literal on the class, so a caller
 * that folds these across conversations, and has to declare the accumulator's
 * type to do it, could reach the shape and not the name. A surface doing
 * exactly that wrote the four fields out again locally.
 *
 * It lives beside the class rather than in it because the class is at its
 * line ceiling, and because a type callers name is not orchestration logic.
 */

/** The running token totals an Orchestrator accumulates over a conversation. */
export interface OrchestratorUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
