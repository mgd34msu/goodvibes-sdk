import { randomUUID } from 'node:crypto';
import { SDKErrorCodes } from '@pellux/goodvibes-errors';
import { PersistentStore } from '../state/persistent-store.js';
import type { PermissionPromptDecision, PermissionPromptRequest, PermissionRequestHandler } from '../permissions/prompt.js';
import { buildDurableRuleForDecision, matchDurableRules, type RememberTier } from '../permissions/approval-rules.js';
import type { ControlPlaneSurfaceMessage } from './types.js';
import { logger } from '../utils/logger.js';
import { isRecord } from '../utils/record-coerce.js';
import { resolveApprovalHunkSelection } from './approval-hunk-apply.js';

export type SharedApprovalStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface SharedApprovalAuditRecord {
  readonly id: string;
  readonly action: 'created' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'updated';
  readonly actor: string;
  readonly actorSurface?: string | undefined;
  readonly createdAt: number;
  readonly note?: string | undefined;
}

export interface SharedApprovalRecord {
  readonly id: string;
  readonly callId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly status: SharedApprovalStatus;
  readonly request: PermissionPromptRequest;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: number | undefined;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly decision?: PermissionPromptDecision | undefined;
  /**
   * The session an ACCEPTED ask spawned, when acceptance starts one (e.g. the
   * CI fix-session a "fix this?" offer starts). Stamped after the spawn via
   * {@link ApprovalBroker.stampFixSession} and published as a record update,
   * so the surface that accepted — attached right now — gets an in-process
   * handle to jump to the session. Never present on denied records.
   */
  readonly fixSessionId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly audit: readonly SharedApprovalAuditRecord[];
}

interface SharedApprovalStoreSnapshot extends Record<string, unknown> {
  readonly approvals: readonly SharedApprovalRecord[];
}

export interface RequestSharedApprovalInput {
  readonly request: PermissionPromptRequest;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly localPrompt?: PermissionRequestHandler | undefined;
  readonly timeoutMs?: number | undefined;
}

type ApprovalListener = (approval: SharedApprovalRecord) => void;
type ApprovalPublisher = {
  publishEvent(event: string, payload: unknown): void;
  publishSurfaceMessage(message: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): void;
};

function sortApprovals(records: Iterable<SharedApprovalRecord>): SharedApprovalRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Maximum number of terminal (resolved) approval records retained in memory and
 * on disk. Mirrors ChannelPolicyManager's MAX_AUDIT_RECORDS so a long-running
 * control-plane daemon does not grow the snapshot without bound. Pending and
 * claimed approvals are never counted or evicted — they have a live awaited
 * promise + resolver and must survive until resolved.
 */
const MAX_APPROVAL_RECORDS = 500;
const TERMINAL_APPROVAL_STATUSES = new Set<SharedApprovalStatus>(['approved', 'denied', 'cancelled', 'expired']);

const APPROVAL_STATUSES = new Set<SharedApprovalStatus>(['pending', 'claimed', 'approved', 'denied', 'cancelled', 'expired']);
const APPROVAL_AUDIT_ACTIONS = new Set<SharedApprovalAuditRecord['action']>([
  'created',
  'claimed',
  'approved',
  'denied',
  'cancelled',
  'expired',
  'updated',
]);
const PERMISSION_CATEGORIES = new Set(['read', 'write', 'execute', 'delegate']);
const PERMISSION_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidApprovalSnapshot(): never {
  throw new Error('Shared approval store snapshot is invalid.');
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidApprovalSnapshot();
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidApprovalSnapshot();
}

