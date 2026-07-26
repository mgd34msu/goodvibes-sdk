/**
 * push/subscription-housekeeping.ts — recovery-time and periodic garbage
 * collection for the browser-push subscription store.
 *
 * `push-subscriptions.json` outlives every restart, so the standing rule for
 * persisted state applies: reap on recovery, validate by content rather than
 * existence, sweep periodically rather than only at boot, and disclose what was
 * removed. Disclosure is written to `push-subscriptions-housekeeping.json`
 * beside the store, the same way the checkpoint adoption path writes
 * `checkpoints-moved.json`, so a removal is never indistinguishable from data
 * loss.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — the owner's ruling of 2026-07-26: "as
 * long as it is transparent to the user and the user never has to resubscribe
 * or anything like that and everything keeps working, it's fine. otherwise it
 * needs to remain unbounded. i want zero friction."
 *
 * So a subscription is removed ONLY on evidence that it is already dead:
 *
 *  - `unusable`          — its own endpoint/key material fails the same content
 *                          validation registration applies, so no delivery to it
 *                          could ever succeed. (Legacy records only: nothing
 *                          that fails validation can be registered any more.)
 *  - `malformed`         — the record is torn or missing required fields; it
 *                          cannot be addressed at all.
 *  - `failure-threshold` — the push service has refused it for at least
 *                          `failureThreshold` consecutive deliveries, the same
 *                          bound the delivery path already prunes on. This sweep
 *                          only catches records a crash left behind mid-prune.
 *
 * There is NO age TTL, by design. Ninety days without a successful delivery is
 * not evidence a device is gone — it may simply have had nothing to receive.
 * The only way to turn age into evidence would be a probe push, which is
 * user-visible noise, so age alone never removes anything. A quiet device that
 * still works keeps working, forever, without the operator resubscribing.
 *
 * The per-principal count is likewise a WARNING threshold, never a cap: when a
 * principal is above it, the sweep says so in the disclosure and the store logs
 * it, and the record set stays whole. A working device is never traded for a
 * new one.
 *
 * Sweeps are idempotent and safe to run from more than one process: each pass
 * re-reads the file, recomputes removals from scratch by id, and applies them to
 * a fresh read before the atomic write, so a record another process added in the
 * meantime survives the sweep.
 */

import { PersistentStore } from '../state/persistent-store.js';
import { describeSubscriptionProblem } from './subscription-validation.js';
import type { StoredPushSubscription } from './types.js';

/** Why a subscription left the store. Every value is evidence-backed. */
export type PushSubscriptionRemovalReason = 'unusable' | 'malformed' | 'failure-threshold';

/** One removal, itemised for disclosure with the evidence that it was dead. */
export interface PushSubscriptionRemoval {
  readonly subscriptionId: string;
  readonly principalId: string;
  /** Origin only — the full endpoint is a capability URL and stays off disclosure. */
  readonly endpointOrigin: string;
  readonly endpointHash: string;
  readonly reason: PushSubscriptionRemovalReason;
  /** Plain-language proof this record could not have received a push. */
  readonly evidence: string;
  readonly removedAt: number;
}

/** A principal holding more subscriptions than the warning threshold. */
export interface PushSubscriptionCrowding {
  readonly principalId: string;
  readonly count: number;
  readonly warnAbove: number;
}

/** What one housekeeping pass found and removed. */
export interface PushSubscriptionSweepReport {
  readonly sweptAt: number;
  readonly trigger: 'recovery' | 'periodic' | 'registration' | 'manual';
  readonly removed: readonly PushSubscriptionRemoval[];
  readonly retained: number;
  /** Principals above the warning threshold AFTER the sweep. Nothing was removed for this. */
  readonly crowded: readonly PushSubscriptionCrowding[];
  /** One-line summary a surface can render without reading the itemised lists. */
  readonly summary: string;
}

/** The knobs housekeeping reads; the composition root fills them from config. */
export interface PushSubscriptionPolicy {
  /**
   * Per-principal count that triggers a WARNING, not a removal. Above it the
   * sweep discloses the crowding and every subscription is kept.
   */
  readonly warnAbovePerPrincipal: number;
  /**
   * Consecutive refused deliveries after which the push service has proved the
   * endpoint dead. Shared with the delivery path so the two cannot disagree.
   */
  readonly failureThreshold: number;
}

/**
 * Stock policy. 50 is the owner-proposed per-principal figure, carried here as
 * the warning threshold it became; 5 is the delivery path's existing bound.
 */
export const DEFAULT_PUSH_SUBSCRIPTION_POLICY: PushSubscriptionPolicy = {
  warnAbovePerPrincipal: 50,
  failureThreshold: 5,
};

interface HousekeepingLog extends Record<string, unknown> {
  readonly version: 1;
  readonly reports: readonly PushSubscriptionSweepReport[];
}

/** Keep the disclosure log bounded — it is persisted state too. */
const MAX_DISCLOSURE_REPORTS = 20;

/** The result of judging a loaded record set: what survives and what is proven dead. */
export interface PushSweepDecision {
  readonly kept: StoredPushSubscription[];
  readonly removed: PushSubscriptionRemoval[];
  readonly crowded: PushSubscriptionCrowding[];
}

function endpointOriginOf(endpoint: unknown): string {
  if (typeof endpoint !== 'string') return 'unknown';
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'invalid';
  }
}

