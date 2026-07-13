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
  SubscriptionKeyMaterial,
} from './types.js';

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
  readonly reason?: 'approval' | 'input' | undefined;
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
}

export interface SubscribeInput {
  readonly principalId: string;
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
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
  private readonly isCategoryEnabled: (category: PushNotificationCategory) => boolean;

  constructor(deps: PushServiceDeps) {
    this.vapid = deps.vapid;
    this.store = deps.store;
    this.transport = deps.transport;
    this.isCategoryEnabled = deps.isCategoryEnabled ?? ((): boolean => true);
  }

  /** The public VAPID key clients subscribe with. */
  getPublicKey(): Promise<string> {
    return this.vapid.getPublicKey();
  }

  async subscribe(input: SubscribeInput): Promise<PublicPushSubscription> {
    const record = await this.store.register(input);
    return toPublicSubscription(record);
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
   * notification carrying the session/node deep-link reference. The push is
   * SUPPRESSED when an operator surface is already attached to that node's
   * session (presence) — someone is looking, so a device push would be noise.
   * A node's notice is de-duped by node id until it unblocks or finishes, so a
   * later re-block re-notifies. Returns an unsubscribe handle.
   */
  attachFleetNeedsInputSource(source: FleetNoticeSource, presence?: NeedsInputPresence): () => void {
    return source.subscribe((notice) => {
      if (notice.type === 'FLEET_NODE_UNBLOCKED' || notice.type === 'FLEET_NODE_FINISHED') {
        this.notifiedNeedsInput.delete(notice.nodeId);
        return;
      }
      if (notice.type !== 'FLEET_NODE_BLOCKED_ON_USER') return;
      if (!this.isCategoryEnabled('needs-input')) return;
      if (this.notifiedNeedsInput.has(notice.nodeId)) return;
      // Presence suppression: an operator is actively attached to this session,
      // so they will see the block in-surface — do not also push to a device.
      // Not marked notified, so if they detach and it re-blocks we still notify.
      if (notice.sessionId && presence?.isAttached(notice.sessionId)) return;
      this.notifiedNeedsInput.add(notice.nodeId);
      const label = notice.label ?? 'A background task';
      const reason = notice.reason === 'approval' ? 'needs your approval' : 'needs your input';
      void this.deliver({
        title: 'Input needed',
        body: `${label} ${reason}.`,
        data: {
          kind: 'needs-input',
          ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
          nodeId: notice.nodeId,
        },
        urgency: 'high',
      }).catch((error) => {
        logger.warn('PushService: needs-input fan-out failed', {
          nodeId: notice.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
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
