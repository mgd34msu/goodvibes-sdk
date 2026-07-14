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
  // A HOSTED third-party coding agent (Claude Code / Codex CLI / opencode)
  // running as a long-lived daemon session over the Agent Client Protocol —
  // see platform/acp/host.ts and adapters/acp-host.ts.
  | 'acp-agent'
  // An externally-launched coding-agent session goodvibes did NOT spawn or host
  // (someone's own Claude Code / Codex process on this host), found by read-only
  // process-table detection. It is OBSERVED, not owned: it never counts against
  // fleet.maxSize (fleet-count.ts accepts only owned sources by construction),
  // stop is never offered, and steering rides whatever control channel the
  // foreign session genuinely exposes (a tmux pane) or honestly says there is
  // none. See adapters/observed.ts and observed/*.
  | 'observed-external'
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
 * Where a node's priced dollars came from: 'user' (manual/registration price —
 * "your price"), 'provider' (provider-served rates), 'catalog' (the dated
 * pricing catalog), or 'mixed' when priced contributors disagree (aggregate
 * nodes). Absent when nothing was priced.
 */
export type ProcessCostSource = 'user' | 'provider' | 'catalog' | 'mixed';

/**
 * Why a node needs a human's attention. ONE state class: every way a node can
 * be waiting on a human is a first-class reason here, so every surface
 * inherits glyph, count, jump key, and push from the same classification.
 * - 'approval' — a tool call on this node is blocked waiting for an
 *   approve/deny decision (derived from a pending shared approval).
 * - 'input'    — the node is otherwise blocked waiting for operator input.
 * - 'pick'     — a best-of-N attempt group is READY: every attempt settled,
 *   held candidates parked, and only a human's winner pick advances it.
 * - 'conflict' — a merge conflict needs a human resolution before the work
 *   can land.
 */
export type ProcessAttentionReason = 'approval' | 'input' | 'pick' | 'conflict';

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
  readonly costSource?: ProcessCostSource | undefined;
  /** Oldest ISO date (YYYY-MM-DD) among the dated (catalog/provider) pricing snapshots that contributed to costUsd; absent when none carried a date. */
  readonly pricingAsOf?: string | undefined;
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
   * One-line headline for this node, derived from its task/phase identity at
   * the read-model (see headlines.ts). Regenerated ONLY on task/phase
   * transitions and replaced in place — while the identity is unchanged the
   * same object (same `updatedAt`) is returned, so it can never behave as a
   * streaming feed. Length-capped at the read-model (HEADLINE_MAX_CHARS).
   */
  readonly headline?: ProcessHeadline | undefined;
  /**
   * Quiet marker — present only on a live node whose last observed activity
   * is older than the stall-tell threshold. Pure timestamp comparison, no
   * generated text; see headlines.ts deriveStallTell.
   */
  readonly stall?: ProcessStallTell | undefined;
  /**
   * Best-of-N grouping — present only on a work-item node that is one sibling
   * attempt of a group (see attempts.ts). Lets the fleet surface render the N
   * siblings as one group and know which are candidates for a winner pick.
   * Absent on every ordinary (single-attempt) node.
   */
  readonly attemptGroup?: ProcessAttemptGroup | undefined;
  /**
   * The latest review's verdict, score, and acceptance checklist — present
   * ONLY on a wrfc-chain / wrfc-subtask node whose review has completed.
   * Absent before any review (never an empty shell). See {@link ProcessReviewSummary}.
   */
  readonly review?: ProcessReviewSummary | undefined;
  /**
   * Observed foreign-agent facts — present ONLY on an `observed-external` node
   * (a coding-agent session goodvibes did not spawn or host). Absent on every
   * owned/hosted node. See {@link ProcessObserved}.
   */
  readonly observed?: ProcessObserved | undefined;
  /** Opaque source record (AgentRecord, WrfcChain, …) for drill-downs. */
  readonly raw?: unknown;
}

/**
 * A node's one-line headline. `updatedAt` moves only when the headline text
 * is regenerated (a task/phase transition) — a stable headline keeps its
 * original timestamp across snapshots.
 */
export interface ProcessHeadline {
  readonly text: string;
  readonly updatedAt: number;
}

/** The quiet marker: how long a live node has been silent, from timestamps only. */
export interface ProcessStallTell {
  /** Epoch ms of the node's last observed activity. */
  readonly since: number;
  /** now - since at snapshot time. */
  readonly quietForMs: number;
}

/**
 * The honest external kind of an observed foreign coding-agent process. Derived
 * from the process's binary/argv shape by read-only detection; `unknown` is a
 * real, honest value (a known-shape match failed) rather than a guess.
 */
