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
  StoredPushSubscription,
  SubscriptionKeyMaterial,
} from './types.js';

interface SubscriptionSnapshot extends Record<string, unknown> {
  readonly subscriptions: readonly StoredPushSubscription[];
}

export interface RegisterSubscriptionInput {
  readonly principalId: string;
  readonly endpoint: string;
  readonly keys: SubscriptionKeyMaterial;
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
    endpointOrigin: endpointOrigin(record.endpoint),
    endpointHash: endpointHash(record.endpoint),
    createdAt: record.createdAt,
    lastDeliveryAt: record.lastDeliveryAt,
    lastOutcome: record.lastOutcome,
  };
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
   * Register (or refresh) a subscription. Two subscriptions from the same
   * principal for the same endpoint collapse onto one record — a browser that
   * re-subscribes with rotated keys updates in place rather than piling up
   * duplicate capability URLs.
   */
  async register(input: RegisterSubscriptionInput): Promise<StoredPushSubscription> {
    const records = await this.ensureLoaded();
    const existingIndex = records.findIndex(
      (r) => r.principalId === input.principalId && r.endpoint === input.endpoint,
    );
    const now = Date.now();
    if (existingIndex >= 0) {
      const prior = records[existingIndex] as StoredPushSubscription;
      const updated: StoredPushSubscription = { ...prior, keys: input.keys };
      records[existingIndex] = updated;
      await this.flush();
      return updated;
    }
    const record: StoredPushSubscription = {
      id: `push-${randomUUID()}`,
      principalId: input.principalId,
      endpoint: input.endpoint,
      keys: input.keys,
      createdAt: now,
    };
    records.push(record);
    await this.flush();
    return record;
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

  /** Record the outcome of the last delivery attempt against a subscription. */
  async recordOutcome(id: string, outcome: StoredPushSubscription['lastOutcome']): Promise<void> {
    const records = await this.ensureLoaded();
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return;
    const prior = records[index] as StoredPushSubscription;
    records[index] = { ...prior, lastDeliveryAt: Date.now(), lastOutcome: outcome };
    await this.flush();
  }
}
