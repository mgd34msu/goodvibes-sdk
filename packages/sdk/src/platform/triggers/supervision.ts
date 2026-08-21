/**
 * supervision.ts, the spine all three watcher kinds share.
 *
 * A watcher that fails does two things in order: it walks a backoff ladder so a
 * briefly unreachable source recovers fast while a broken one stops hammering,
 * and after a fixed number of consecutive strikes it opens a breaker and parks
 * itself in a visible circuit-open state with the last error attached.
 *
 * Parking beats retrying forever: a trigger stuck in an invisible retry loop
 * looks identical to a healthy one from the outside, and burns the resource it
 * is polling. An open breaker is a state an operator can see and reset.
 *
 * Pure functions over a record, so the ladder and the breaker are testable
 * without waiting real wall-clock minutes.
 */

import type { TriggerRecord, TriggerState } from './types.js';

/** The default ladder: 30s, 60s, 5m, 15m, 60m. The last rung repeats. */
export const DEFAULT_BACKOFF_LADDER_MS: readonly number[] = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** Consecutive failures that open the breaker. */
export const DEFAULT_BREAKER_STRIKES = 5;

export interface SupervisionPolicy {
  readonly ladderMs: readonly number[];
  readonly breakerStrikes: number;
}

/**
 * Parses the comma-separated `watchers.triggers.backoffLadderMs` setting.
 * Falls back to the default ladder rather than throwing, a malformed setting
 * must not take the whole supervisor down.
 */
export function parseBackoffLadder(raw: string | undefined): readonly number[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_BACKOFF_LADDER_MS;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : DEFAULT_BACKOFF_LADDER_MS;
}

export function resolveSupervisionPolicy(input: {
  readonly backoffLadderMs?: string | undefined;
  readonly breakerStrikes?: number | undefined;
}): SupervisionPolicy {
  const strikes = Number.isInteger(input.breakerStrikes) && (input.breakerStrikes ?? 0) > 0
    ? (input.breakerStrikes as number)
    : DEFAULT_BREAKER_STRIKES;
  return { ladderMs: parseBackoffLadder(input.backoffLadderMs), breakerStrikes: strikes };
}

/** Delay for a given rung. Rungs past the end repeat the last one. */
export function backoffDelayFor(policy: SupervisionPolicy, rung: number): number {
  const ladder = policy.ladderMs;
  if (ladder.length === 0) return DEFAULT_BACKOFF_LADDER_MS[0]!;
  const index = Math.min(Math.max(0, rung), ladder.length - 1);
  return ladder[index]!;
}

export interface SupervisionOutcome {
  readonly state: TriggerState;
  readonly strikes: number;
  readonly backoffRung: number;
  readonly nextCheckAt: number;
  readonly delayMs: number;
  /** True when this failure is the one that opened the breaker. */
  readonly breakerOpened: boolean;
}

/**
 * Applies one failure. Increments the strike count, advances one rung, and
 * opens the breaker at the strike limit. Note the ordering: the rung used for
 * THIS delay is the pre-increment rung, so the first failure waits the first
 * ladder entry rather than skipping it.
 */
export function applyFailure(
  record: Pick<TriggerRecord, 'strikes' | 'backoffRung'>,
  policy: SupervisionPolicy,
  now: number,
): SupervisionOutcome {
  const strikes = record.strikes + 1;
  const rung = record.backoffRung;
  const delayMs = backoffDelayFor(policy, rung);
  const opened = strikes >= policy.breakerStrikes;
  return {
    state: opened ? 'circuit-open' : 'backoff',
    strikes,
    backoffRung: Math.min(rung + 1, Math.max(0, policy.ladderMs.length - 1)),
    nextCheckAt: opened ? Number.POSITIVE_INFINITY : now + delayMs,
    delayMs,
    breakerOpened: opened,
  };
}

/** Applies one success: strikes and rung both reset, cadence returns to normal. */
export function applySuccess(intervalMs: number, now: number): {
  readonly state: TriggerState;
  readonly strikes: number;
  readonly backoffRung: number;
  readonly nextCheckAt: number;
} {
  return { state: 'idle', strikes: 0, backoffRung: 0, nextCheckAt: now + Math.max(1, intervalMs) };
}

/** True when the breaker is open and the trigger must not run. */
export function isCircuitOpen(record: Pick<TriggerRecord, 'state'>): boolean {
  return record.state === 'circuit-open';
}

/**
 * Explicit operator reset. The breaker never closes on its own, that is the
 * point of parking, and an auto-closing breaker is just a slower retry loop.
 */
export function resetBreaker(record: TriggerRecord, now: number): TriggerRecord {
  return {
    ...record,
    state: 'idle',
    strikes: 0,
    backoffRung: 0,
    nextCheckAt: now,
    lastError: undefined,
    updatedAt: now,
  };
}

/** True when the trigger is due to run. Circuit-open triggers are never due. */
export function isDue(record: TriggerRecord, now: number): boolean {
  if (record.state === 'circuit-open' || record.state === 'cancelled' || record.state === 'fired') return false;
  return (record.nextCheckAt ?? 0) <= now;
}
