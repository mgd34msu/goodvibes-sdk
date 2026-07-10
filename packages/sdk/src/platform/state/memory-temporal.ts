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

/** Whether a record is inside its temporal validity window at `now` (i.e. injectable). */
export function isMemoryTemporallyActive(
  record: Pick<MemoryRecord, 'validFrom' | 'validUntil'>,
  now: number = Date.now(),
): boolean {
  return memoryRecordTemporalStatus(record, now) === 'active';
}
