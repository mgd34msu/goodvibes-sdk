/**
 * budget.ts, the three daily pools, and why drawing on them is a two-step.
 *
 * ── The pools ─────────────────────────────────────────────────────────────
 *
 *  - ITEM      the item price is checked against this.
 *  - OVERAGE   only charges that cannot be avoided on an approved purchase:
 *              sales tax, mandatory handling or booking fees, and the delivery
 *              option actually used. Discretionary add-ons, expedited shipping
 *              beyond what the ladder picks, insurance, gift wrap, extended
 *              warranties, are purchase decisions, not delivery costs, and are
 *              never charged here.
 *  - TOLERANCE the shortfall when the overage pool cannot cover even the
 *              cheapest delivery. Default OFF with a zero allowance, so
 *              enabling it without setting an amount changes nothing.
 *
 * ── Why reserve-then-commit rather than check-then-charge ────────────────
 *
 * Two purchases evaluated at the same time can each individually fit what
 * remains and together exceed it. A veto window makes that likely rather than
 * theoretical: it is minutes wide by design, and the second purchase is decided
 * while the first is still waiting. So a decision TAKES a reservation, and the
 * money is unavailable to anything else from that moment until the purchase
 * either commits or releases.
 *
 * Reservations are persisted, because a daemon restart mid-window must not
 * release money that is still mid-flight, and they are swept, because a
 * reservation whose purchase died is a slow leak of budget that a restart would
 * otherwise make permanent.
 */
import { dayKey, type DayKey } from './day.js';
import type { BudgetPool, MinorUnits } from './types.js';

export interface BudgetLimits {
  readonly dailyItemMinorUnits: MinorUnits;
  readonly dailyOverageMinorUnits: MinorUnits;
  readonly perPurchaseCeiling: {
    readonly enabled: boolean;
    readonly minorUnits: MinorUnits;
  };
  readonly overageTolerance: {
    readonly enabled: boolean;
    readonly dailyAllowanceMinorUnits: MinorUnits;
  };
}

/** One completed draw. Keeps its UTC instant so totals can be re-derived. */
export interface SpendRecord {
  readonly purchaseId: string;
  readonly atMs: number;
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
}

export interface BudgetReservation {
  readonly id: string;
  readonly dayKey: DayKey;
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface PoolSnapshot {
  readonly dayKey: DayKey;
  readonly timezone: string;
  readonly item: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
  readonly overage: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
  readonly tolerance: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
}

/**
 * How long a reservation may sit before the sweeper reclaims it.
 *
 * Comfortably longer than the longest window (the 60-minute approval) plus the
 * time a checkout can plausibly take, so a live purchase is never swept out from
 * under itself; short enough that a crashed purchase does not hold budget for a
 * day.
 */
export const RESERVATION_TTL_MS = 4 * 60 * 60 * 1000;

/** Hard cap on retained reservations, so a leak cannot grow without bound. */
export const MAX_RESERVATIONS = 256;

export interface BudgetStateSnapshot {
  readonly spend: readonly SpendRecord[];
  readonly reservations: readonly BudgetReservation[];
}

/**
 * The pools, over a set of spend records and live reservations.
 *
 * Deliberately not a running counter: `snapshot()` filters spend records by the
 * CURRENT timezone every time it is asked. That is what makes changing
 * `daemon.timezone` unable to refill a spent pool, see day.ts.
 */
export class BudgetLedger {
  private spend: SpendRecord[] = [];
  private reservations: BudgetReservation[] = [];

  constructor(initial?: BudgetStateSnapshot) {
    if (initial !== undefined) {
      this.spend = [...initial.spend];
      this.reservations = [...initial.reservations];
    }
  }

  snapshot(limits: BudgetLimits, nowMs: number, timezone: string): PoolSnapshot {
    const today = dayKey(nowMs, timezone);
    let itemSpent = 0;
    let overageSpent = 0;
    let toleranceSpent = 0;
    for (const record of this.spend) {
      if (dayKey(record.atMs, timezone) !== today) continue;
      itemSpent += record.itemMinorUnits;
      overageSpent += record.overageMinorUnits;
      toleranceSpent += record.toleranceMinorUnits;
    }

    let itemReserved = 0;
    let overageReserved = 0;
    let toleranceReserved = 0;
    for (const reservation of this.reservations) {
      if (reservation.expiresAtMs <= nowMs) continue;
      if (reservation.dayKey !== today) continue;
      itemReserved += reservation.itemMinorUnits;
      overageReserved += reservation.overageMinorUnits;
      toleranceReserved += reservation.toleranceMinorUnits;
    }

    const toleranceLimit = limits.overageTolerance.enabled
      ? limits.overageTolerance.dailyAllowanceMinorUnits
      : 0;

    return {
      dayKey: today,
      timezone,
      item: pool(limits.dailyItemMinorUnits, itemSpent, itemReserved),
      overage: pool(limits.dailyOverageMinorUnits, overageSpent, overageReserved),
      tolerance: pool(toleranceLimit, toleranceSpent, toleranceReserved),
    };
  }

