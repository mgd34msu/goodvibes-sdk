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
 *
 * Housekeeping (see subscription-housekeeping.ts for the full rationale):
 *  - Content is validated at REGISTRATION, so a record that could never receive
 *    a push is refused with a plain reason instead of being stored and failing
 *    weeks later at delivery time.
 *  - `sweep()` removes only records that are PROVABLY dead — unusable key
 *    material, a torn record, or a push service that has refused it past the
 *    bounded-failure threshold. There is no age TTL and no eviction to make
 *    room: a quiet device that still works is never removed, so nobody ever has
 *    to resubscribe.
 *  - Every sweep discloses what it removed and the evidence, and runs on
 *    recovery AND on a timer.
 *
 * Concurrency: there is no process-local cache. Every read goes to disk, so a
 * revocation takes effect on the very next lookup rather than after a restart.
 * Every read-modify-write runs under BOTH an in-process queue and the advisory
 * lock file the checkpoint store uses (`<store>.json.lock`), so a second
 * daemon's registration cannot be clobbered by this one's sweep, and two sweeps
 * over the same file cannot interleave.
 */

import { createHash, randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { logger } from '../utils/logger.js';
import {
  DEFAULT_PUSH_SUBSCRIPTION_POLICY,
  PushHousekeepingDisclosure,
  decidePushSweep,
  housekeepingPathFor,
  summarizePushSweep,
  type PushSubscriptionPolicy,
  type PushSubscriptionSweepReport,
} from './subscription-housekeeping.js';
import { assertUsableSubscription } from './subscription-validation.js';
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

/** Construction knobs; all optional so the stock store is one path argument. */
export interface PushSubscriptionStoreOptions {
  /** Housekeeping policy; absent ⇒ {@link DEFAULT_PUSH_SUBSCRIPTION_POLICY}. */
  readonly policy?: (() => PushSubscriptionPolicy) | PushSubscriptionPolicy | undefined;
  /** Where sweep disclosure is written; absent ⇒ `<store>-housekeeping.json`. */
  readonly disclosurePath?: string | undefined;
  /** Clock seam so disclosure timestamps are deterministic under test. */
  readonly now?: (() => number) | undefined;
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
  /** `<store>.json.lock` — the cross-process mutex, or null for an in-memory store. */
  private readonly lockPath: string | null;
  private readonly disclosure: PushHousekeepingDisclosure;
  private readonly policy: () => PushSubscriptionPolicy;
  private readonly now: () => number;
  /** Serializes in-process mutations so a sweep and a register cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: PushSubscriptionSweepReport | null = null;

  constructor(filePath: string, options: PushSubscriptionStoreOptions = {}) {
    this.store = new PersistentStore<SubscriptionSnapshot>(filePath);
    this.lockPath = filePath === ':memory:' ? null : `${filePath}.lock`;
    this.disclosure = new PushHousekeepingDisclosure(options.disclosurePath ?? housekeepingPathFor(filePath));
    const policy = options.policy;
    this.policy = typeof policy === 'function'
      ? policy
      : ((): PushSubscriptionPolicy => policy ?? DEFAULT_PUSH_SUBSCRIPTION_POLICY);
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Raw records straight from disk, unfiltered. */
  private async loadRaw(): Promise<unknown[]> {
    const snapshot = await this.store.load();
    return Array.isArray(snapshot?.subscriptions) ? [...snapshot.subscriptions] : [];
  }

  /**
   * Records from disk with the provably-dead ones filtered out of the RESULT
   * (they are removed from the file by `sweep()`, not by a read). A read never
   * serves a record that could not receive a push.
   */
  private async loadUsable(): Promise<StoredPushSubscription[]> {
    return decidePushSweep(await this.loadRaw(), this.policy(), this.now(), endpointHash).kept;
  }

  /**
   * Run `fn` as the only read-modify-write against this file, in this process
   * AND across processes. The in-process chain orders callers here; the
   * advisory lock file (the same one the checkpoint store uses) keeps a second
   * daemon's registration from being clobbered by this one's sweep. An
   * in-memory store has no file to contend on and takes the chain only.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const lockPath = this.lockPath;
      if (!lockPath) return fn();
      const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 10_000 });
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const next = this.queue.then(guarded, guarded);
    // Keep the chain alive after a rejection so one failure does not wedge the store.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(records: readonly StoredPushSubscription[]): Promise<void> {
    await this.store.persist({ subscriptions: records });
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
   *
   * Throws `PushSubscriptionValidationError` when the endpoint or key material
   * could never receive a push.
   */
  async register(input: RegisterSubscriptionInput): Promise<StoredPushSubscription> {
    return (await this.reconcile(input)).record;
  }

  /**
   * Reconcile-on-open: store the client's CURRENT endpoint/keys for its device
   * identity, healing a stale record in place, and report what drifted so the
   * client learns whether the daemon had been holding an out-of-date endpoint.
   *
   * A registration is NEVER refused for crowding. When a principal is already
   * above the warning threshold, housekeeping first removes anything provably
   * dead; if that frees nothing, the new device is accepted anyway and the
   * crowding is logged and disclosed. Trading a working device for a new one
   * would silently stop notifications on a device nobody unsubscribed.
   */
  async reconcile(input: RegisterSubscriptionInput): Promise<ReconcileResult> {
    assertUsableSubscription({ endpoint: input.endpoint, keys: input.keys });
    return this.run(async () => {
      const policy = this.policy();
      const now = this.now();
      const decision = decidePushSweep(await this.loadRaw(), policy, now, endpointHash);
      const records = decision.kept;
      const existingIndex = this.matchIndex(records, input);
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
        await this.persist(records);
        await this.discloseRegistrationPass(decision, now);
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
      await this.persist(records);
      const held = records.filter((r) => r.principalId === input.principalId).length;
      if (held > policy.warnAbovePerPrincipal) {
        logger.warn('Push subscriptions above the per-principal warning threshold', {
          principalId: input.principalId,
          held,
          warnAbove: policy.warnAbovePerPrincipal,
          note: 'accepted anyway — no working subscription is ever removed to make room',
        });
      }
      await this.discloseRegistrationPass(
        {
          kept: records,
          removed: decision.removed,
          crowded: held > policy.warnAbovePerPrincipal
            ? [{ principalId: input.principalId, count: held, warnAbove: policy.warnAbovePerPrincipal }]
            : [],
        },
        now,
      );
      return { record, drift: 'created' };
    });
  }

  /** Disclose whatever a registration-time pass reaped or flagged. */
  private async discloseRegistrationPass(
    decision: { kept: StoredPushSubscription[]; removed: PushSubscriptionSweepReport['removed']; crowded: PushSubscriptionSweepReport['crowded'] },
    now: number,
  ): Promise<void> {
    if (decision.removed.length === 0 && decision.crowded.length === 0) return;
    const report: PushSubscriptionSweepReport = {
      sweptAt: now,
      trigger: 'registration',
      removed: decision.removed,
      retained: decision.kept.length,
      crowded: decision.crowded,
      summary: summarizePushSweep({ kept: decision.kept, removed: [...decision.removed], crowded: [...decision.crowded] }),
    };
    this.lastReport = report;
    await this.disclosure.record(report);
  }

  /** All subscriptions for a principal, redacted for the wire. */
  async listPublic(principalId: string): Promise<PublicPushSubscription[]> {
    const records = await this.loadUsable();
    return records
      .filter((r) => r.principalId === principalId)
      .map(toPublicSubscription);
  }

  /** The full record (endpoint + keys) for a delivery. Not for the wire. */
  async get(id: string): Promise<StoredPushSubscription | null> {
    const records = await this.loadUsable();
    return records.find((r) => r.id === id) ?? null;
  }

  /** Every stored subscription — the delivery fan-out reads this. Not for the wire. */
  async all(): Promise<readonly StoredPushSubscription[]> {
    return this.loadUsable();
  }

  /**
   * Delete a subscription. Returns true if a record was actually removed, false
   * if the id was already absent — the caller reports an honest 404 rather than
   * a 200-noop. An optional `principalId` scopes the delete so one operator
   * cannot remove another's device.
   */
  async remove(id: string, principalId?: string): Promise<boolean> {
    return this.run(async () => {
      const records = (await this.loadRaw()).filter((r): r is StoredPushSubscription => r !== null && typeof r === 'object');
      const index = records.findIndex(
        (r) => r.id === id && (principalId === undefined || r.principalId === principalId),
      );
      if (index < 0) return false;
      records.splice(index, 1);
      await this.persist(records);
      return true;
    });
  }

  /**
   * Record the outcome of the last delivery attempt against a subscription. A
   * `delivered` outcome resets the consecutive-failure counter; a `failed`
   * outcome increments it (the bounded-retry counter the delivery path prunes
   * on). Returns the resulting consecutive-failure count so the delivery path
   * can decide whether the bounded retries are exhausted.
   */
  async recordOutcome(id: string, outcome: StoredPushSubscription['lastOutcome']): Promise<number> {
    return this.run(async () => {
      const records = (await this.loadRaw()).filter((r): r is StoredPushSubscription => r !== null && typeof r === 'object');
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return 0;
      const prior = records[index] as StoredPushSubscription;
      const consecutiveFailures = outcome === 'failed'
        ? (prior.consecutiveFailures ?? 0) + 1
        : outcome === 'delivered'
          ? 0
          : (prior.consecutiveFailures ?? 0);
      records[index] = { ...prior, lastDeliveryAt: this.now(), lastOutcome: outcome, consecutiveFailures };
      await this.persist(records);
      return consecutiveFailures;
    });
  }

  /** The most recent report this process produced, or null before the first pass. */
  getLastReport(): PushSubscriptionSweepReport | null {
    return this.lastReport;
  }

  /** Disclosure history from disk, newest last. */
  listDisclosures(): Promise<readonly PushSubscriptionSweepReport[]> {
    return this.disclosure.list();
  }

  /**
   * One housekeeping pass: remove every record that is provably dead, keep
   * everything else, and disclose the result. Idempotent — a second pass over
   * the same file removes nothing. Safe to run concurrently with another
   * process: removals are computed by id and applied to a fresh read, so a
   * record registered in between survives.
   */
  async sweep(trigger: PushSubscriptionSweepReport['trigger'] = 'manual'): Promise<PushSubscriptionSweepReport> {
    return this.run(async () => {
      const policy = this.policy();
      const now = this.now();
      const decision = decidePushSweep(await this.loadRaw(), policy, now, endpointHash);
      if (decision.removed.length > 0) {
        const doomed = new Set(decision.removed.map((r) => r.subscriptionId));
        const fresh = decidePushSweep(await this.loadRaw(), policy, now, endpointHash).kept;
        await this.persist(fresh.filter((r) => !doomed.has(r.id)));
      }
      const report: PushSubscriptionSweepReport = {
        sweptAt: now,
        trigger,
        removed: decision.removed,
        retained: decision.kept.length,
        crowded: decision.crowded,
        summary: summarizePushSweep(decision),
      };
      this.lastReport = report;
      await this.disclosure.record(report);
      if (decision.removed.length > 0 || decision.crowded.length > 0) {
        logger.info('Push subscription housekeeping', { trigger, summary: report.summary });
      }
      return report;
    });
  }

  /**
   * The recovery pass. Runs before any push verb is served, so a record left
   * torn by a crash, or one the delivery path had already proved dead when the
   * process died mid-prune, is removed rather than served.
   */
  runRecoverySweep(): Promise<PushSubscriptionSweepReport> {
    return this.sweep('recovery');
  }

  /**
   * Keep sweeping on an interval. A long-lived daemon that only swept at boot
   * would never sweep at all, so this is not optional wiring. The timer is
   * unref'd — a pending sweep never holds the process open.
   */
  startPeriodicSweep(intervalMs: number): void {
    this.stopPeriodicSweep();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep('periodic').catch((error) => {
        logger.warn('Push subscription sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stopPeriodicSweep(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
