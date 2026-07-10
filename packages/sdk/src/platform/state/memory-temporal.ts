/**
 * memory-temporal.ts — temporal validity windows for memory records.
 *
 * A record may carry a validity window [validFrom, validUntil). Outside it the
 * record is not injected — but it is NOT deleted, and read/list/projection
 * surfaces label it (pending / expired) rather than silently dropping it. The
 * window is consulted at injection time (memory-recall-contract.ts,
 * knowledge-injection.ts).
 */
import type { MemoryRecord } from './memory-store.js';

/** Where a record sits relative to its temporal validity window, at a given instant. */
export type MemoryTemporalStatus = 'active' | 'pending' | 'expired';

/**
 * Classify a record against its temporal validity window at `now`. 'pending'
 * means before validFrom; 'expired' means at/after validUntil; 'active'
 * otherwise. A record with neither bound is always 'active'.
 */
export function memoryRecordTemporalStatus(
  record: Pick<MemoryRecord, 'validFrom' | 'validUntil'>,
  now: number = Date.now(),
): MemoryTemporalStatus {
  if (record.validFrom !== undefined && now < record.validFrom) return 'pending';
  if (record.validUntil !== undefined && now >= record.validUntil) return 'expired';
  return 'active';
}

/**
 * Guard a temporal helper against `.filter(helper)` / `.map(helper)` misuse.
 *
 * Array.prototype.filter/map invoke their callback as (element, index, array).
 * A predicate whose second parameter is an optional `now` timestamp cannot tell
 * that apart by arity alone: passed directly to `.filter`, the array INDEX
 * (0, 1, 2, …) is bound to `now`, so every window check silently compares
 * against a near-zero epoch and expiry is defeated without a trace. That is the
 * exact regression this guards. Legitimate callers pass at most (record, now);
 * any further positional argument is the array `.filter` supplies, so we reject
 * it loudly instead of absorbing it. Wrap for iteration:
 * `records.filter((r) => isMemoryTemporallyActive(r))`.
 */
export function assertNoArrayIterationArgs(fnName: string, extraArgs: readonly unknown[]): void {
  if (extraArgs.length > 0) {
    throw new TypeError(
      `${fnName}() received an unexpected extra argument — it was almost certainly passed directly ` +
        `to Array.prototype.filter/map, which calls it as (element, index, array) and binds the array ` +
        `index to \`now\`, silently defeating the temporal validity check. Wrap it instead: ` +
        `records.filter((r) => ${fnName}(r)).`,
    );
  }
}

/**
 * Whether a record is inside its temporal validity window at `now` (i.e. injectable).
 *
 * The `...extraArgs: never[]` tail makes the signature reject a stray third
 * argument at the type level, and {@link assertNoArrayIterationArgs} makes the
 * same misuse throw at runtime (for untyped call sites) rather than silently
 * treating an array index as `now`.
 */
export function isMemoryTemporallyActive(
  record: Pick<MemoryRecord, 'validFrom' | 'validUntil'>,
  now: number = Date.now(),
  ...extraArgs: never[]
): boolean {
  assertNoArrayIterationArgs('isMemoryTemporallyActive', extraArgs);
  return memoryRecordTemporalStatus(record, now) === 'active';
}
