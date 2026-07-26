/**
 * types.ts — the declarative trigger DSL and its record shapes.
 *
 * Three watcher kinds share one supervision spine (backoff ladder, strike
 * breaker, persisted state ring buffer):
 *
 *   stream    — a long-lived command whose output is regex-filtered, batched
 *               and de-duplicated; an agent is invoked only after a match.
 *   condition — a model-free check: probe -> extract -> rule, no LLM in the
 *               loop, structured state persisted between checks.
 *   on-exit   — a one-shot payload fired exactly once when a supervised child
 *               process terminates, owned by the daemon so it outlives the
 *               turn that created it.
 *
 * Everything here is DATA. There is no JS-expression escape hatch anywhere in
 * the DSL: the SDK has no JS sandbox, and a config-driven unattended watcher is
 * not the place to introduce one. `validation.ts` enforces that at the door.
 */

export type TriggerKind = 'stream' | 'condition' | 'on-exit';

/** A value a probe can yield. Deliberately JSON-shaped — no functions. */
export type TriggerValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: TriggerValue }
  | readonly TriggerValue[];

// ─── Probe ────────────────────────────────────────────────────────────────────

/** HTTP probe. Static url/headers/body only — nothing is interpolated at run time. */
export interface HttpProbe {
  readonly kind: 'http';
  readonly url: string;
  readonly method?: 'GET' | 'HEAD' | 'POST' | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** What the extractor receives: the response body, its status, or both. */
  readonly capture?: 'body' | 'status' | 'envelope' | undefined;
}

/** File probe — reads a path, or reports its stat signature when `stat` is set. */
export interface FileProbe {
  readonly kind: 'file';
  readonly path: string;
  readonly capture?: 'content' | 'stat' | undefined;
  readonly maxBytes?: number | undefined;
}

/**
 * Command probe. argv form on purpose: no shell, no metacharacters, no
 * interpolation of extracted values back into the command. A probe is a fixed
 * measurement, not a place to compose new commands.
 */
export interface CommandProbe {
  readonly kind: 'command';
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly capture?: 'stdout' | 'stderr' | 'exit-code' | 'envelope' | undefined;
}

/** Calls one bounded, pre-registered SDK tool and extracts from its result. */
export interface SdkToolProbe {
  readonly kind: 'sdk-tool';
  readonly tool: string;
  readonly input?: Readonly<Record<string, TriggerValue>> | undefined;
  readonly timeoutMs?: number | undefined;
}

export type TriggerProbe = HttpProbe | FileProbe | CommandProbe | SdkToolProbe;

// ─── Extract ──────────────────────────────────────────────────────────────────

/** Bounded JSONPath subset: `$`, `.key`, `["key"]`, `[0]`, `[*]`. */
export interface JsonPathExtract {
  readonly kind: 'jsonpath';
  readonly path: string;
}

export interface RegexExtract {
  readonly kind: 'regex';
  readonly pattern: string;
  /** Only `i`, `m`, `s` and `u` are accepted — `g`/`y` carry lastIndex state. */
  readonly flags?: string | undefined;
  readonly group?: number | undefined;
}

/** Bounded jq subset: `.a.b`, `.a[0]`, `.a[]`, and the `length`/`keys` filters. */
export interface JqSubsetExtract {
  readonly kind: 'jq-subset';
  readonly expression: string;
}

/** Pass the probe result through unchanged. */
export interface RawExtract {
  readonly kind: 'raw';
}

export type TriggerExtract = JsonPathExtract | RegexExtract | JqSubsetExtract | RawExtract;

// ─── Rules ────────────────────────────────────────────────────────────────────

export type ComparisonOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'not-contains'
  | 'matches';

/** Fires whenever the extracted value differs from the previous observation. */
export interface ChangeRule {
  readonly kind: 'change';
  /** Fire on the very first observation too. Default false. */
  readonly fireOnFirst?: boolean | undefined;
}

/** Fires while the extracted value satisfies a comparison. */
export interface ValueRule {
  readonly kind: 'value';
  readonly operator: ComparisonOperator;
  readonly operand: TriggerValue;
  /** Fire on every matching check rather than only on the entering edge. */
  readonly level?: boolean | undefined;
}

/** Fires on one specific previous -> current pair. */
export interface TransitionRule {
  readonly kind: 'transition';
  readonly from: string;
  readonly to: string;
}

/**
 * Threshold with hysteresis: arms above `enter` and does not re-arm until the
 * value has fallen back past `exit` (mirrored for `direction: 'below'`).
 */
export interface ThresholdRule {
  readonly kind: 'threshold';
  readonly direction: 'above' | 'below';
  readonly enter: number;
  readonly exit: number;
}

/** Fires only after the inner rule has matched N consecutive checks. */
export interface DebounceRule {
  readonly kind: 'debounce-n';
  readonly count: number;
  readonly inner: TriggerRule;
}

