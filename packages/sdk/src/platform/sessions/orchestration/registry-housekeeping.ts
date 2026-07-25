/**
 * Cross-Session Task Registry — housekeeping (content validation + reaping).
 *
 * Module-private companion to registry.ts: the pure, I/O-free half of the
 * persisted task graph's store obligations — parse-and-validate-by-content,
 * the bound constants (each a count cap AND an age TTL), and the idempotent
 * reap over a snapshot. Kept out of registry.ts so neither file carries two
 * jobs at once. Nothing here is re-exported from the package's public surface.
 */

import type {
  CrossSessionTaskRef,
  TaskDependencyEdge,
  TaskHandoffRecord,
  SessionTaskGraphSnapshot,
} from './types.js';
import { isLegacyTaskNamespace, makeRefKey } from './types.js';
import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.js';

/** Current schema version for the persisted graph file. */
export const GRAPH_SCHEMA_VERSION = 1;

/**
 * Count cap on persisted task refs.
 *
 * Sized far above any real cross-session fleet — a heavy day of linked work
 * tops out in the low hundreds of refs — so the cap only ever trims a graph
 * that has genuinely been leaking, while still holding the JSON file to a few
 * megabytes. Least-recently-updated refs are dropped first.
 */
const MAX_PERSISTED_REFS = 5_000;

/**
 * Age TTL for a task ref, measured from its last status update.
 *
 * 30 days is deliberately far longer than the longest plausible
 * pause-and-resume gap (hours to days). A ref that has not moved in a month
 * belongs to work nobody is resuming; keeping it only grows the file and
 * clutters the graph view.
 */
const REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on persisted handoff records — same reasoning as {@link MAX_PERSISTED_REFS}, smaller because handoffs are far rarer than refs. */
const MAX_PERSISTED_HANDOFFS = 1_000;

/**
 * A handoff is a ONE-SHOT record: once acknowledged it has fired and has only
 * display value. Kept for a day so `/session graph` can still show what moved
 * recently, then retired.
 */
const ACKNOWLEDGED_HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000;

/** An unacknowledged handoff is still actionable, so it gets the same generous TTL as a ref rather than the acknowledged one. */
const PENDING_HANDOFF_MAX_AGE_MS = REF_MAX_AGE_MS;

/** Periodic sweep interval (1 hour). Reaping must not be startup-only: a daemon-hosted registry can stay up for weeks. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a record must have sat untouched before "its owner does not exist"
 * is allowed to delete it.
 *
 * Owner-existence is the one reap rule that acts on an answer from OUTSIDE this
 * module, and that answer can be wrong in a way age and count never are. A
 * sweep that lands during startup — before the session broker has registered,
 * before a resume has re-attached, while a session is being created in another
 * process — gets a truthful "no such session" for a session that is about to
 * exist. Without a floor, that momentary false answer is permanent data loss on
 * the very first tick.
 *
 * So a record must be BOTH unowned AND stale before it goes. 24 hours is far
 * longer than any startup race, reconnect, or handoff window, and far shorter
 * than the 30-day TTL that eventually collects the record anyway — so the floor
 * costs at most one extra day of a dead session's refs while removing the whole
 * class of transient-false-negative deletions.
 */
const OWNERLESS_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How long an unreadable graph file preserved aside is kept before deletion.
 *
 * 14 days: long enough that a crash noticed on Monday can still be
 * investigated the following week, short enough that a repeatedly-crashing
 * host does not keep forensic litter forever. Only ever one such file exists
 * (the quarantine name is fixed, so a later rename replaces it), so this is a
 * count cap of one plus an age TTL.
 */
export const QUARANTINE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Suffix for a graph file preserved aside because it could not be trusted. */
export const QUARANTINE_SUFFIX = '.unrecognized';

