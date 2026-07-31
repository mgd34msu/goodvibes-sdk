/**
 * approval-broker-raise.ts — raising an ask, as a free function.
 *
 * ── Why this is not a method ───────────────────────────────────────────────
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. approval-broker.ts sits within a few lines of the hand-authored source cap
 *    and this is its longest single body, so it follows the split the session
 *    broker already made (handleIntent → session-broker-intent.ts): a free
 *    function over an explicit deps object, with a thin delegating method left
 *    on the class.
 *
 * 2. Raising an ask now has TWO callers that want different things from it. The
 *    in-process one (`requestApproval`) wants the decision and nothing else —
 *    it is awaiting a human. The wire one (`approvals.raise`, routes/
 *    approvals-raise.ts) wants the RECORD, immediately, and must not hold an
 *    HTTP request open across a person's attention span. Both are the same act,
 *    so both go through this function; it returns the record AND the pending
 *    decision and lets each caller keep the half it needs.
 *
 * ── The coalescing rule, restated because it is subtle ─────────────────────
 *
 * A second identical in-flight ask (same session, tool and args) does not
 * create a second record or a second prompt: it attaches to the first record's
 * pending promise, so one decision resolves both. The returned `approval` is
 * then the EXISTING record — which is exactly what a wire caller needs, because
 * the id it gets back is the id whose updates it will see on the stream.
 * `coalesced` says which happened, so a caller that raised an ask and got back
 * a record older than its call can tell that from a fresh one.
 */

import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision } from '../permissions/prompt.js';
import type {
  RequestSharedApprovalInput,
  SharedApprovalAuditRecord,
  SharedApprovalRecord,
} from './approval-broker.js';
import { logger } from '../utils/logger.js';

/** A pending ask's resolvers and its expiry timer, as the broker holds them. */
export interface PendingApprovalEntry {
  readonly resolvers: ((decision: PermissionPromptDecision) => void)[];
  readonly timer?: ReturnType<typeof setTimeout> | undefined;
}

/** Everything raising an ask needs from the broker that owns the state. */
export interface RaiseApprovalDeps {
  /** Load persisted state before touching it — the broker's own `start()`. */
  start(): Promise<void>;
  /** The live record map, keyed by approval id. */
  readonly approvals: Map<string, SharedApprovalRecord>;
  /** The live pending-resolver map, keyed by approval id. */
  readonly pendingResolvers: Map<string, PendingApprovalEntry>;
  /** Write the record map to the store. */
  persist(): Promise<void>;
  /** Fan the record out: SSE `approval-update`, surface message, listeners. */
  publish(approval: SharedApprovalRecord): void;
  /** Expire an ask whose deadline passed. */
  expire(approvalId: string, note: string): Promise<void>;
  /** Audit-entry factory — the broker's own, so entries stay identical. */
  buildAudit(
    action: SharedApprovalAuditRecord['action'],
    actor: string,
    actorSurface?: string,
    note?: string,
  ): SharedApprovalAuditRecord;
  /** The (session, tool, args) coalescing key — the broker's own. */
  coalesceKey(sessionId: string | undefined, tool: string, args: Record<string, unknown>): string;
}

/** A raised ask: the record it produced, and the decision still to come. */
export interface RaisedApproval {
  readonly approval: SharedApprovalRecord;
  readonly decision: Promise<PermissionPromptDecision>;
  /** True when this ask attached to an identical one already in flight. */
  readonly coalesced: boolean;
}

/**
 * Raise an ask through the shared broker.
 *
 * Ordering is deliberate and unchanged from when this was a method: the record
 * is persisted BEFORE it is published and before any local prompt runs, and a
 * failed persist rolls the record and its resolver back out of both maps and
 * re-writes the corrected map to the file. An approval that a surface can see
 * and a restart cannot is the one failure this ordering exists to prevent.
 */
export async function raiseSharedApproval(
  input: RequestSharedApprovalInput,
  deps: RaiseApprovalDeps,
): Promise<RaisedApproval> {
  await deps.start();
  const now = Date.now();

  // Duplicate in-flight asks coalesce on (session, tool, args): the second
  // identical ask attaches to the first's pending record — ONE prompt, and
  // one decision resolves both. No second record, no second local prompt.
  const coalesceKey = deps.coalesceKey(input.sessionId, input.request.tool, input.request.args);
  for (const existing of deps.approvals.values()) {
    if ((existing.status === 'pending' || existing.status === 'claimed')
      && deps.coalesceKey(existing.sessionId, existing.request.tool, existing.request.args) === coalesceKey) {
      const pending = deps.pendingResolvers.get(existing.id);
      if (pending) {
        return {
          approval: existing,
          coalesced: true,
          decision: new Promise<PermissionPromptDecision>((resolve) => {
            pending.resolvers.push(resolve);
          }),
        };
      }
    }
  }

  const approval: SharedApprovalRecord = {
    id: `approval-${randomUUID().slice(0, 8)}`,
    callId: input.request.callId,
    sessionId: input.sessionId,
    routeId: input.routeId,
    status: 'pending',
    request: input.request,
    createdAt: now,
    updatedAt: now,
    ...(input.timeoutMs && input.timeoutMs > 0 ? { expiresAt: now + input.timeoutMs } : {}),
    metadata: input.metadata ?? {},
    audit: [deps.buildAudit('created', 'approval-broker', 'service')],
  };
  const pendingDecision = new Promise<PermissionPromptDecision>((resolve) => {
    const timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
        void deps.expire(approval.id, `timed out after ${input.timeoutMs}ms`).catch((error: unknown) => {
          logger.warn('Approval expiration failed', {
            approvalId: approval.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, input.timeoutMs)
      : undefined;
    timer?.unref?.();
    deps.pendingResolvers.set(approval.id, { resolvers: [resolve], timer });
  });
  deps.approvals.set(approval.id, approval);
  try {
    await deps.persist();
  } catch (error) {
    const pending = deps.pendingResolvers.get(approval.id);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      deps.pendingResolvers.delete(approval.id);
    }
    deps.approvals.delete(approval.id);
    // The record is out of the map; get it out of the file too, explicitly.
    //
    // A write that failed did not necessarily leave the file untouched by
    // this record: a write queued BEHIND it captures the map when it runs,
    // and whether that capture happens before or after the delete above is a
    // question about microtask ordering, which is not a thing a payment
    // record's durability should rest on. Writing the corrected map settles
    // it. If this write fails too the store is simply unavailable, and the
    // caller is already being told that by the error below — so its own
    // failure is swallowed rather than replacing the real one.
    await deps.persist().catch(() => undefined);
    throw error;
  }
  deps.publish(approval);

  return { approval, decision: pendingDecision, coalesced: false };
}