/** Suppresses a repeat fire for the same fingerprint inside a TTL. */
export interface DedupRule {
  readonly kind: 'dedup-ttl';
  readonly ttlMs: number;
  readonly inner: TriggerRule;
}

/** Compares the change per second across a time window. */
export interface RateOfChangeRule {
  readonly kind: 'rate-of-change';
  readonly windowMs: number;
  readonly operator: ComparisonOperator;
  readonly operand: number;
  /** Per second (default) or per minute. */
  readonly per?: 'second' | 'minute' | undefined;
}

export type WindowAggregate = 'min' | 'max' | 'mean' | 'sum' | 'count' | 'stddev';

/** Compares an aggregate over the observations inside a time window. */
export interface WindowedAggregateRule {
  readonly kind: 'windowed-aggregate';
  readonly windowMs: number;
  readonly aggregate: WindowAggregate;
  readonly operator: ComparisonOperator;
  readonly operand: number;
  /** Minimum samples required before the aggregate is trusted. Default 1. */
  readonly minSamples?: number | undefined;
}

/**
 * Cross-watcher correlation over the bounded shared event log. `all` requires
 * every named trigger to have fired inside the window, `any` requires one, and
 * `sequence` requires them in the listed order.
 */
export interface CorrelationRule {
  readonly kind: 'correlation';
  readonly triggerIds: readonly string[];
  readonly withinMs: number;
  readonly require: 'all' | 'any' | 'sequence';
}

export type TriggerRule =
  | ChangeRule
  | ValueRule
  | TransitionRule
  | ThresholdRule
  | DebounceRule
  | DedupRule
  | RateOfChangeRule
  | WindowedAggregateRule
  | CorrelationRule;

// ─── Fire actions ─────────────────────────────────────────────────────────────

/**
 * Starts an agent turn. `prompt` is an OPTIONAL prefix: every kind already
 * renders a default template that states what happened and, for on-exit,
 * forces the agent to read the termination state before acting. A caller who
 * wants extra standing instructions puts them here and they are prepended.
 */
export interface AgentTurnAction {
  readonly kind: 'agent-turn';
  readonly prompt?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Runs a pre-registered action grant. The grant was written down and confirmed
 * while a person was present; the digest is recomputed at fire time and must
 * match byte for byte. There is deliberately no "compose a shell command now"
 * action — that is the one path with no person in the loop.
 */
export interface ActionGrantAction {
  readonly kind: 'action-grant';
  readonly grantId: string;
  readonly digest: string;
}

export type TriggerFireAction = AgentTurnAction | ActionGrantAction;

/** A pre-registered, digest-pinned action, confirmed at creation time. */
export interface TriggerActionGrant {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly createdAt: number;
  readonly confirmedAt: number;
  readonly confirmedBy: string;
  readonly digest: string;
}

// ─── Definitions ──────────────────────────────────────────────────────────────

export interface StreamTriggerSpec {
  readonly kind: 'stream';
  /** The long-lived command, argv form. Supervised and restarted on the ladder. */
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** Lines must match this to enter the queue. */
  readonly match: RegexExtract;
  /** Lines matching this are discarded even when `match` accepted them. */
  readonly exclude?: RegexExtract | undefined;
  readonly batchLines?: number | undefined;
  readonly batchIntervalMs?: number | undefined;
  readonly queueLimit?: number | undefined;
  /** Suppress a repeat of the same matched line inside this TTL. */
  readonly dedupTtlMs?: number | undefined;
  /** Restart the command when it exits. Default true. */
  readonly restart?: boolean | undefined;
}

export interface ConditionTriggerSpec {
  readonly kind: 'condition';
  readonly probe: TriggerProbe;
  readonly extract: TriggerExtract;
  readonly rule: TriggerRule;
  readonly intervalMs?: number | undefined;
}

export interface OnExitTriggerSpec {
  readonly kind: 'on-exit';
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly stdin?: 'none' | 'empty' | undefined;
  readonly outputTailBytes?: number | undefined;
}

export type TriggerSpec = StreamTriggerSpec | ConditionTriggerSpec | OnExitTriggerSpec;

/**
 * The trigger FAMILY's definition — one stream watcher, condition check, or
 * on-exit process trigger, supervised by platform/triggers/manager.ts.
 *
 * NOTE — there is a second, unrelated `TriggerDefinition` in
 * platform/tools/workflow/index.ts: the workflow tool's `on <event> do <action>`
 * rule inside a workflow FSM. The two live in separate export subpaths and
 * never meet in one import, but BOTH publish fleet nodes under the 'trigger'
 * kind, so fleet control paths discriminate with `isWatcherTriggerRaw`
 * (runtime/fleet/adapters/watcher-trigger.ts) instead of trusting the kind.
 */
export interface TriggerDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly spec: TriggerSpec;
  readonly action: TriggerFireAction;
  /** Session that created it; used by recovery reaping. */
  readonly ownerSessionId?: string | undefined;
  readonly createdAt: number;
}