  /**
   * Hold budget for a purchase in flight.
   *
   * Returns null when the draw does not fit what remains, the caller must treat
   * that as the decision, never as a reason to charge anyway.
   */
  reserve(input: {
    readonly id: string;
    readonly itemMinorUnits: MinorUnits;
    readonly overageMinorUnits: MinorUnits;
    readonly toleranceMinorUnits: MinorUnits;
    readonly limits: BudgetLimits;
    readonly nowMs: number;
    readonly timezone: string;
    readonly ttlMs?: number;
  }): BudgetReservation | null {
    const snapshot = this.snapshot(input.limits, input.nowMs, input.timezone);
    if (input.itemMinorUnits > snapshot.item.remaining) return null;
    if (input.overageMinorUnits > snapshot.overage.remaining) return null;
    if (input.toleranceMinorUnits > snapshot.tolerance.remaining) return null;

    const reservation: BudgetReservation = {
      id: input.id,
      dayKey: snapshot.dayKey,
      itemMinorUnits: input.itemMinorUnits,
      overageMinorUnits: input.overageMinorUnits,
      toleranceMinorUnits: input.toleranceMinorUnits,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + (input.ttlMs ?? RESERVATION_TTL_MS),
    };
    this.reservations.push(reservation);
    this.enforceReservationCap();
    return reservation;
  }

  /** The purchase happened. The reservation becomes a spend record. */
  commit(reservationId: string, atMs: number): SpendRecord | null {
    const index = this.reservations.findIndex((entry) => entry.id === reservationId);
    if (index === -1) return null;
    const [reservation] = this.reservations.splice(index, 1);
    if (reservation === undefined) return null;
    const record: SpendRecord = {
      purchaseId: reservation.id,
      atMs,
      itemMinorUnits: reservation.itemMinorUnits,
      overageMinorUnits: reservation.overageMinorUnits,
      toleranceMinorUnits: reservation.toleranceMinorUnits,
    };
    this.spend.push(record);
    return record;
  }

  /** The purchase did not happen. The money goes back. */
  release(reservationId: string): boolean {
    const index = this.reservations.findIndex((entry) => entry.id === reservationId);
    if (index === -1) return false;
    this.reservations.splice(index, 1);
    return true;
  }

  /**
   * Reclaim reservations whose purchase died, and report what was reclaimed.
   *
   * Returns the swept entries rather than a count, because the platform rule for
   * anything persisted across restarts is that its recoveries are DISCLOSED,
   * an audit record naming what was reclaimed, not a silent tidy-up.
   */
  sweep(nowMs: number): readonly BudgetReservation[] {
    const expired = this.reservations.filter((entry) => entry.expiresAtMs <= nowMs);
    if (expired.length > 0) {
      this.reservations = this.reservations.filter((entry) => entry.expiresAtMs > nowMs);
    }
    return expired;
  }

  /** Money coming back is recorded and credits nothing. See docs/payments.md §9.7.3. */
  recordRefund(purchaseId: string): boolean {
    return this.spend.some((record) => record.purchaseId === purchaseId);
  }

  state(): BudgetStateSnapshot {
    return { spend: [...this.spend], reservations: [...this.reservations] };
  }

  /**
   * Drop spend records that can no longer affect any pool.
   *
   * Anything older than two days cannot be "today" in any timezone on earth
   * (the widest real offset span is under 27 hours), so retaining more is a
   * daemon-lifetime leak with no decision riding on it. The audit ledger, not
   * this, is the long-term record.
   */
  prune(nowMs: number): void {
    const cutoff = nowMs - 2 * 24 * 60 * 60 * 1000;
    this.spend = this.spend.filter((record) => record.atMs >= cutoff);
  }

  private enforceReservationCap(): void {
    if (this.reservations.length <= MAX_RESERVATIONS) return;
    this.reservations.sort((left, right) => left.createdAtMs - right.createdAtMs);
    this.reservations = this.reservations.slice(this.reservations.length - MAX_RESERVATIONS);
  }
}

function pool(
  limit: MinorUnits,
  spent: MinorUnits,
  reserved: MinorUnits,
): { limit: MinorUnits; spent: MinorUnits; reserved: MinorUnits; remaining: MinorUnits } {
  return { limit, spent, reserved, remaining: Math.max(0, limit - spent - reserved) };
}

/**
 * The item limit, raised by exactly this purchase's shortfall.
 *
 * Used only for a purchase the decision layer classified as needing the owner's
 * yes, and only so the money can be HELD while they are asked. It grants nothing:
 * a denial or a silence releases the reservation in full, and the pool it was
 * held against is otherwise unchanged, so the next purchase is measured against
 * the same daily limit it always was.
 *
 * Returns the limits object unchanged when nothing needs raising, so the common
 * path, over the per-purchase CEILING but still inside the daily pool, takes
 * a perfectly ordinary reservation.
 */
export function admitApprovedItemOverdraw(
  limits: BudgetLimits,
  itemMinorUnits: MinorUnits,
  itemRemaining: MinorUnits,
): BudgetLimits {
  const shortfall = itemMinorUnits - itemRemaining;
  if (shortfall <= 0) return limits;
  return { ...limits, dailyItemMinorUnits: limits.dailyItemMinorUnits + shortfall };
}