function isRecordShaped(value: unknown): value is StoredPushSubscription {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<StoredPushSubscription>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.principalId === 'string'
    && record.principalId.length > 0
    && typeof record.endpoint === 'string'
    && record.keys !== null
    && typeof record.keys === 'object';
}

/**
 * Decide, from content alone, which loaded records are provably dead. Pure and
 * deterministic: running it twice over the same input removes nothing the
 * second time, which is what makes the sweep idempotent.
 */
export function decidePushSweep(
  loaded: readonly unknown[],
  policy: PushSubscriptionPolicy,
  now: number,
  hashEndpoint: (endpoint: string) => string,
): PushSweepDecision {
  const kept: StoredPushSubscription[] = [];
  const removed: PushSubscriptionRemoval[] = [];

  for (const entry of loaded) {
    if (!isRecordShaped(entry)) {
      const partial = (entry ?? {}) as Partial<StoredPushSubscription>;
      removed.push({
        subscriptionId: typeof partial.id === 'string' ? partial.id : '(no id)',
        principalId: typeof partial.principalId === 'string' ? partial.principalId : '(unknown)',
        endpointOrigin: endpointOriginOf(partial.endpoint),
        endpointHash: typeof partial.endpoint === 'string' ? hashEndpoint(partial.endpoint) : '(none)',
        reason: 'malformed',
        evidence: 'record is missing the id / principal / endpoint / keys it needs to be addressed at all',
        removedAt: now,
      });
      continue;
    }
    const problem = describeSubscriptionProblem({ endpoint: entry.endpoint, keys: entry.keys });
    if (problem) {
      removed.push({
        subscriptionId: entry.id,
        principalId: entry.principalId,
        endpointOrigin: endpointOriginOf(entry.endpoint),
        endpointHash: hashEndpoint(entry.endpoint),
        reason: 'unusable',
        evidence: `${problem.field}: ${problem.reason} — no delivery to this record could ever succeed`,
        removedAt: now,
      });
      continue;
    }
    const failures = entry.consecutiveFailures ?? 0;
    if (failures >= policy.failureThreshold) {
      removed.push({
        subscriptionId: entry.id,
        principalId: entry.principalId,
        endpointOrigin: endpointOriginOf(entry.endpoint),
        endpointHash: hashEndpoint(entry.endpoint),
        reason: 'failure-threshold',
        evidence: `push service refused ${failures} consecutive deliveries (bound ${policy.failureThreshold})`,
        removedAt: now,
      });
      continue;
    }
    kept.push(entry);
  }

  const perPrincipal = new Map<string, number>();
  for (const record of kept) {
    perPrincipal.set(record.principalId, (perPrincipal.get(record.principalId) ?? 0) + 1);
  }
  const crowded: PushSubscriptionCrowding[] = [];
  for (const [principalId, count] of perPrincipal) {
    if (count > policy.warnAbovePerPrincipal) {
      crowded.push({ principalId, count, warnAbove: policy.warnAbovePerPrincipal });
    }
  }

  return { kept, removed, crowded };
}

/** The one-line disclosure summary. */
export function summarizePushSweep(decision: PushSweepDecision): string {
  const crowding = decision.crowded.length === 0
    ? ''
    : ` ${decision.crowded.length} principal(s) hold more than the warning threshold `
      + `(${decision.crowded.map((c) => `${c.principalId}: ${c.count} > ${c.warnAbove}`).join(', ')}); `
      + 'all of them were kept — a working device is never removed to make room.';
  if (decision.removed.length === 0) {
    return `Push subscription housekeeping: nothing was provably dead (${decision.kept.length} retained).${crowding}`;
  }
  const byReason = new Map<string, number>();
  for (const removal of decision.removed) {
    byReason.set(removal.reason, (byReason.get(removal.reason) ?? 0) + 1);
  }
  const detail = [...byReason].map(([reason, count]) => `${count} ${reason}`).join(', ');
  return `Push subscription housekeeping: ${decision.removed.length} dead subscription(s) removed `
    + `(${detail}). Retained ${decision.kept.length}.${crowding}`;
}

/**
 * The disclosure log beside the subscription store. Append-only within a bounded
 * window, read by anyone asking what housekeeping removed and on what evidence.
 */
export class PushHousekeepingDisclosure {
  private readonly store: PersistentStore<HousekeepingLog>;

  constructor(filePath: string) {
    this.store = new PersistentStore<HousekeepingLog>(filePath);
  }

  /** Disclosure history from disk, newest last. */
  async list(): Promise<readonly PushSubscriptionSweepReport[]> {
    const log = await this.store.load();
    return Array.isArray(log?.reports) ? log.reports : [];
  }

  /**
   * Record one report. A pass that removed nothing AND found no crowding writes
   * nothing — the log is for things a person needs to know about, not a
   * heartbeat.
   */
  async record(report: PushSubscriptionSweepReport): Promise<void> {
    if (report.removed.length === 0 && report.crowded.length === 0) return;
    const existing = await this.list();
    await this.store.persist({
      version: 1,
      reports: [...existing, report].slice(-MAX_DISCLOSURE_REPORTS),
    });
  }
}

/** `<store>.json` -> `<store>-housekeeping.json`, the disclosure beside it. */
export function housekeepingPathFor(storePath: string): string {
  return storePath.endsWith('.json')
    ? `${storePath.slice(0, -'.json'.length)}-housekeeping.json`
    : `${storePath}-housekeeping.json`;
}
