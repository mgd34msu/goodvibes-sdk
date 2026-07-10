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
  /** The browser Push endpoint — a capability URL, kept off the wire. */
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
  readonly createdAt: number;
  /** Timestamp of the last delivery attempt, if any. */
  readonly lastDeliveryAt?: number | undefined;
  /** Outcome of the last delivery attempt, if any. */
  readonly lastOutcome?: PushDeliveryOutcome | undefined;
}

/**
 * The redacted, wire-safe view of a subscription. The capability URL and key
 * material are deliberately absent; the origin + short hash are enough to
 * identify a device in a management UI without handing the capability back out.
 */
export interface PublicPushSubscription {
  readonly id: string;
  readonly principalId: string;
  /** The endpoint's origin only (e.g. `https://push.example`), never the full path. */
  readonly endpointOrigin: string;
  /** A short, stable hash of the full endpoint, for de-duplication in a UI. */
  readonly endpointHash: string;
  readonly createdAt: number;
  readonly lastDeliveryAt?: number | undefined;
  readonly lastOutcome?: PushDeliveryOutcome | undefined;
}

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
 * - 'completion'  — a tracked run finished (reserved; no fan-out wired yet).
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
  /** Session deep link (category 'needs-input'). */
  readonly sessionId?: string | undefined;
  /** Fleet-node deep link (category 'needs-input'). */
  readonly nodeId?: string | undefined;
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
