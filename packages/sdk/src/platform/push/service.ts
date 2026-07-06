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

export interface PushServiceDeps {
  readonly vapid: VapidManager;
  readonly store: PushSubscriptionStore;
  /** Overridable delivery transport; production uses the built-in fetch. */
  readonly transport?: PushTransport | undefined;
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

  constructor(deps: PushServiceDeps) {
    this.vapid = deps.vapid;
    this.store = deps.store;
    this.transport = deps.transport;
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
}
