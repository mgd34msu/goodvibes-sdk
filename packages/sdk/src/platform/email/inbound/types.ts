/**
 * types.ts — shared types and validation primitives for the inbound-email
 * persisted stores: cursor-store.ts, record-store.ts, expectation-store.ts,
 * and housekeeping.ts.
 *
 * These stores follow the five-rule directive stated in full in
 * `platform/devices/device-grants.ts`'s header and composed by
 * `platform/devices/device-housekeeping.ts`: reap on recovery, bound
 * everything, validate by content, reap periodically, disclose what was
 * reaped. See docs/inbound-email.md §9 for the design of record.
 */

/** Why a sweep ran. Shared across every store's `sweep()` and the housekeeper. */
export type HousekeepingTrigger = 'recovery' | 'periodic' | 'manual';

/**
 * The cursor shape settled by docs/inbound-email.md §4 — verbatim, not
 * re-decided here. Keyed by (account, mailbox) so the store cannot grow with
 * traffic: one record per watched mailbox, not one per message.
 */
export interface MailboxCursor {
  /** Config account id, not an address. */
  readonly account: string;
  /** The EXAMINE target. */
  readonly mailbox: string;
  /** From the EXAMINE response. */
  readonly uidValidity: number;
  /** Highest UID fully processed. */
  readonly lastSeenUid: number;
  /** ISO 8601. */
  readonly updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Validation primitives shared by every validate*() in this directory.
//
// Each of these is a pure content check with no side effects, used by the
// stores' standalone `validate*(value: unknown): T | null` functions, which
// re-check EVERY field and return `null` for a torn record — never throw,
// never repair.
// ─────────────────────────────────────────────────────────────────────────

export function isNonEmptyTrimmedString(value: unknown, maxLength = 1024): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A string that both parses as a date AND is bounded in length (a torn record can carry a multi-megabyte "date"). */
export function isParsableIsoDate(value: unknown, maxLength = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && Number.isFinite(Date.parse(value));
}

/**
 * Longest inbound-mail body excerpt retained, mirroring
 * `MAX_RETAINED_CONTENT_CHARS` in `platform/security/untrusted-content.ts`.
 * Not imported from there: that constant is module-private in a file this
 * round does not touch (platform/security/ is owned by the parallel taint
 * round — see docs/inbound-email.md §10). Keep this value in lockstep with
 * that file if it ever changes; both cap the same failure mode, an unbounded
 * copy of untrusted body text living forever in a daemon that never restarts.
 */
export const MAX_BODY_EXCERPT_CHARS = 20_000;
