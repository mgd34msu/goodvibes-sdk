/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Fleet types — the normalized process-tree contract for the live process
 * registry. One queryable + subscribable aggregation surface that
 * enumerates every live/completed runtime process (agents incl. WRFC roles,
 * WRFC chains + subtasks, workflow-tool FSMs/triggers/schedules, watchers,
 * background processes) as flat `ProcessNode` records with parentId edges.
 *
 * Consumers (the TUI fleet tree, session tabs, orchestration
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
  | 'background-process'
  // Orchestration-engine pipeline nesting: workstream
  // (parent) -> phase (grouping) -> work-item, mirroring wrfc-chain/subtask.
  | 'workstream'
  | 'phase'
  | 'work-item'
  // The repo source-tree code index's initial build (Stage A). Not
  // 'background-process': an index build has no pid (ProcessManager
  // is shell/OS-process-only), so it gets its own kind, mirroring the
  // orchestrationEngine-dep precedent (optional dep, degrades to today when absent).
  | 'code-index';

/**
 * Derived fine-grained process state.
 *
 * Superset of the coarse manager statuses: `idle` and `queued` exist because
 * ScheduleEntry-between-runs and pending agents need honest states rather
 * than being force-fit into an active state.
 *
 * `interrupted` is a distinct TERMINAL outcome
 * from `killed`: both come from AgentManager.cancel(), but a graceful
 * interrupt request and a hard kill are display-distinguishable via
 * AgentRecord.terminationKind. There is no resume path — `cancel()` is
 * terminal in the current SDK, so 'interrupted' does NOT mean "process still
 * alive"; it means "the operator asked nicely" vs. "the operator killed it".
 *
 * `paused` is NOT terminal and NOT the same as
 * `killed`: a disabled trigger/schedule/automation-job still exists and can
 * be re-armed via `ProcessRegistry.resume()` — collapsing it into `killed`
 * (the previous behavior) was dishonest, since `killed` implies the
 * process is gone for good. See ProcessCapabilities.resumable.
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
  | 'interrupted'
  | 'idle'
  | 'queued'
  | 'paused';

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
  /**
   * Whether `ProcessRegistry.resume()` can re-arm
   * this node. True only for a node currently in the `paused` state whose
   * source manager exposes an `enable` control (trigger, schedule,
   * automation job) — false for every other kind/state, including a
   * `killed` node (kill is one-way; there is no un-kill).
   */
  readonly resumable: boolean;
  /**
   * Whether `ProcessRegistry.steer()` can queue a message for this
   * node. True only for a live in-process agent (or a wrfc-subtask with a
   * live member agent) AND only when the registry was constructed with a
   * `messageBus` dep — false everywhere when that dep is absent (graceful
   * degrade, no crash). Terminal nodes and non-conversational kinds
   * (wrfc-chain, workflow, trigger, schedule, watcher, background-process)
   * are never steerable.
   */
  readonly steerable: boolean;
}

/** Tab attach point: session/agent identity for transcript drill-downs. */
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

/**
 * Why a node needs a human's attention.
 * - 'approval' — a tool call on this node is blocked waiting for an
 *   approve/deny decision (derived from a pending shared approval).
 * - 'input'    — the node is otherwise blocked waiting for operator input.
 */
export type ProcessAttentionReason = 'approval' | 'input';

/**
 * Derived attention marker for a node that is blocked on a human.
 *
 * This is a DERIVED view over the same authoritative signals the coarse
 * `state` is derived from (a pending shared approval) — it is recomputed on
 * every `query()`/tick and never persisted. It mirrors the registry's own
 * recorded contract: "the registry is a view, not a second source of truth"
 * (CHANGELOG 0.38.0). `needsAttention` therefore adds NO new store state; it is
 * a convenience projection of `state === 'awaiting-approval'` (and, when wired,
 * session-input-waiting) that carries the reason so a surface can route
 * attention without re-deriving it.
 */
export interface ProcessAttention {
  readonly reason: ProcessAttentionReason;
  /** Optional one-line human-facing detail (e.g. the tool awaiting approval). */
  readonly detail?: string | undefined;
}

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
  /**
   * Derived attention marker — present only while this node is blocked on a
   * human (approve/deny or input). Absent otherwise. Purely a projection of
   * `state`; see {@link ProcessAttention}.
   */
  readonly needsAttention?: ProcessAttention | undefined;
  readonly sessionRef?: ProcessSessionRef | undefined;
  /**
   * Best-of-N grouping — present only on a work-item node that is one sibling
   * attempt of a group (see attempts.ts). Lets the fleet surface render the N
   * siblings as one group and know which are candidates for a winner pick.
   * Absent on every ordinary (single-attempt) node.
   */
  readonly attemptGroup?: ProcessAttemptGroup | undefined;
  /** Opaque source record (AgentRecord, WrfcChain, …) for drill-downs. */
  readonly raw?: unknown;
}

/** A work-item node's best-of-N sibling grouping, surfaced on the wire. */
export interface ProcessAttemptGroup {
  readonly groupId: string;
  readonly index: number;
  readonly total: number;
  /** True while this sibling is a held (passed, parked) candidate awaiting the winner pick. */
  readonly held: boolean;
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
 * Result of `ProcessRegistry.steer()`.
 *
 * `queued: true` means the message was accepted onto the target's inbox —
 * NOT that the agent has seen it yet. Consumption (drained at the target's
 * next turn boundary) is a separate, later, honest signal: a
 * `COMMUNICATION_CONSUMED` runtime-bus event on the `communication` domain
 * carrying the same `messageId`.
 */
export type SteerResult = { readonly queued: true; readonly messageId: string } | { readonly queued: false; readonly reason: string };

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
   * Re-arm a `paused` node — triggers/schedules via
   * their manager's `enable()`, the inverse of `interrupt()`'s disable.
   * Honest refusal (returns false, no throw) for a node that is not
   * resumable: not found, not currently `paused`, or a kind whose source
   * manager exposes no `enable` control (e.g. an agent — there is no
   * resume path once cancelled, see ProcessState's `paused` doc).
   */
  resume(id: string): boolean;
  /**
   * Hard stop. Dispatches to the owning manager's control fn
   * (agent → cancel, background process → stop, watcher → stopWatcher,
   * workflow → cancel, trigger/schedule → remove). WRFC chain kill is
   * DERIVED, not native: it cascades AgentManager.cancel over the chain's
   * member agents. Returns the node ids that were actually acted on.
   */
  kill(id: string, opts?: ProcessKillOptions): readonly string[];
  /**
   * Queue a human message for a live in-process agent (or the current live
   * member agent of a wrfc-subtask), delivered at the target's next turn
   * boundary (next tool round / turn top) — never mid-token. Honest refusal
   * (`queued: false`) for anything that cannot take mid-run input: terminal
   * nodes, non-agent kinds, the wrfc-chain coordinator itself (steer its
   * member subtask instead), and any target when the registry has no
   * `messageBus` dep configured.
   */
  steer(id: string, text: string): SteerResult;
  /** Stop the tick, detach runtime-bus taps, drop all listeners. Idempotent. */
  dispose(): void;
}
