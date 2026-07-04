/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Fleet types — the normalized process-tree contract for the live process
 * registry (W2.1). One queryable + subscribable aggregation surface that
 * enumerates every live/completed runtime process (agents incl. WRFC roles,
 * WRFC chains + subtasks, workflow-tool FSMs/triggers/schedules, watchers,
 * background processes) as flat `ProcessNode` records with parentId edges.
 *
 * Consumers (the TUI fleet tree, Wave-3 session tabs, Wave-4 orchestration
 * nesting) build the tree from the flat list — this keeps the registry cheap
 * and lets each surface reorder/filter independently.
 */

/** The source family a ProcessNode was adapted from. */
export type ProcessKind =
  | 'agent'
  | 'wrfc-chain'
  | 'wrfc-subtask'
  | 'workflow'
  | 'trigger'
  | 'schedule'
  | 'watcher'
  | 'background-process';

/**
 * Derived fine-grained process state.
 *
 * Superset of the coarse manager statuses: `idle` and `queued` exist because
 * ScheduleEntry-between-runs and pending agents need honest states rather
 * than being force-fit into an active state.
 */
export type ProcessState =
  | 'thinking'
  | 'executing-tool'
  | 'awaiting-approval'
  | 'streaming'
  | 'stalled'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'killed'
  | 'idle'
  | 'queued';

/** Token/call usage aggregated onto a node. Mirrors AgentRecord.usage + toolCallCount. */
export interface ProcessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number | undefined;
  readonly llmCallCount: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
}

/** The most recent observable activity on a node (tool call, output line, or phase label). */
export interface ProcessActivity {
  readonly kind: 'tool' | 'output-line' | 'phase';
  readonly text: string;
  readonly toolName?: string | undefined;
  /** Epoch ms when this activity was observed. Stable per activity (not per query). */
  readonly at: number;
}

/** Which control operations the registry can dispatch for this node. */
export interface ProcessCapabilities {
  readonly interruptible: boolean;
  readonly killable: boolean;
  readonly pausable: boolean;
}

/** Wave-3 tab attach point: session/agent identity for transcript drill-downs. */
export interface ProcessSessionRef {
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
}

/**
 * Whether `costUsd` is a real reading.
 * - 'priced'    — every contributing usage record resolved to catalog pricing.
 * - 'unpriced'  — no pricing available; `costUsd` is null, never a fabricated zero.
 * - 'estimated' — partial: some contributors priced, some not (aggregate nodes only).
 */
export type ProcessCostState = 'priced' | 'unpriced' | 'estimated';

/** One normalized process in the fleet. Flat record; `parentId` expresses the tree. */
export interface ProcessNode {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly parentId?: string | undefined;
  readonly label: string;
  readonly task?: string | undefined;
  readonly state: ProcessState;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  /** (completedAt ?? now) - startedAt when startedAt is known, else 0. */
  readonly elapsedMs: number;
  readonly usage?: ProcessUsage | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly costUsd?: number | null | undefined;
  readonly costState: ProcessCostState;
  readonly currentActivity?: ProcessActivity | undefined;
  readonly capabilities: ProcessCapabilities;
  readonly sessionRef?: ProcessSessionRef | undefined;
  /** Opaque source record (AgentRecord, WrfcChain, …) for drill-downs. */
  readonly raw?: unknown;
}

/** A point-in-time capture of the whole fleet. */
export interface FleetSnapshot {
  readonly capturedAt: number;
  readonly nodes: readonly ProcessNode[];
}

/** Optional narrowing for `query()`. Omitted fields mean "no constraint". */
export interface FleetQueryFilter {
  readonly kinds?: readonly ProcessKind[] | undefined;
  readonly states?: readonly ProcessState[] | undefined;
}

/** Options for `ProcessRegistry.kill()`. */
export interface ProcessKillOptions {
  /** Also kill all killable descendant nodes (children first). Default false. */
  readonly cascade?: boolean | undefined;
}

/**
 * The live process registry surface.
 *
 * `query()` is a cheap idempotent aggregate-on-read over the already-composed
 * managers (no owned store state). `subscribe()` is an in-registry callback
 * fed by a coalesced tick — it is NOT a runtime-bus event contract.
 */
export interface ProcessRegistry {
  /** Snapshot the fleet now. Cheap O(n) in-memory scans; safe to call per render tick. */
  query(filter?: FleetQueryFilter): FleetSnapshot;
  /** Find one node by id, or null. */
  getNode(id: string): ProcessNode | null;
  /**
   * Be notified with a fresh snapshot whenever the fleet materially changes
   * (coalesced ~tick granularity; unchanged ticks are silent).
   * Returns an unsubscribe function.
   */
  subscribe(listener: (snapshot: FleetSnapshot) => void): () => void;
  /**
   * Graceful interruption where the source supports one:
   * agents → AgentManager.cancel; triggers/schedules → disable (pause).
   * Returns true when an owning control accepted the request.
   */
  interrupt(id: string): boolean;
  /**
   * Hard stop. Dispatches to the owning manager's control fn
   * (agent → cancel, background process → stop, watcher → stopWatcher,
   * workflow → cancel, trigger/schedule → remove). WRFC chain kill is
   * DERIVED, not native: it cascades AgentManager.cancel over the chain's
   * member agents. Returns the node ids that were actually acted on.
   */
  kill(id: string, opts?: ProcessKillOptions): readonly string[];
  /** Stop the tick, detach runtime-bus taps, drop all listeners. Idempotent. */
  dispose(): void;
}