const TASK_LIFECYCLE_STATES: ReadonlySet<string> = new Set<TaskLifecycleState>([
  'queued',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

// ── Reap summary ──────────────────────────────────────────────────────────────

/**
 * What a single reap pass reclaimed. Every field is a count — the registry
 * never logs graph contents, only how much of it was removed and why.
 */
export interface CrossSessionGraphReapSummary {
  /** Refs dropped because their owning session no longer exists. */
  readonly refsMissingSession: number;
  /** Refs dropped because they exceeded {@link REF_MAX_AGE_MS} since their last update. */
  readonly refsExpired: number;
  /**
   * Refs from the pre-binding `'local'` namespace dropped by age. Counted apart
   * from {@link refsExpired} so the one-way drain-down of the legacy store is
   * visible in its own right — it is a migration finishing, not routine expiry.
   */
  readonly refsLegacyNamespaceExpired: number;
  /** Refs dropped because the graph exceeded {@link MAX_PERSISTED_REFS}. */
  readonly refsOverCap: number;
  /** Records dropped during parsing because their persisted shape did not validate. */
  readonly refsMalformed: number;
  /** Edges dropped because one or both endpoints were reaped. */
  readonly edgesDangling: number;
  /** Handoffs dropped because their session or task ref no longer exists. */
  readonly handoffsOrphaned: number;
  /** Handoffs retired after firing (acknowledged) or after ageing out unacknowledged. */
  readonly handoffsRetired: number;
  /** Handoffs dropped because the graph exceeded {@link MAX_PERSISTED_HANDOFFS}. */
  readonly handoffsOverCap: number;
  /** Handoff records dropped during parsing because their persisted shape did not validate. */
  readonly handoffsMalformed: number;
  /** Sum of every count above. Zero means the pass reclaimed nothing. */
  readonly total: number;
}

export const EMPTY_REAP_SUMMARY: CrossSessionGraphReapSummary = {
  refsMissingSession: 0,
  refsExpired: 0,
  refsLegacyNamespaceExpired: 0,
  refsOverCap: 0,
  refsMalformed: 0,
  edgesDangling: 0,
  handoffsOrphaned: 0,
  handoffsRetired: 0,
  handoffsOverCap: 0,
  handoffsMalformed: 0,
  total: 0,
};

// ── Content validation ────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validate one persisted ref record by CONTENT. Returns null when the record cannot be trusted. */
function validateRef(value: unknown): CrossSessionTaskRef | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['sessionId'])) return null;
  if (!isNonEmptyString(candidate['taskId'])) return null;
  if (typeof candidate['title'] !== 'string') return null;
  if (typeof candidate['status'] !== 'string' || !TASK_LIFECYCLE_STATES.has(candidate['status'])) return null;
  if (!isFiniteNumber(candidate['createdAt']) || !isFiniteNumber(candidate['updatedAt'])) return null;
  const label = candidate['label'];
  return {
    sessionId: candidate['sessionId'],
    taskId: candidate['taskId'],
    title: candidate['title'],
    // Narrowed above against the closed TaskLifecycleState set, so this is a
    // validated narrowing rather than a blind assertion.
    status: candidate['status'] as TaskLifecycleState,
    createdAt: candidate['createdAt'],
    updatedAt: candidate['updatedAt'],
    ...(typeof label === 'string' ? { label } : {}),
  };
}

function validateRefKeyPair(value: unknown): { sessionId: string; taskId: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['sessionId']) || !isNonEmptyString(candidate['taskId'])) return null;
  return { sessionId: candidate['sessionId'], taskId: candidate['taskId'] };
}

function validateEdge(value: unknown): TaskDependencyEdge | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const fromRef = validateRefKeyPair(candidate['fromRef']);
  const toRef = validateRefKeyPair(candidate['toRef']);
  if (!fromRef || !toRef) return null;
  const reason = candidate['reason'];
  return {
    fromRef,
    toRef,
    linkedAt: isFiniteNumber(candidate['linkedAt']) ? candidate['linkedAt'] : 0,
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

function validateHandoff(value: unknown): TaskHandoffRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['handoffId'])) return null;
  const taskRef = validateRefKeyPair(candidate['taskRef']);
  if (!taskRef) return null;
  if (!isNonEmptyString(candidate['fromSessionId']) || !isNonEmptyString(candidate['toSessionId'])) return null;
  if (!isFiniteNumber(candidate['initiatedAt'])) return null;
  if (typeof candidate['acknowledged'] !== 'boolean') return null;
  const reason = candidate['reason'];
  const acknowledgedAt = candidate['acknowledgedAt'];
  return {
    handoffId: candidate['handoffId'],
    taskRef,
    fromSessionId: candidate['fromSessionId'],
    toSessionId: candidate['toSessionId'],
    initiatedAt: candidate['initiatedAt'],
    acknowledged: candidate['acknowledged'],
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(isFiniteNumber(acknowledgedAt) ? { acknowledgedAt } : {}),
  };
}

/** The verdict of reading the persisted graph file. */
type GraphFileVerdict =
  | {
      readonly kind: 'ok';
      readonly snapshot: SessionTaskGraphSnapshot;
      readonly refsMalformed: number;
      readonly handoffsMalformed: number;
    }
  | { readonly kind: 'corrupt'; readonly detail: string }
  | { readonly kind: 'future'; readonly version: number };