export type ObservedAgentKind = 'claude-code' | 'codex' | 'opencode' | 'unknown';

/**
 * How (or whether) an observed foreign row can be steered. A genuine channel
 * carries what a surface needs to dispatch through it; `none` carries the plain
 * reason there is no channel so a surface renders the reason, never a dead
 * action. STOP is NEVER represented here — observing and steering a foreign
 * session is not owning its lifecycle.
 */
export type ObservedSteerChannel =
  | {
      readonly kind: 'tmux';
      /** The tmux pane id (e.g. `%90`) send-keys targets. */
      readonly paneId: string;
      /** The controlling terminal that mapped the process to the pane (e.g. `/dev/pts/11`). */
      readonly tty: string;
    }
  | {
      readonly kind: 'none';
      /** Plain-language reason no steer channel exists (no controlling tty, no tmux pane for the tty). */
      readonly reason: string;
    };

/**
 * Recent-activity liveness for an observed process, from cheap read-only OS
 * signals only. `active` means the process's cumulative CPU time ADVANCED since
 * the previous detection snapshot; `quiet` means it did not — which is NOT proof
 * the agent is idle (it may be blocked on the network or on a human), only that
 * no CPU was burned in the interval. The detail states exactly that.
 */
export interface ObservedLiveness {
  readonly state: 'active' | 'quiet';
  /** Cumulative CPU seconds the OS reports for the process (monotonic per pid). */
  readonly cpuSeconds: number;
  /** Plain-language meaning — honest about what `quiet` can and cannot tell you. */
  readonly detail: string;
}

/**
 * The observed-foreign-agent facts carried on an `observed-external` ProcessNode.
 * goodvibes did NOT spawn this process; the row's FIRST job is visibility, and
 * goodvibes never presents itself as the foreign session's cockpit. A steer verb
 * is offered only on the row's drill-in detail surface (see `steerDrillInOnly`),
 * only when `steer.kind` is a real channel, and stop is never offered at all.
 */
export interface ProcessObserved {
  readonly externalKind: ObservedAgentKind;
  readonly pid: number;
  /** The process's working directory, when derivable read-only. */
  readonly cwd?: string | undefined;
  readonly liveness: ObservedLiveness;
  readonly steer: ObservedSteerChannel;
  /**
   * UX weight (owner ruling): steering a foreign agent is a DRILL-IN capability,
   * available only once the row is opened in the visibility pane — never a
   * primary or bulk affordance. Always `true` on observed rows; a surface reads
   * it to keep the steer verb off the list and behind the row's detail view.
   */
  readonly steerDrillInOnly: true;
}

/**
 * One acceptance-checklist item from the latest review, as served on the wire:
 * the requirement the reviewer derived from the original task, whether it was
 * independently verified, and the evidence — so a consumer renders what was
 * ACTUALLY verified, not just a score. Long evidence is summarised
 * (length-capped) at the read-model.
 */
export interface ProcessReviewChecklistItem {
  readonly item: string;
  readonly verified: boolean;
  readonly evidence: string;
  readonly howExercised?: string | undefined;
}

/**
 * The latest review on a WRFC chain / compound sub-deliverable, served on the
 * wire. `passed` is the CONTROLLER verdict (gate-inclusive: checklist,
 * constraints, claims verification) — the reviewer's own claim cannot
 * overstate it. Present only once a review has completed; a chain that has
 * not been reviewed carries NO review field (absent, never an empty shell).
 */
export interface ProcessReviewSummary {
  readonly score: number;
  readonly passed: boolean;
  /** How many review cycles have completed (1 = first review). */
  readonly cycles: number;
  /** The acceptance checklist the reviewer scored against. Empty array = the reviewer emitted none (itself a gate failure). */
  readonly checklist: readonly ProcessReviewChecklistItem[];
}

/** A work-item node's best-of-N sibling grouping, surfaced on the wire. */
export interface ProcessAttemptGroup {
  readonly groupId: string;
  readonly index: number;
  readonly total: number;
  /** True while this sibling is a held (passed, parked) candidate awaiting the winner pick. */
  readonly held: boolean;
  /**
   * True once the WHOLE group is ready for the winner pick: every sibling
   * settled (held or failed) with at least one held candidate. The flagged
   * pick a panel acts on — candidates and diffs come from fleet.attempts.list
   * with this node's groupId, and fleet.attempts.pick completes it.
   */
  readonly ready: boolean;
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
export type SteerResult =
  | { readonly queued: true; readonly messageId: string; readonly woke?: boolean | undefined }
  | { readonly queued: false; readonly reason: string };

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
