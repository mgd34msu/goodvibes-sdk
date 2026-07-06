/**
 * push/delivery.ts
 *
 * The single place a push message is actually encrypted and sent. Every send —
 * a `push.subscriptions.verify` test, or an approval/completion fan-out — flows
 * through `deliverToSubscription`, so the honesty rules live in one spot:
 *
 *  - A push service that answers 404/410 means the browser subscription is gone;
 *    the record is pruned and the receipt says `pruned`, never a fake success.
 *  - Any other non-2xx (or a transport error) is reported as `failed` with the
 *    status/reason, never swallowed into a success.
 *  - The request carries the RFC 8188 `Content-Encoding: aes128gcm` body plus
 *    the `TTL`, `Urgency`, and VAPID `Authorization` headers a push service
 *    requires.
 *
 * The endpoint is whatever the browser registered. In tests that is a local
 * HTTP sink; in production it is the browser vendor's push service. This module
 * never contacts a hard-coded external service of its own.
 */

import { encryptPushPayload } from './encryption.js';
import type { VapidManager } from './vapid.js';
import type { PushSubscriptionStore } from './subscription-store.js';
import type {
  PushDeliveryReceipt,
  PushMessage,
  StoredPushSubscription,
} from './types.js';

/** The `fetch` slice used to POST an encrypted payload. Injectable for tests. */
export type PushTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number }>;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const GONE_STATUSES = new Set([404, 410]);

function defaultTransport(): PushTransport {
  return async (url, init) => {
    // Re-wrap over a plain ArrayBuffer so the body matches fetch's BodyInit.
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: new Uint8Array(init.body),
    });
    return { status: res.status };
  };
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'invalid';
  }
}

function messagePlaintext(message: PushMessage): Buffer {
  return Buffer.from(
    JSON.stringify({ title: message.title, body: message.body, data: message.data ?? {} }),
    'utf8',
  );
}

export interface DeliveryDeps {
  readonly vapid: VapidManager;
  readonly store: PushSubscriptionStore;
  readonly transport?: PushTransport | undefined;
}

/**
 * Encrypt and send one message to one subscription, prune-on-gone, and return
 * an honest receipt. The subscription's `lastOutcome` is stamped either way.
 */
export async function deliverToSubscription(
  subscription: StoredPushSubscription,
  message: PushMessage,
  deps: DeliveryDeps,
): Promise<PushDeliveryReceipt> {
  const origin = endpointOrigin(subscription.endpoint);
  const transport = deps.transport ?? defaultTransport();

  let httpStatus: number;
  try {
    const encrypted = encryptPushPayload(subscription.keys, messagePlaintext(message));
    const authorization = await deps.vapid.buildAuthorizationHeader(subscription.endpoint);
    const headers: Record<string, string> = {
      'content-encoding': encrypted.contentEncoding,
      'content-type': 'application/octet-stream',
      ttl: String(message.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      urgency: message.urgency ?? 'normal',
      authorization,
    };
    const result = await transport(subscription.endpoint, {
      method: 'POST',
      headers,
      body: encrypted.body,
    });
    httpStatus = result.status;
  } catch (error) {
    await deps.store.recordOutcome(subscription.id, 'failed');
    return {
      subscriptionId: subscription.id,
      endpointOrigin: origin,
      outcome: 'failed',
      detail: `delivery request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    await deps.store.recordOutcome(subscription.id, 'delivered');
    return { subscriptionId: subscription.id, endpointOrigin: origin, outcome: 'delivered', httpStatus };
  }

  if (GONE_STATUSES.has(httpStatus)) {
    // The subscription is gone at the push service — prune it (delete means
    // delete) and report the prune with the status that proved it dead.
    await deps.store.remove(subscription.id);
    return {
      subscriptionId: subscription.id,
      endpointOrigin: origin,
      outcome: 'pruned',
      httpStatus,
      detail: `push endpoint reported ${httpStatus} gone; subscription removed`,
    };
  }

  await deps.store.recordOutcome(subscription.id, 'failed');
  return {
    subscriptionId: subscription.id,
    endpointOrigin: origin,
    outcome: 'failed',
    httpStatus,
    detail: `push service returned ${httpStatus}`,
  };
}

/**
 * Fan one message out to every stored subscription, delivering (and pruning) in
 * sequence. Returns one receipt per subscription — an empty array when there
 * are no subscriptions at all (the honest "nobody to notify" result, not a
 * silent success).
 */
export async function deliverToAll(
  message: PushMessage,
  deps: DeliveryDeps,
): Promise<PushDeliveryReceipt[]> {
  const subscriptions = await deps.store.all();
  const receipts: PushDeliveryReceipt[] = [];
  for (const subscription of subscriptions) {
    receipts.push(await deliverToSubscription(subscription, message, deps));
  }
  return receipts;
}