/**
 * Parse and content-validate the persisted graph file.
 *
 * VERSION POLICY — tolerate backward, fail closed forward.
 *
 * The previous behaviour was a strict `version !== GRAPH_SCHEMA_VERSION`
 * equality check, which means the first schema bump silently discards every
 * graph already on disk. A strict envelope-version mismatch that rejects
 * everything has already caused a real incident in this codebase this cycle
 * (a catalog cache envelope version mismatch rejected every fixture), and the
 * failure is invisible: the user just finds their cross-session graph empty.
 *
 * So: any version at or below the current one is READ, because every field the
 * registry actually uses is validated record by record right here — an older
 * envelope that no longer matches simply loses the records that fail
 * validation, and those losses are counted and disclosed. A version ABOVE the
 * current one is rejected (a newer runtime may have written fields whose
 * meaning we would misinterpret) and the file is preserved aside rather than
 * overwritten, so the newer runtime's data survives.
 */
export function parseGraphFile(text: string): GraphFileVerdict {
  if (text.trim().length === 0) {
    return { kind: 'corrupt', detail: 'empty or whitespace-only file' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt', detail: 'unparseable JSON (truncated or torn write)' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'corrupt', detail: 'top-level value is not an object' };
  }
  const candidate = raw as Record<string, unknown>;
  const version = candidate['version'];
  if (!isFiniteNumber(version)) {
    return { kind: 'corrupt', detail: 'missing or non-numeric version' };
  }
  if (version > GRAPH_SCHEMA_VERSION) {
    return { kind: 'future', version };
  }
  const rawRefs = candidate['refs'];
  if (rawRefs === null || typeof rawRefs !== 'object' || Array.isArray(rawRefs)) {
    return { kind: 'corrupt', detail: 'refs is not an object' };
  }
  const rawEdges = candidate['edges'];
  const rawHandoffs = candidate['handoffs'];
  if (!Array.isArray(rawEdges) || !Array.isArray(rawHandoffs)) {
    return { kind: 'corrupt', detail: 'edges/handoffs are not arrays' };
  }

  const refs: Record<string, CrossSessionTaskRef> = {};
  let refsMalformed = 0;
  for (const value of Object.values(rawRefs as Record<string, unknown>)) {
    const ref = validateRef(value);
    if (!ref) {
      refsMalformed += 1;
      continue;
    }
    refs[makeRefKey(ref.sessionId, ref.taskId)] = ref;
  }

  const edges: TaskDependencyEdge[] = [];
  for (const value of rawEdges) {
    const edge = validateEdge(value);
    // A malformed edge is folded into the dangling-edge count by the reap pass
    // below (it is dropped for the same reason: it references nothing usable).
    if (edge) edges.push(edge);
  }

  const handoffs: TaskHandoffRecord[] = [];
  let handoffsMalformed = 0;
  for (const value of rawHandoffs) {
    const handoff = validateHandoff(value);
    if (!handoff) {
      handoffsMalformed += 1;
      continue;
    }
    handoffs.push(handoff);
  }

  return {
    kind: 'ok',
    snapshot: {
      version: 1,
      snapshotAt: isFiniteNumber(candidate['snapshotAt']) ? candidate['snapshotAt'] : Date.now(),
      refs,
      edges,
      handoffs,
    },
    refsMalformed,
    handoffsMalformed,
  };
}

// ── Reaping ───────────────────────────────────────────────────────────────────

interface GraphReapOptions {
  /** "Does this session still exist?" — absent means owner-existence reaping is skipped (age/count bounds still apply). */
  readonly sessionExists?: ((sessionId: string) => boolean) | undefined;
  readonly now: number;
}

/**
 * Pure reap over a snapshot. Idempotent by construction: every survivor
 * satisfies every predicate, so a second pass over the returned snapshot
 * reclaims nothing.
 */
export function reapGraphSnapshot(
  snapshot: SessionTaskGraphSnapshot,
  options: GraphReapOptions,
): { snapshot: SessionTaskGraphSnapshot; summary: CrossSessionGraphReapSummary } {
  const { now, sessionExists } = options;

  /**
   * Is this session id one we are permitted to judge by owner-existence at all?
   *
   * Two ids are not: the legacy `'local'` namespace (nobody can say which real
   * session those records belonged to — see isLegacyTaskNamespace), and any id
   * at all when the caller supplied no predicate. Both fall through to the age
   * and count bounds, which are always safe because they depend on nothing
   * outside the record itself.
   */
  const ownerJudgeable = (sessionId: string): boolean => Boolean(sessionExists) && !isLegacyTaskNamespace(sessionId);

  /**
   * Should a record be removed for having no owner? Requires BOTH an
   * authoritative "no" AND that the record has gone untouched for longer than
   * the grace floor — see OWNERLESS_GRACE_MS for why a bare predicate answer is
   * not enough on its own.
   */
  const ownerlessAndStale = (sessionId: string, updatedAt: number): boolean => {
    if (!ownerJudgeable(sessionId)) return false;
    if (sessionExists!(sessionId)) return false;
    return now - updatedAt > OWNERLESS_GRACE_MS;
  };

  let refsMissingSession = 0;
  let refsExpired = 0;
  let refsLegacyNamespaceExpired = 0;
  const survivingRefs: CrossSessionTaskRef[] = [];
  for (const ref of Object.values(snapshot.refs)) {
    if (ownerlessAndStale(ref.sessionId, ref.updatedAt)) {
      refsMissingSession += 1;
      continue;
    }
    if (now - ref.updatedAt > REF_MAX_AGE_MS) {
      // Legacy-namespace records are counted separately so the drain-down of
      // the pre-binding store is visible on its own, rather than hidden inside
      // the ordinary expiry number.
      if (isLegacyTaskNamespace(ref.sessionId)) refsLegacyNamespaceExpired += 1;
      else refsExpired += 1;
      continue;
    }
    survivingRefs.push(ref);
  }

  let refsOverCap = 0;
  let cappedRefs = survivingRefs;
  if (survivingRefs.length > MAX_PERSISTED_REFS) {
    cappedRefs = [...survivingRefs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PERSISTED_REFS);
    refsOverCap = survivingRefs.length - cappedRefs.length;
  }

  const refs: Record<string, CrossSessionTaskRef> = {};
  const liveKeys = new Set<string>();
  for (const ref of cappedRefs) {
    const key = makeRefKey(ref.sessionId, ref.taskId);
    refs[key] = ref;
    liveKeys.add(key);
  }

  let edgesDangling = 0;
  const edges: TaskDependencyEdge[] = [];
  for (const edge of snapshot.edges) {
    const fromKey = makeRefKey(edge.fromRef.sessionId, edge.fromRef.taskId);
    const toKey = makeRefKey(edge.toRef.sessionId, edge.toRef.taskId);
    if (!liveKeys.has(fromKey) || !liveKeys.has(toKey)) {
      edgesDangling += 1;
      continue;
    }
    edges.push(edge);
  }

  let handoffsOrphaned = 0;
  let handoffsRetired = 0;
  const survivingHandoffs: TaskHandoffRecord[] = [];
  for (const handoff of snapshot.handoffs) {
    const taskKey = makeRefKey(handoff.taskRef.sessionId, handoff.taskRef.taskId);
    // Same grace floor as refs, measured from when the handoff was initiated:
    // a handoff whose destination session has not registered YET is the exact
    // case the floor exists for — it is in flight, not orphaned.
    if (
      ownerlessAndStale(handoff.fromSessionId, handoff.initiatedAt) ||
      ownerlessAndStale(handoff.toSessionId, handoff.initiatedAt) ||
      !liveKeys.has(taskKey)
    ) {
      handoffsOrphaned += 1;
      continue;
    }
    if (handoff.acknowledged) {
      const firedAt = handoff.acknowledgedAt ?? handoff.initiatedAt;
      if (now - firedAt > ACKNOWLEDGED_HANDOFF_RETENTION_MS) {
        handoffsRetired += 1;
        continue;
      }
    } else if (now - handoff.initiatedAt > PENDING_HANDOFF_MAX_AGE_MS) {
      handoffsRetired += 1;
      continue;
    }
    survivingHandoffs.push(handoff);
  }

  let handoffsOverCap = 0;
  let handoffs = survivingHandoffs;
  if (survivingHandoffs.length > MAX_PERSISTED_HANDOFFS) {
    handoffs = [...survivingHandoffs].sort((a, b) => b.initiatedAt - a.initiatedAt).slice(0, MAX_PERSISTED_HANDOFFS);
    handoffsOverCap = survivingHandoffs.length - handoffs.length;
  }

  const total =
    refsMissingSession + refsExpired + refsLegacyNamespaceExpired + refsOverCap
    + edgesDangling + handoffsOrphaned + handoffsRetired + handoffsOverCap;

  return {
    snapshot: { version: 1, snapshotAt: now, refs, edges, handoffs },
    summary: {
      refsMissingSession,
      refsExpired,
      refsLegacyNamespaceExpired,
      refsOverCap,
      refsMalformed: 0,
      edgesDangling,
      handoffsOrphaned,
      handoffsRetired,
      handoffsOverCap,
      handoffsMalformed: 0,
      total,
    },
  };
}

