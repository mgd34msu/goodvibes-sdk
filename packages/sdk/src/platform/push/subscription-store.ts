/**
 * push/subscription-store.ts
 *
 * The on-disk record of which devices an operator has registered for browser
 * push. Persisted with the same atomic-JSON `PersistentStore` the approval and
 * session stores use — the capability URLs and key material stay on disk in the
 * daemon's own state directory, never on the wire.
 *
 * Delete means delete: `remove()` drops the record entirely (it does not flag a
 * tombstone), and `list()` cannot return it afterward. Pruning a dead endpoint
 * uses the same `remove()` path.
 */

import { createHash, randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import type {
  PublicPushSubscription,
  PushReconcileDrift,
  StoredPushSubscription,
  SubscriptionKeyMaterial,
} from './types.js';

interface SubscriptionSnapshot extends Record<string, unknown> {
  readonly subscriptions: readonly StoredPushSubscription[];
}

export interface RegisterSubscriptionInput {
  readonly principalId: string;
  /** Stable device identity; when present the record reconciles on it, not the endpoint. */
  readonly deviceId?: string | undefined;
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
}

/** The outcome of a reconcile-on-open: the healed record plus what drifted. */
export interface ReconcileResult {
  readonly record: StoredPushSubscription;
  readonly drift: PushReconcileDrift;
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'invalid';
  }
}

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);
}

/** The redacted, wire-safe projection of a stored subscription. */
export function toPublicSubscription(record: StoredPushSubscription): PublicPushSubscription {
  return {
    id: record.id,
    principalId: record.principalId,
    ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
    endpointOrigin: endpointOrigin(record.endpoint),
    endpointHash: endpointHash(record.endpoint),
    createdAt: record.createdAt,
    lastDeliveryAt: record.lastDeliveryAt,
    lastOutcome: record.lastOutcome,
    ...(record.consecutiveFailures ? { consecutiveFailures: record.consecutiveFailures } : {}),
  };
}

/** The short, stable hash a client compares its own endpoint against to detect drift. */
export function endpointHashFor(endpoint: string): string {
  return endpointHash(endpoint);
}

export class PushSubscriptionStore {
  private readonly store: PersistentStore<SubscriptionSnapshot>;
  private records: StoredPushSubscription[] | null = null;

  constructor(filePath: string) {
    this.store = new PersistentStore<SubscriptionSnapshot>(filePath);
  }

  private async ensureLoaded(): Promise<StoredPushSubscription[]> {
    if (this.records) return this.records;
    const snapshot = await this.store.load();
    this.records = snapshot?.subscriptions ? [...snapshot.subscriptions] : [];
    return this.records;
  }

  private async flush(): Promise<void> {
    await this.store.persist({ subscriptions: this.records ?? [] });
  }

  /**
   * Find the record this input reconciles onto: by device identity when the
   * input carries a deviceId (so a rotated endpoint heals in place), otherwise
   * by raw endpoint (the legacy, device-id-less path). Returns the index or -1.
   */
  private matchIndex(records: readonly StoredPushSubscription[], input: RegisterSubscriptionInput): number {
    if (input.deviceId !== undefined) {
      return records.findIndex((r) => r.principalId === input.principalId && r.deviceId === input.deviceId);
    }
    return records.findIndex((r) => r.principalId === input.principalId && r.endpoint === input.endpoint);
  }

  /**
   * Register (or refresh) a subscription. A record is reconciled on device
   * identity when the input carries a deviceId (a browser whose endpoint
   * rotated presents the same deviceId with a new endpoint, healing the one
   * record), otherwise on the raw endpoint (legacy). Either way a re-register
   * clears the failure counter — the client just proved the device is live.
   */
  async register(input: RegisterSubscriptionInput): Promise<StoredPushSubscription> {
    return (await this.reconcile(input)).record;
  }

  /**
   * Reconcile-on-open: store the client's CURRENT endpoint/keys for its device
   * identity, healing a stale record in place, and report what drifted so the
   * client learns whether the daemon had been holding an out-of-date endpoint.
   */
  async reconcile(input: RegisterSubscriptionInput): Promise<ReconcileResult> {
    const records = await this.ensureLoaded();
    const existingIndex = this.matchIndex(records, input);
    const now = Date.now();
    if (existingIndex >= 0) {
      const prior = records[existingIndex] as StoredPushSubscription;
      const endpointChanged = prior.endpoint !== input.endpoint;
      const keysChanged = prior.keys.p256dh !== input.keys.p256dh || prior.keys.auth !== input.keys.auth;
      const updated: StoredPushSubscription = {
        ...prior,
        endpoint: input.endpoint,
        keys: input.keys,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        // A live client resets the bounded-retry failure counter.
        consecutiveFailures: 0,
      };
      records[existingIndex] = updated;
      await this.flush();
      const drift: PushReconcileDrift = endpointChanged
        ? 'endpoint-updated'
        : keysChanged
          ? 'keys-updated'
          : 'unchanged';
      return { record: updated, drift };
    }
    const record: StoredPushSubscription = {
      id: `push-${randomUUID()}`,
      principalId: input.principalId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      endpoint: input.endpoint,
      keys: input.keys,
      createdAt: now,
    };
    records.push(record);
    await this.flush();
    return { record, drift: 'created' };
  }

  /** All subscriptions for a principal, redacted for the wire. */
  async listPublic(principalId: string): Promise<PublicPushSubscription[]> {
    const records = await this.ensureLoaded();
    return records
      .filter((r) => r.principalId === principalId)
      .map(toPublicSubscription);
  }

  /** The full record (endpoint + keys) for a delivery. Not for the wire. */
  async get(id: string): Promise<StoredPushSubscription | null> {
    const records = await this.ensureLoaded();
    return records.find((r) => r.id === id) ?? null;
  }

  /** Every stored subscription — the delivery fan-out reads this. Not for the wire. */
  async all(): Promise<readonly StoredPushSubscription[]> {
    return [...(await this.ensureLoaded())];
  }

  /**
   * Delete a subscription. Returns true if a record was actually removed, false
   * if the id was already absent — the caller reports an honest 404 rather than
   * a 200-noop. An optional `principalId` scopes the delete so one operator
   * cannot remove another's device.
   */
  async remove(id: string, principalId?: string): Promise<boolean> {
    const records = await this.ensureLoaded();
    const index = records.findIndex(
      (r) => r.id === id && (principalId === undefined || r.principalId === principalId),
    );
    if (index < 0) return false;
    records.splice(index, 1);
    await this.flush();
    return true;
  }

  /**
   * Record the outcome of the last delivery attempt against a subscription. A
   * `delivered` outcome resets the consecutive-failure counter; a `failed`
   * outcome increments it (the bounded-retry counter the delivery path prunes
   * on). Returns the resulting consecutive-failure count so the delivery path
   * can decide whether the bounded retries are exhausted.
   */
  async recordOutcome(id: string, outcome: StoredPushSubscription['lastOutcome']): Promise<number> {
    const records = await this.ensureLoaded();
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return 0;
    const prior = records[index] as StoredPushSubscription;
    const consecutiveFailures = outcome === 'failed'
      ? (prior.consecutiveFailures ?? 0) + 1
      : outcome === 'delivered'
        ? 0
        : (prior.consecutiveFailures ?? 0);
    records[index] = { ...prior, lastDeliveryAt: Date.now(), lastOutcome: outcome, consecutiveFailures };
    await this.flush();
    return consecutiveFailures;
  }
}
