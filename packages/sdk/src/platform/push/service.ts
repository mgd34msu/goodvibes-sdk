/**
 * push/service.ts
 *
 * PushService — the seam the gateway verbs and the daemon event sources both
 * talk to. It owns the subscription store, the VAPID key custody, and the
 * delivery path, and it turns a real daemon event (an approval that needs a
 * decision) into a fan-out of encrypted pushes.
 *
 * Honest-degrade posture, end to end:
 *  - No subscriptions -> `deliver()` returns an empty receipt list; nothing is
 *    faked as sent.
 *  - A subscription whose endpoint is gone (404/410) is pruned by the delivery
 *    path and reported as `pruned`.
 *  - VAPID keys are minted lazily on first real need; a daemon that never uses
 *    push never generates or stores a key.
 */

import { logger } from '../utils/logger.js';
import { deliverToAll, deliverToSubscription, type PushTransport } from './delivery.js';
import { PushSubscriptionStore, toPublicSubscription } from './subscription-store.js';
import { VapidManager } from './vapid.js';
import type {
  PublicPushSubscription,
  PushDeliveryReceipt,
  PushMessage,
  PushNotificationCategory,
  PushReconcileDrift,
  SubscriptionKeyMaterial,
} from './types.js';

/** Render an elapsed millisecond span as a short human phrase for a push body. */
function formatWaited(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes === 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** The slice of the approval broker the push delivery source subscribes to. */
export interface ApprovalSource {
  subscribe(listener: (approval: ApprovalNotice) => void): () => void;
}

/** The minimum an approval record needs to expose to become a push. */
export interface ApprovalNotice {
  readonly id: string;
  readonly status: string;
  readonly request?: { readonly tool?: string; readonly analysis?: { readonly summary?: string } } | undefined;
}

/**
 * A fleet lifecycle notice — the structural slice of a FleetEvent payload the
 * needs-input push source reacts to. Kept structural (not an import of the fleet
 * event union) so the push module stays decoupled from the runtime bus; the
 * composition root adapts `bus.onDomain('fleet', …)` into this source.
 */
export interface FleetNotice {
  readonly type: string;
  readonly nodeId: string;
  readonly label?: string | undefined;
  readonly reason?: 'approval' | 'input' | 'pick' | 'conflict' | undefined;
  readonly sessionId?: string | undefined;
  /** Node kind (agent, chain, workstream, …) — the completion source's scope filter. */
  readonly kind?: string | undefined;
  /** Terminal state on a FLEET_NODE_FINISHED notice (done/failed/killed). */
  readonly state?: string | undefined;
}

/** The slice of a fleet event stream the needs-input push source subscribes to. */
export interface FleetNoticeSource {
  subscribe(listener: (notice: FleetNotice) => void): () => void;
}

/** Presence check: is an operator surface currently attached to this session? */
export interface NeedsInputPresence {
  isAttached(sessionId: string): boolean;
}

/**
 * How long a block may wait on a HUMAN before a device push is sent regardless
 * of attachment, and the bounded reminder cadence after that first escalation.
 * A process merely being attached (heartbeat / an open TUI) is presence, not a
 * response — only a real interaction with the ask (which clears the block:
 * FLEET_NODE_UNBLOCKED / FLEET_NODE_FINISHED) counts as a response and cancels
 * the escalation.
 */
export interface PushEscalationConfig {
  /** Grace before an unanswered block escalates to a device push (honest default ~5m). */
  readonly blockedGraceMs: number;
  /** Interval between bounded follow-up reminders after the first escalation. */
  readonly followUpIntervalMs: number;
  /** How many follow-up reminders may fire after the first escalation (0 = escalate once). */
  readonly maxFollowUps: number;
}

/** Honest defaults: escalate after 5 minutes, then at most two 5-minute reminders. */
export const DEFAULT_PUSH_ESCALATION: PushEscalationConfig = {
  blockedGraceMs: 5 * 60 * 1000,
  followUpIntervalMs: 5 * 60 * 1000,
  maxFollowUps: 2,
};

/**
 * A one-shot timer seam so escalation is deterministic under test. `schedule`
 * returns a cancel handle; the default uses `setTimeout` with `unref()` so an
 * armed escalation never keeps the daemon process alive on its own.
 */
export interface EscalationScheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

function defaultEscalationScheduler(): EscalationScheduler {
  return {
    schedule(fn, delayMs) {
      const handle = setTimeout(fn, delayMs);
      // Node/Bun: don't hold the event loop open for a pending reminder.
      (handle as unknown as { unref?: () => void }).unref?.();
      return () => clearTimeout(handle);
    },
  };
}

/** Internal record of a block that is being tracked for escalation. */
interface TrackedBlock {
  readonly nodeId: string;
  readonly sessionId?: string | undefined;
  readonly label?: string | undefined;
  readonly reason?: 'approval' | 'input' | 'pick' | 'conflict' | undefined;
  readonly blockedAt: number;
  /** True once the escalation push (regardless of attachment) has fired. */
  escalated: boolean;
  /** Bounded follow-up reminders already sent after the escalation. */
  followUpsSent: number;
  /** Cancels the currently-armed timer, if any. */
  cancel: () => void;
}

export interface PushServiceDeps {
  readonly vapid: VapidManager;
  readonly store: PushSubscriptionStore;
  /** Overridable delivery transport; production uses the built-in fetch. */
  readonly transport?: PushTransport | undefined;
  /**
   * Per-class silencing toggle, read LIVE at each event (the composition root
   * wires it to the notifications.push* config keys). Absent ⇒ every class is
   * on — the toggles exist to turn classes OFF, never as a prerequisite for
   * the fan-out to work.
   */
  readonly isCategoryEnabled?: ((category: PushNotificationCategory) => boolean) | undefined;
  /**
   * Escalation policy for blocked-too-long asks, read LIVE at each block (the
   * composition root wires it to the notifications.blockedEscalation* keys).
   * Absent ⇒ {@link DEFAULT_PUSH_ESCALATION}.
   */
  readonly escalation?: (() => PushEscalationConfig) | undefined;
  /** Timer seam for escalation; absent ⇒ real `setTimeout`-based scheduler. */
  readonly scheduler?: EscalationScheduler | undefined;
  /** Clock seam so "how long has it waited" is deterministic under test. */
  readonly now?: (() => number) | undefined;
}

export interface SubscribeInput {
  readonly principalId: string;
  /** Stable device identity; when present the record reconciles on it, not the endpoint. */
  readonly deviceId?: string | undefined;
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
}

/** The result a reconcile-on-open hands back: the redacted record plus what drifted. */
export interface ReconcileOutput {
  readonly subscription: PublicPushSubscription;
  readonly drift: PushReconcileDrift;
}

export class PushService {
  private readonly vapid: VapidManager;
  private readonly store: PushSubscriptionStore;
  private readonly transport?: PushTransport | undefined;
  /** Approval ids already pushed, so re-publishes (claim/approve) don't re-notify. */
  private readonly notifiedApprovals = new Set<string>();
  /** Fleet node ids already pushed as needs-input, cleared when they unblock/finish. */
  private readonly notifiedNeedsInput = new Set<string>();
  /** Fleet node ids already pushed as completed — a terminal state fires once. */
  private readonly notifiedCompletions = new Set<string>();
  /** Blocks under escalation tracking, keyed by node id; cleared on response. */
  private readonly trackedBlocks = new Map<string, TrackedBlock>();
  private readonly isCategoryEnabled: (category: PushNotificationCategory) => boolean;
  private readonly escalationConfig: () => PushEscalationConfig;
  private readonly scheduler: EscalationScheduler;
  private readonly now: () => number;

  constructor(deps: PushServiceDeps) {
    this.vapid = deps.vapid;
    this.store = deps.store;
    this.transport = deps.transport;
    this.isCategoryEnabled = deps.isCategoryEnabled ?? ((): boolean => true);
    this.escalationConfig = deps.escalation ?? ((): PushEscalationConfig => DEFAULT_PUSH_ESCALATION);
    this.scheduler = deps.scheduler ?? defaultEscalationScheduler();
    this.now = deps.now ?? Date.now;
  }

  /** The public VAPID key clients subscribe with. */
  getPublicKey(): Promise<string> {
    return this.vapid.getPublicKey();
  }

  async subscribe(input: SubscribeInput): Promise<PublicPushSubscription> {
    const record = await this.store.register(input);
    return toPublicSubscription(record);
  }

  /**
   * Reconcile-on-open: store the client's CURRENT endpoint/keys for its device
   * identity, healing a stale record in place, and report what drifted so the
   * client learns whether the daemon had held an out-of-date endpoint.
   */
  async reconcile(input: SubscribeInput): Promise<ReconcileOutput> {
    const { record, drift } = await this.store.reconcile(input);
    return { subscription: toPublicSubscription(record), drift };
  }

  listSubscriptions(principalId: string): Promise<PublicPushSubscription[]> {
    return this.store.listPublic(principalId);
  }

  /** Delete a subscription for a principal. False when the id was already absent. */
  unsubscribe(id: string, principalId: string): Promise<boolean> {
    return this.store.remove(id, principalId);
  }

  /**
   * Send a test push to one of the principal's subscriptions and return the
   * honest receipt (delivered / pruned / failed). Returns null when the id is
   * not a subscription owned by this principal, so the verb can 404.
   */
  async verify(id: string, principalId: string): Promise<PushDeliveryReceipt | null> {
    const record = await this.store.get(id);
    if (!record || record.principalId !== principalId) return null;
    return deliverToSubscription(
      record,
      {
        title: 'GoodVibes test notification',
        body: 'Browser push is wired up and working.',
        urgency: 'normal',
      },
      { vapid: this.vapid, store: this.store, transport: this.transport },
    );
  }

  /** Fan a message out to every stored subscription. */
  deliver(message: PushMessage): Promise<PushDeliveryReceipt[]> {
    return deliverToAll(message, { vapid: this.vapid, store: this.store, transport: this.transport });
  }

  /**
   * Wire a real event source: when an approval is created (status `pending`),
   * push it to every registered device. Later re-publishes of the same approval
   * (claimed/approved/denied) do not re-notify. Returns an unsubscribe handle.
   */
  attachApprovalSource(source: ApprovalSource): () => void {
    return source.subscribe((approval) => {
      if (approval.status !== 'pending') return;
      if (!this.isCategoryEnabled('approval')) return;
      if (this.notifiedApprovals.has(approval.id)) return;
      this.notifiedApprovals.add(approval.id);
      const tool = approval.request?.tool ?? 'a tool';
      const summary = approval.request?.analysis?.summary ?? 'A pending action needs your decision.';
      // Fire-and-forget: an approval must never block on a push, and a delivery
      // failure is already captured as an honest receipt/outcome inside deliver().
      void this.deliver({
        title: 'Approval required',
        body: `${tool}: ${summary}`,
        data: { kind: 'approval', approvalId: approval.id },
        urgency: 'high',
      }).catch((error) => {
        logger.warn('PushService: approval fan-out failed', {
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /**
   * Wire the fleet needs-input source: when a fleet node becomes blocked on the
   * operator (a FLEET_NODE_BLOCKED_ON_USER notice), push a 'needs-input'
   * notification carrying the session/node deep-link reference.
   *
   * The FIRST push is SUPPRESSED when an operator surface is already attached to
   * that node's session (presence) — someone is looking, so an immediate device
   * push would be noise. But presence is process-liveness, not a human answer:
   * an attached-but-idle desk (an open TUI, a heartbeat) never counts as a
   * response. So every block is also TRACKED, and if it is still outstanding
   * after the configured grace (honest default ~5m) with no HUMAN response, an
   * escalation push fires REGARDLESS of attachment, followed by a bounded,
   * configurable set of reminders. A real interaction with the ask clears the
   * block (FLEET_NODE_UNBLOCKED / FLEET_NODE_FINISHED), which cancels the
   * escalation — an answered ask never escalates.
   *
   * A node's notice is de-duped by node id until it unblocks or finishes, so a
   * later re-block re-notifies. Returns an unsubscribe handle.
   */
  attachFleetNeedsInputSource(source: FleetNoticeSource, presence?: NeedsInputPresence): () => void {
    return source.subscribe((notice) => {
      if (notice.type === 'FLEET_NODE_UNBLOCKED' || notice.type === 'FLEET_NODE_FINISHED') {
        // A cleared block is the human-response (or terminal) signal: stop any
        // armed escalation and forget the ask so a genuine re-block re-notifies.
        this.notifiedNeedsInput.delete(notice.nodeId);
        this.trackedBlocks.get(notice.nodeId)?.cancel();
        this.trackedBlocks.delete(notice.nodeId);
        return;
      }
      if (notice.type !== 'FLEET_NODE_BLOCKED_ON_USER') return;
      if (!this.isCategoryEnabled('needs-input')) return;
      if (this.notifiedNeedsInput.has(notice.nodeId) || this.trackedBlocks.has(notice.nodeId)) return;

      const attached = Boolean(notice.sessionId && presence?.isAttached(notice.sessionId));
      // Presence suppression applies only to the IMMEDIATE push. Not marked
      // notified when suppressed, so a detach-then-re-block still notifies.
      if (!attached) {
        this.notifiedNeedsInput.add(notice.nodeId);
        this.sendNeedsInput(notice, false);
      }

      // Track the block for escalation whether or not the immediate push fired:
      // an unattended block that goes unseen still earns its bounded reminders,
      // and an attended one escalates past presence once the grace elapses.
      const block: TrackedBlock = {
        nodeId: notice.nodeId,
        sessionId: notice.sessionId,
        label: notice.label,
        reason: notice.reason,
        blockedAt: this.now(),
        escalated: false,
        followUpsSent: 0,
        cancel: () => {},
      };
      this.trackedBlocks.set(notice.nodeId, block);
      this.armEscalation(block, presence);
    });
  }

  /** Arm the next escalation/reminder timer for a tracked block. */
  private armEscalation(block: TrackedBlock, presence?: NeedsInputPresence): void {
    const config = this.escalationConfig();
    const delayMs = block.escalated ? config.followUpIntervalMs : config.blockedGraceMs;
    block.cancel = this.scheduler.schedule(() => {
      // Still tracked? A response would have deleted it and cancelled us.
      if (this.trackedBlocks.get(block.nodeId) !== block) return;
      if (!this.isCategoryEnabled('needs-input')) {
        // Class was silenced after arming: stop escalating, keep no timer.
        this.trackedBlocks.delete(block.nodeId);
        return;
      }
      const waitedMs = this.now() - block.blockedAt;
      this.sendNeedsInput(
        { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: block.nodeId, label: block.label, reason: block.reason, sessionId: block.sessionId },
        true,
        waitedMs,
      );
      this.notifiedNeedsInput.add(block.nodeId);
      if (!block.escalated) {
        block.escalated = true;
      } else {
        block.followUpsSent += 1;
      }
      if (block.followUpsSent >= config.maxFollowUps) {
        // Bounded: the escalation plus its allowed reminders are spent.
        this.trackedBlocks.delete(block.nodeId);
        return;
      }
      this.armEscalation(block, presence);
    }, delayMs);
  }

  /** Compose and fire one needs-input push (immediate or escalated). */
  private sendNeedsInput(notice: FleetNotice, escalated: boolean, waitedMs?: number): void {
    const label = notice.label ?? 'A background task';
    // One waiting-on-human class, four honest phrasings — a ready best-of-N
    // pick and a merge conflict push through the SAME source as approvals.
    const reason = notice.reason === 'approval'
      ? 'needs your approval'
      : notice.reason === 'pick'
        ? 'has a best-of-N pick ready for you'
        : notice.reason === 'conflict'
          ? 'has a merge conflict waiting on you'
          : 'needs your input';
    const body = escalated
      ? `${label} has been waiting ${formatWaited(waitedMs ?? 0)} and still ${reason}.`
      : `${label} ${reason}.`;
    void this.deliver({
      title: escalated ? 'Still waiting on you' : 'Input needed',
      body,
      data: {
        kind: 'needs-input',
        ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
        nodeId: notice.nodeId,
        ...(escalated ? { escalated: true } : {}),
      },
      urgency: 'high',
    }).catch((error) => {
      logger.warn('PushService: needs-input fan-out failed', {
        nodeId: notice.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Wire the completion source: a tracked run reaching a terminal state (a
   * FLEET_NODE_FINISHED notice) pushes a 'completion' notification to every
   * paired target — by DEFAULT, with zero configuration; the
   * notifications.pushCompletion toggle exists only to silence the class.
   * Scoped to run-level kinds (agent/chain/workstream/workflow/automation-job)
   * so a chain finishing does not also fan out one push per subtask/work-item
   * child; the FINISHED event itself fires only on an OBSERVED terminal
   * transition (emit-bridge honesty), so nothing is inferred. One push per
   * node id. Returns an unsubscribe handle.
   */
  attachCompletionSource(source: FleetNoticeSource): () => void {
    const RUN_KINDS = new Set(['agent', 'chain', 'workstream', 'workflow', 'automation-job']);
    return source.subscribe((notice) => {
      if (notice.type !== 'FLEET_NODE_FINISHED') return;
      if (notice.kind !== undefined && !RUN_KINDS.has(notice.kind)) return;
      if (!this.isCategoryEnabled('completion')) return;
      if (this.notifiedCompletions.has(notice.nodeId)) return;
      this.notifiedCompletions.add(notice.nodeId);
      const label = notice.label ?? 'A tracked run';
      const outcome = notice.state === 'done'
        ? 'completed'
        : notice.state === 'failed'
          ? 'failed'
          : notice.state === 'killed'
            ? 'was killed'
            : 'finished';
      void this.deliver({
        title: notice.state === 'done' ? 'Run completed' : 'Run finished',
        body: `${label} ${outcome}.`,
        data: {
          kind: 'completion',
          ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
          nodeId: notice.nodeId,
        },
        urgency: 'normal',
      }).catch((error) => {
        logger.warn('PushService: completion fan-out failed', {
          nodeId: notice.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }
}
