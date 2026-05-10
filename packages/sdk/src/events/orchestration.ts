/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * OrchestrationEvent — task-graph and bounded-recursion lifecycle events.
 */

export interface OrchestrationTaskContract {
  allowedTools?: string[] | undefined;
  capabilityCeiling?: string[] | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
  reviewMode?: 'none' | 'wrfc' | undefined;
  inheritsParentConstraints?: boolean | undefined;
  communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
}

export type OrchestrationEvent =
  | { type: 'ORCHESTRATION_GRAPH_CREATED'; graphId: string; title: string; mode: 'single-worker' | 'parallel-workers' | 'review-loop' | 'graph-execute' }
  | { type: 'ORCHESTRATION_NODE_ADDED'; graphId: string; nodeId: string; title: string; role: 'planner' | 'orchestrator' | 'engineer' | 'reviewer' | 'fixer' | 'verifier' | 'researcher' | 'integrator'; parentNodeId?: string; dependsOn?: string[]; taskId?: string; agentId?: string; contract?: OrchestrationTaskContract }
  | { type: 'ORCHESTRATION_NODE_READY'; graphId: string; nodeId: string }
  | { type: 'ORCHESTRATION_NODE_STARTED'; graphId: string; nodeId: string; taskId?: string; agentId?: string }
  | { type: 'ORCHESTRATION_NODE_PROGRESS'; graphId: string; nodeId: string; message: string }
  | { type: 'ORCHESTRATION_NODE_BLOCKED'; graphId: string; nodeId: string; reason: string }
  | { type: 'ORCHESTRATION_NODE_COMPLETED'; graphId: string; nodeId: string; summary?: string }
  | { type: 'ORCHESTRATION_NODE_FAILED'; graphId: string; nodeId: string; error: string }
  | { type: 'ORCHESTRATION_NODE_CANCELLED'; graphId: string; nodeId: string; reason?: string }
  | { type: 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED'; graphId: string; nodeId?: string | undefined; depth: number; activeAgents: number; reason: string };

export type OrchestrationEventType = OrchestrationEvent['type'];