// ─── Termination metadata ─────────────────────────────────────────────────────

/**
 * Why a supervised child stopped. `unknown` is a first-class outcome: when the
 * daemon restarts and the child is gone, an honest `daemon-restart` fire beats
 * a trigger that silently evaporates.
 */
export type TerminationState = 'exited' | 'signalled' | 'timed-out' | 'unknown';

export type TerminationReason =
  | 'normal'
  | 'nonzero-exit'
  | 'signal'
  | 'max-duration'
  | 'daemon-restart'
  | 'cancelled';

export interface TerminationMetadata {
  readonly state: TerminationState;
  readonly reason: TerminationReason;
  /** Null when the child was signalled, or when the outcome is unknown. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly pid: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  /** True when the outcome could not be observed (daemon restart). */
  readonly observed: boolean;
}

// ─── Runtime records ──────────────────────────────────────────────────────────

export type TriggerState =
  | 'idle'
  | 'running'
  | 'backoff'
  | 'circuit-open'
  | 'fired'
  | 'cancelled'
  | 'failed';

/** One persisted sample in a trigger's ring buffer. */
export interface TriggerObservation {
  readonly at: number;
  readonly value: TriggerValue;
  /** Stable string form used by change/transition/dedup rules. */
  readonly text: string;
  /** Numeric coercion, or null when the value is not numeric. */
  readonly numeric: number | null;
}

export interface TriggerRunRecord {
  readonly at: number;
  readonly outcome: 'checked' | 'fired' | 'failed' | 'suppressed' | 'skipped';
  readonly detail?: string | undefined;
  readonly observation?: TriggerObservation | undefined;
  readonly termination?: TerminationMetadata | undefined;
  readonly actionResult?: string | undefined;
  readonly durationMs?: number | undefined;
}

/** Rule bookkeeping that must survive a restart (armed edges, dedup marks). */
export interface TriggerRuleState {
  /** Threshold hysteresis: true while the rule is above/below its enter bound. */
  readonly armed?: boolean | undefined;
  /** debounce-n: consecutive inner matches so far. */
  readonly streak?: number | undefined;
  /** dedup-ttl: fingerprint -> last fire timestamp. */
  readonly dedupMarks?: Readonly<Record<string, number>> | undefined;
  /** Edge-triggered value rules: whether the last check matched. */
  readonly lastMatched?: boolean | undefined;
}

export interface TriggerRecord {
  readonly definition: TriggerDefinition;
  readonly state: TriggerState;
  readonly observations: readonly TriggerObservation[];
  readonly runs: readonly TriggerRunRecord[];
  readonly ruleState: TriggerRuleState;
  /** Consecutive failures; feeds the ladder and the breaker. */
  readonly strikes: number;
  /** Index into the backoff ladder while the trigger is in backoff. */
  readonly backoffRung: number;
  readonly nextCheckAt?: number | undefined;
  readonly lastError?: string | undefined;
  readonly lastFiredAt?: number | undefined;
  readonly firedCount: number;
  /** Lines dropped by the bounded stream queue, surfaced rather than silent. */
  readonly droppedLines: number;
  /** on-exit: the child we launched, so recovery can tell whether it survived. */
  readonly process?: TrackedProcessRef | undefined;
  readonly updatedAt: number;
}

/**
 * A process this daemon launched. A trigger binds only to one of these records,
 * never to an arbitrary existing PID — a stale PID belongs to somebody else's
 * process by the time we come back.
 */
export interface TrackedProcessRef {
  readonly processId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly command: string;
  readonly args: readonly string[];
  /** Daemon boot id at launch; a mismatch on load means the daemon restarted. */
  readonly daemonBootId: string;
}

// ─── Shared correlation event log ─────────────────────────────────────────────

export interface TriggerEventLogEntry {
  readonly at: number;
  readonly triggerId: string;
  readonly kind: TriggerKind;
  readonly event: 'fired' | 'failed' | 'observed';
  readonly fingerprint: string;
}

// ─── Recovery ─────────────────────────────────────────────────────────────────

/** What the recovery sweep removed. Silent deletion reads as data loss. */
export interface TriggerRecoveryReport {
  readonly at: number;
  readonly reason: 'startup' | 'sweep';
  readonly triggersLoaded: number;
  readonly triggersReaped: number;
  readonly reapedIds: readonly string[];
  readonly runsReaped: number;
  readonly observationsReaped: number;
  readonly eventsReaped: number;
  readonly orphanedProcesses: readonly string[];
  /** Set when the store was unreadable or failed content validation. */
  readonly quarantined?: string | undefined;
}
