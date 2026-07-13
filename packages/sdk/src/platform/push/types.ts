/**
 * push/types.ts
 *
 * Shared shapes for the browser-push subscription lifecycle and delivery path.
 *
 * Custody note: a stored subscription's `endpoint` is a capability URL (anyone
 * holding it can push to that device) and its `keys` are the receiver's
 * encryption material. Neither is ever returned over the wire — read verbs
 * hand back the redacted `PublicPushSubscription` view instead. The VAPID
 * private key never appears in any shape here at all; it lives only inside the
 * secrets store (see push/vapid.ts).
 */

import type { SubscriptionKeyMaterial } from './encryption.js';

export type { SubscriptionKeyMaterial } from './encryption.js';

/** A subscription as stored on disk (contains capability URL + key material). */
export interface StoredPushSubscription {
  readonly id: string;
  /** The principal (operator identity) that registered this device. */
  readonly principalId: string;
  /**
   * Stable device identity supplied by the client (e.g. a per-install id), the
   * key the record is reconciled on. A browser whose push endpoint rotates
   * presents the SAME deviceId with a NEW endpoint, so the daemon heals the one
   * record in place instead of accumulating a stale duplicate. Absent on legacy
   * records registered before device identity existed — those still reconcile
   * on the raw endpoint.
   */
  readonly deviceId?: string | undefined;
  /** The browser Push endpoint — a capability URL, kept off the wire. */
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
  readonly createdAt: number;
  /** Timestamp of the last delivery attempt, if any. */
  readonly lastDeliveryAt?: number | undefined;
  /** Outcome of the last delivery attempt, if any. */
  readonly lastOutcome?: PushDeliveryOutcome | undefined;
  /**
   * Consecutive non-gone delivery failures since the last success. The delivery
   * path prunes a record whose failures cross the bounded-retry threshold (a
   * dead endpoint that never answers 404/410), reported as an honest `pruned`
   * receipt. Reset to 0 on any delivered outcome or a re-register.
   */
  readonly consecutiveFailures?: number | undefined;
}

/**
 * The redacted, wire-safe view of a subscription. The capability URL and key
 * material are deliberately absent; the origin + short hash are enough to
 * identify a device in a management UI without handing the capability back out.
 */
export interface PublicPushSubscription {
  readonly id: string;
  readonly principalId: string;
  /** The device identity this record is reconciled on, when known. */
  readonly deviceId?: string | undefined;
  /** The endpoint's origin only (e.g. `https://push.example`), never the full path. */
  readonly endpointOrigin: string;
  /**
   * A short, stable hash of the full endpoint. A client compares this against
   * the hash of its OWN current endpoint to detect that the daemon holds a
   * stale one (drift) and reconcile — the hash reveals drift without ever
   * handing the capability URL back out.
   */
  readonly endpointHash: string;
  readonly createdAt: number;
  readonly lastDeliveryAt?: number | undefined;
  readonly lastOutcome?: PushDeliveryOutcome | undefined;
  /** Consecutive non-gone delivery failures since the last success (0 when healthy). */
  readonly consecutiveFailures?: number | undefined;
}

/**
 * Whether a reconcile-on-open changed the daemon's record for a device.
 * - 'created'          — no record existed for this device identity; a new one was stored.
 * - 'endpoint-updated' — a record existed with a DIFFERENT endpoint (drift); it was healed in place.
 * - 'keys-updated'     — same endpoint, rotated key material refreshed in place.
 * - 'unchanged'        — the stored endpoint and keys already matched.
 */
export type PushReconcileDrift = 'created' | 'endpoint-updated' | 'keys-updated' | 'unchanged';

export type PushDeliveryOutcome = 'delivered' | 'pruned' | 'failed' | 'skipped';

/** Per-subscription result of a delivery fan-out, honest about what happened. */
export interface PushDeliveryReceipt {
  readonly subscriptionId: string;
  readonly endpointOrigin: string;
  readonly outcome: PushDeliveryOutcome;
  /** The push service's HTTP status, when a request was actually made. */
  readonly httpStatus?: number | undefined;
  /** Plain-language reason, especially for `pruned`/`failed`/`skipped`. */
  readonly detail?: string | undefined;
}

/** Message urgency, mapped straight onto the push `Urgency` header. */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

/**
 * Notification category — the `kind` discriminant the service worker switches on
 * to decide how to render a push and where its deep link goes.
 * - 'approval'    — an approval decision is waiting (deep link: approvalId).
 * - 'needs-input' — a fleet node is blocked waiting on the operator (deep link:
 *   sessionId/nodeId).
 * - 'completion'  — a tracked run reached a terminal state (deep link:
 *   sessionId/nodeId; fan-out via attachCompletionSource).
 */
export type PushNotificationCategory = 'approval' | 'needs-input' | 'completion';

/**
 * Typed structured payload carried on a push, replacing a free-form bag so the
 * category and its deep-link reference are contract-backed. All deep-link fields
 * are optional and category-specific; the service worker reads the ones its
 * `kind` implies.
 */
export interface PushNotificationData {
  readonly kind: PushNotificationCategory;
  /** Approval deep link (category 'approval'). */
  readonly approvalId?: string | undefined;
  /** Session deep link (categories 'needs-input' and 'completion'). */
  readonly sessionId?: string | undefined;
  /** Fleet-node deep link (categories 'needs-input' and 'completion'). */
  readonly nodeId?: string | undefined;
  /**
   * True on a 'needs-input' push that fired as an escalation — a block that
   * waited past its grace with no human response, delivered regardless of an
   * attached surface. Lets the service worker render it as a stronger reminder.
   */
  readonly escalated?: boolean | undefined;
}

/** The notification a caller wants delivered to the operator's devices. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Optional structured data the service worker can act on (e.g. a deep link). */
  readonly data?: PushNotificationData | undefined;
  readonly urgency?: PushUrgency | undefined;
  /** How long (seconds) the push service should retain the message if offline. */
  readonly ttlSeconds?: number | undefined;
}