function validatePermissionPromptRequestSnapshot(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  const category = value['category'];
  if (
    typeof value['callId'] !== 'string'
    || typeof value['tool'] !== 'string'
    || !isRecord(value['args'])
    || typeof category !== 'string'
    || !PERMISSION_CATEGORIES.has(category)
  ) {
    throwInvalidApprovalSnapshot();
  }
  const analysis = value['analysis'];
  if (!isRecord(analysis)) throwInvalidApprovalSnapshot();
  const riskLevel = analysis['riskLevel'];
  if (
    typeof analysis['classification'] !== 'string'
    || typeof riskLevel !== 'string'
    || !PERMISSION_RISK_LEVELS.has(riskLevel)
    || typeof analysis['summary'] !== 'string'
    || !isStringArray(analysis['reasons'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validateOptionalString(value['workingDirectory']);
}

function validateApprovalAuditRecord(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  if (
    typeof value['id'] !== 'string'
    || typeof value['action'] !== 'string'
    || !APPROVAL_AUDIT_ACTIONS.has(value['action'] as SharedApprovalAuditRecord['action'])
    || typeof value['actor'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validateOptionalString(value['actorSurface']);
  validateOptionalString(value['note']);
}

function validateApprovalRecord(value: unknown): void {
  if (!isRecord(value)) throwInvalidApprovalSnapshot();
  if (
    typeof value['id'] !== 'string'
    || typeof value['callId'] !== 'string'
    || typeof value['status'] !== 'string'
    || !APPROVAL_STATUSES.has(value['status'] as SharedApprovalStatus)
    || !isFiniteNumber(value['createdAt'])
    || !isFiniteNumber(value['updatedAt'])
    || !isRecord(value['metadata'])
    || !Array.isArray(value['audit'])
  ) {
    throwInvalidApprovalSnapshot();
  }
  validatePermissionPromptRequestSnapshot(value['request']);
  validateOptionalString(value['sessionId']);
  validateOptionalString(value['routeId']);
  validateOptionalString(value['claimedBy']);
  validateOptionalNumber(value['claimedAt']);
  validateOptionalNumber(value['resolvedAt']);
  validateOptionalString(value['resolvedBy']);
  if (value['decision'] !== undefined) {
    const decision = value['decision'];
    if (!isRecord(decision) || typeof decision['approved'] !== 'boolean') {
      throwInvalidApprovalSnapshot();
    }
    if (decision['remember'] !== undefined && typeof decision['remember'] !== 'boolean') {
      throwInvalidApprovalSnapshot();
    }
  }
  for (const audit of value['audit']) validateApprovalAuditRecord(audit);
}

function validateApprovalSnapshot(snapshot: SharedApprovalStoreSnapshot | null): SharedApprovalStoreSnapshot | null {
  if (!snapshot) return null;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.approvals)) throwInvalidApprovalSnapshot();
  for (const approval of snapshot.approvals) validateApprovalRecord(approval);
  return snapshot;
}

function buildAudit(action: SharedApprovalAuditRecord['action'], actor: string, actorSurface?: string, note?: string): SharedApprovalAuditRecord {
  return {
    id: `apra-${randomUUID().slice(0, 8)}`,
    action,
    actor,
    actorSurface,
    createdAt: Date.now(),
    ...(note ? { note } : {}),
  };
}

/** Deterministic JSON for coalescing — object keys sorted at every level. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identical concurrent asks coalesce on this key: one prompt answers all. */
function approvalCoalesceKey(sessionId: string | undefined, tool: string, args: Record<string, unknown>): string {
  return `${sessionId ?? ''}|${tool}|${stableJson(args)}`;
}

export class ApprovalBroker {
  private readonly store: PersistentStore<SharedApprovalStoreSnapshot>;
  private readonly approvals = new Map<string, SharedApprovalRecord>();
  private readonly pendingResolvers = new Map<string, {
    resolvers: Array<(decision: PermissionPromptDecision) => void>;
    timer?: ReturnType<typeof setTimeout> | undefined;
  }>();
  private readonly listeners = new Set<ApprovalListener>();
  private publisher: ApprovalPublisher | null = null;
  private loaded = false;

  constructor(
    options: {
      readonly store?: PersistentStore<SharedApprovalStoreSnapshot> | undefined;
      readonly storePath?: string | undefined;
    },
  ) {
    if (!options.store && !options.storePath) {
      throw new Error('ApprovalBroker requires an explicit store or storePath.');
    }
    const storePath = options.storePath;
    this.store = options.store ?? new PersistentStore<SharedApprovalStoreSnapshot>(storePath as string);
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPublisher(publisher: ApprovalPublisher | null): void {
    this.publisher = publisher;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    const snapshot = validateApprovalSnapshot(await this.store.load());
    this.approvals.clear();
    for (const approval of snapshot?.approvals ?? []) {
      this.approvals.set(approval.id, approval);
    }
    this.pruneTerminalApprovals();
    this.loaded = true;
  }

  listApprovals(limit = 100): SharedApprovalRecord[] {
    return sortApprovals(this.approvals.values()).slice(0, Math.max(1, limit));
  }

  getApproval(approvalId: string): SharedApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  async requestApproval(input: RequestSharedApprovalInput): Promise<PermissionPromptDecision> {
    await this.start();
    const now = Date.now();

    // Duplicate in-flight asks coalesce on (session, tool, args): the second
    // identical ask attaches to the first's pending record — ONE prompt, and
    // one decision resolves both. No second record, no second local prompt.
    const coalesceKey = approvalCoalesceKey(input.sessionId, input.request.tool, input.request.args);
    for (const existing of this.approvals.values()) {
      if ((existing.status === 'pending' || existing.status === 'claimed')
        && approvalCoalesceKey(existing.sessionId, existing.request.tool, existing.request.args) === coalesceKey) {
        const pending = this.pendingResolvers.get(existing.id);
        if (pending) {
          return new Promise<PermissionPromptDecision>((resolve) => {
            pending.resolvers.push(resolve);
          });
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
      metadata: input.metadata ?? {},
      audit: [buildAudit('created', 'approval-broker', 'service')],
    };
    const pendingDecision = new Promise<PermissionPromptDecision>((resolve) => {
      const timer = input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            void this.expireApproval(approval.id, `timed out after ${input.timeoutMs}ms`).catch((error: unknown) => {
              logger.warn('Approval expiration failed', {
                approvalId: approval.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }, input.timeoutMs)
        : undefined;
      timer?.unref?.();
      this.pendingResolvers.set(approval.id, { resolvers: [resolve], timer });
    });
    this.approvals.set(approval.id, approval);
    try {
      await this.persist();
    } catch (error) {
      const pending = this.pendingResolvers.get(approval.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingResolvers.delete(approval.id);
      }
      this.approvals.delete(approval.id);
      throw error;
    }
    this.publish(approval);

    if (input.localPrompt) {
      void input.localPrompt(input.request)
        .then((decision) => this.resolveApproval(approval.id, {
          approved: decision.approved,
          remember: decision.remember,
          rememberTier: decision.rememberTier,
          reason: decision.reason,
          modifiedArgs: decision.modifiedArgs,
          actor: 'tui-local',
          actorSurface: 'tui',
        }))
        .catch((error) => logger.warn('Local approval prompt failed', {
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        }));
    }

    return pendingDecision;
  }

  async claimApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return approval;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'claimed',
      claimedBy: actor,
      claimedAt: Date.now(),
      updatedAt: Date.now(),
      audit: [...approval.audit, buildAudit('claimed', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  /**
   * Stamp the session an ACCEPTED ask spawned (e.g. the CI fix-session an
   * accepted "fix this?" offer started) onto the resolved approval record for
   * `callId`, and publish the update so already-attached subscribers see the
   * record change live. This is deliberately the broker seam, not the receipts
   * queue: receipts deliver at the NEXT attach, but the accepting surface is
   * attached right now and needs an in-process handle to open the session.
   * Returns the updated record, or null when no APPROVED record with that
   * callId exists — a denied offer is never stamped.
   */
  async stampFixSession(callId: string, fixSessionId: string): Promise<SharedApprovalRecord | null> {
    await this.start();
    const existing = [...this.approvals.values()].find((approval) => approval.callId === callId);
    if (!existing || existing.status !== 'approved') return null;
    if (existing.fixSessionId === fixSessionId) return existing;
    const updated: SharedApprovalRecord = { ...existing, fixSessionId, updatedAt: Date.now() };
    this.approvals.set(updated.id, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember?: boolean | undefined;
      readonly modifiedArgs?: Record<string, unknown> | undefined;
      /**
       * Optional per-hunk selection (edit-tool approvals only). When present and
       * the approval is being APPROVED, the broker computes the modified args
       * server-side from THIS approval's own `request.args.edits`, so every
       * surface (TUI, webui) produces identical results. It supersedes any
       * `modifiedArgs` passed by the caller. Omitting it is the back-compat
       * whole-request approve-all path. An out-of-range index or a non-edit
       * approval throws a VALIDATION_FAILED (400) error, mirroring the closed-
       * session guard's honest-4xx shape.
       */
      readonly selectedHunks?: readonly number[] | undefined;
      /**
       * How far this decision reaches (see PermissionPromptDecision). A
       * generalizing tier also SWEEPS queued asks the remembered decision
       * covers — one answer resolves them all.
       */
      readonly rememberTier?: RememberTier | undefined;
      /** Optional user free-text; on deny it rides the structured result. */
      readonly reason?: string | undefined;
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
    },
  ): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status === 'approved' || approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      return approval;
    }
    // Per-hunk selection is only meaningful on approve; a deny is always a
    // whole-request rejection. Compute the modified args from the pending
    // request's OWN edits so the result is identical for every calling surface.
    let modifiedArgs = input.modifiedArgs;
    if (input.selectedHunks !== undefined && input.approved) {
      const resolution = resolveApprovalHunkSelection(approval.request, input.selectedHunks);
      if (!resolution.ok) {
        throw Object.assign(new Error(resolution.reason), {
          code: SDKErrorCodes.VALIDATION_FAILED,
          status: 400,
        });
      }
      modifiedArgs = resolution.modifiedArgs;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: input.approved ? 'approved' : 'denied',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: input.actor,
      decision: {
        approved: input.approved,
        ...(input.remember !== undefined ? { remember: input.remember } : {}),
        ...(input.rememberTier !== undefined ? { rememberTier: input.rememberTier } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
      },
      audit: [
        ...approval.audit,
        buildAudit(input.approved ? 'approved' : 'denied', input.actor, input.actorSurface, input.note),
      ],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);

    this.resolvePending(approvalId, updated.decision ?? { approved: input.approved });

    // A generalizing remember tier answers more than this one ask: sweep every
    // queued pending ask the remembered decision covers (same rule match) and
    // resolve it with the same verdict. modifiedArgs are call-specific and
    // never propagate to swept asks.
    if (input.rememberTier && input.rememberTier !== 'session') {
      const rule = buildDurableRuleForDecision({
        toolName: approval.request.tool,
        args: approval.request.args,
        tier: input.rememberTier,
        effect: input.approved ? 'allow' : 'deny',
      });
      if (rule) {
        for (const candidate of [...this.approvals.values()]) {
          if (candidate.id === approvalId) continue;
          if (candidate.status !== 'pending' && candidate.status !== 'claimed') continue;
          const covered = matchDurableRules([rule], candidate.request.tool, candidate.request.args, {
            projectRoot: candidate.request.workingDirectory,
          });
          if (!covered) continue;
          const swept: SharedApprovalRecord = {
            ...candidate,
            status: input.approved ? 'approved' : 'denied',
            updatedAt: Date.now(),
            resolvedAt: Date.now(),
            resolvedBy: input.actor,
            decision: {
              approved: input.approved,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
            },
            audit: [
              ...candidate.audit,
              buildAudit(input.approved ? 'approved' : 'denied', input.actor, input.actorSurface,
                `covered by remembered ${input.rememberTier} decision on ${approvalId}`),
            ],
          };
          this.approvals.set(candidate.id, swept);
          this.publish(swept);
          this.resolvePending(candidate.id, swept.decision ?? { approved: input.approved });
        }
        await this.persist();
      }
    }
    return updated;
  }

  /** Resolve every waiter attached to an approval (coalesced asks share one record). */
  private resolvePending(approvalId: string, decision: PermissionPromptDecision): void {
    const pending = this.pendingResolvers.get(approvalId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    for (const resolve of pending.resolvers) resolve(decision);
    this.pendingResolvers.delete(approvalId);
  }

  async recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string | undefined;
      readonly note?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    const updated: SharedApprovalRecord = {
      ...approval,
      updatedAt: Date.now(),
      metadata: {
        ...approval.metadata,
        ...(input.metadata ?? {}),
      },
      audit: [...approval.audit, buildAudit('updated', input.actor, input.actorSurface, input.note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async cancelApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status === 'approved' || approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      return approval;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'cancelled',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: actor,
      decision: { approved: false, remember: false },
      audit: [...approval.audit, buildAudit('cancelled', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    this.resolvePending(approvalId, { approved: false, remember: false });
    return updated;
  }

  private async expireApproval(approvalId: string, note: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval) return;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'expired',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: 'approval-broker',
      decision: { approved: false, remember: false },
      audit: [...approval.audit, buildAudit('expired', 'approval-broker', 'service', note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    this.resolvePending(approvalId, { approved: false, remember: false });
  }

  /**
   * Drop the oldest terminal (approved/denied/cancelled/expired) approvals once
   * they exceed MAX_APPROVAL_RECORDS, bounding both the in-memory Map and the
   * persisted snapshot. Pending/claimed approvals are excluded and never evicted,
   * so their awaiting callers and pendingResolvers are never orphaned.
   */
  private pruneTerminalApprovals(): void {
    const terminal: SharedApprovalRecord[] = [];
    for (const record of this.approvals.values()) {
      if (TERMINAL_APPROVAL_STATUSES.has(record.status)) terminal.push(record);
    }
    if (terminal.length <= MAX_APPROVAL_RECORDS) return;
    terminal.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    for (const record of terminal.slice(MAX_APPROVAL_RECORDS)) {
      this.approvals.delete(record.id);
    }
  }

  private async persist(): Promise<void> {
    this.pruneTerminalApprovals();
    await this.store.persist({
      approvals: sortApprovals(this.approvals.values()),
    });
  }

  private publish(approval: SharedApprovalRecord): void {
    this.publisher?.publishEvent('approval-update', {
      approval,
      createdAt: Date.now(),
    });
    this.publisher?.publishSurfaceMessage({
      surface: 'web',
      title: approval.status === 'pending' || approval.status === 'claimed' ? 'Approval required' : 'Approval resolved',
      body: `${approval.request.tool}: ${approval.request.analysis.summary}`,
      level: approval.status === 'approved'
        ? 'success'
        : approval.status === 'denied' || approval.status === 'expired'
          ? 'warn'
          : 'info',
      metadata: {
        approvalId: approval.id,
        status: approval.status,
        callId: approval.callId,
        sessionId: approval.sessionId,
        routeId: approval.routeId,
      },
    });
    for (const listener of this.listeners) {
      try {
        listener(approval);
      } catch {
        // Listener failures do not block approval creation.
      }
    }
  }
}
