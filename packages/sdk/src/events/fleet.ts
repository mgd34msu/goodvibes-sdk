/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * FleetEvent — discriminated union of live process-registry lifecycle events.
 *
 * These are the wire-surfaced, poll-free counterpart to the ProcessRegistry's
 * in-process coalesced snapshot tick: an emit-bridge diffs consecutive registry
 * snapshots and emits these per-node lifecycle deltas onto the runtime event bus
 * `fleet` domain, which the control-plane gateway already fans out to subscribed
 * SSE/WebSocket clients (no new channel). Every field here is DERIVED from the
 * authoritative snapshot — the events carry no state the snapshot does not, in
 * keeping with the registry's contract ("a view, not a second source of truth").
 *
 * The kind/state/attention string unions are structural duplicates of
 * ProcessKind / ProcessState / ProcessAttentionReason
 * (platform/runtime/fleet/types.ts), kept inline so this leaf event module stays
 * free of a `platform/` import — the same independence precedent as AgentUsage
 * in ./agents.ts.
 */

/** Mirrors ProcessKind. */
export type FleetNodeKind =
  | 'agent'
  | 'wrfc-chain'
  | 'wrfc-subtask'
  | 'workflow'
  | 'trigger'
  | 'schedule'
  | 'watcher'
  | 'background-process'
  | 'workstream'
  | 'phase'
  | 'work-item'
  | 'code-index';

/** Mirrors ProcessState. */
export type FleetNodeState =
  | 'thinking'
  | 'executing-tool'
  | 'awaiting-approval'
  | 'streaming'
  | 'stalled'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'killed'
  | 'interrupted'
  | 'idle'
  | 'queued'
  | 'paused';

/** Mirrors ProcessAttentionReason. */
export type FleetAttentionReason = 'approval' | 'input';

export type FleetEvent =
  /** A node appeared in the fleet for the first time. */
  | {
      type: 'FLEET_NODE_STARTED';
      nodeId: string;
      kind: FleetNodeKind;
      label: string;
      state: FleetNodeState;
      parentId?: string | undefined;
      sessionId?: string | undefined;
    }
  /** A node's coarse state changed (non-terminal, non-block transition). */
  | {
      type: 'FLEET_NODE_STATE_CHANGED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      previousState: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    }
  /** A node reached a terminal state (done/failed/killed/interrupted). */
  | {
      type: 'FLEET_NODE_FINISHED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      previousState: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    }
  /** A node became blocked waiting for a human (approve/deny or input). */
  | {
      type: 'FLEET_NODE_BLOCKED_ON_USER';
      nodeId: string;
      kind: FleetNodeKind;
      reason: FleetAttentionReason;
      label: string;
      detail?: string | undefined;
      sessionId?: string | undefined;
      agentId?: string | undefined;
    }
  /** A previously blocked node is no longer waiting on a human. */
  | {
      type: 'FLEET_NODE_UNBLOCKED';
      nodeId: string;
      kind: FleetNodeKind;
      state: FleetNodeState;
      label: string;
      sessionId?: string | undefined;
    };

export type FleetEventType = FleetEvent['type'];
