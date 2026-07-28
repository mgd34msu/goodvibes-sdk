/**
 * expectation-store.ts — persistence for `VerificationExpectationBook`
 * (docs/inbound-email.md §9.2).
 *
 * `VerificationExpectationBook` (`platform/google/verification-expectations.ts`)
 * is deliberately in-memory: "an expectation is a 15-minute grant, and a
 * grant that survives a restart is a grant nobody remembers issuing." That
 * reasoning is overridden narrowly, for a reason that post-dates it: the
 * daemon auto-restarts (hourly update check, restart at idle), so an
 * expectation opened moments before a restart must survive one, or the
 * verification mail it was waiting for arrives inert — the exact failure
 * this whole feature exists to eliminate.
 *
 * The override is narrow and keeps what the original reasoning protects:
 *  - Expectations persist with their ORIGINAL ABSOLUTE `expiresAt`. Nothing
 *    here ever recomputes a window from "now" — a restored expectation never
 *    gets a fresh grant.
 *  - Anything already expired is reaped ON LOAD, before it can match anything.
 *  - Every record is validated by content using
 *    `validatePersistedExpectation` — the SAME rules
 *    `VerificationExpectationBook.openExpectation` enforces — so a file on
 *    disk can never mint an expectation the live API would have refused.
 *    That is the security property of this store.
 *  - `MAX_OPEN_EXPECTATIONS` is enforced on load, not only on open.
 *
 * This store is a PERSISTENCE MIRROR, not a second decision-maker: it holds
 * no matching logic and does not decide what satisfies an expectation — that
 * stays entirely in `VerificationExpectationBook`. The intended wiring
 * (performed by the boot-time supervisor, not this module):
 *   1. At boot, call `runRecoverySweep()` and feed each surviving expectation
 *      into `VerificationExpectationBook.hydrateExpectation()` (added
 *      alongside `validatePersistedExpectation` in verification-expectations.ts
 *      for exactly this purpose — see that file's header for what was added).
 *   2. After every book mutation (open, close, consuming match), call
 *      `replaceAll(book.list())` to keep the on-disk mirror current.
 *   3. On the periodic timer, call `sweep('periodic')` to reap anything that
 *      expired since the last mirror write (the book itself sweeps lazily on
 *      its own read paths, but nothing calls those paths on a schedule).
 */
import { PersistentStore } from '../../state/persistent-store.js';
import {
  MAX_OPEN_EXPECTATIONS,
  validatePersistedExpectation,
  type VerificationExpectation,
} from '../../google/verification-expectations.js';
import type { HousekeepingTrigger } from './types.js';

export type ExpectationDiscardReason = 'malformed' | 'expired' | 'over-cap';

export interface ExpectationDiscard {
  readonly id: string;
  readonly recipientAddress: string;
  readonly reason: ExpectationDiscardReason;
  readonly removedAt: number;
  readonly note?: string | undefined;
}

export interface ExpectationSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly ExpectationDiscard[];
  readonly retained: number;
  /** Surviving expectations, for the boot-time supervisor to hydrate into the live book. */
  readonly survivors: readonly VerificationExpectation[];
}

export interface PersistedExpectationPolicy {
  /** Same ceiling `VerificationExpectationBook.openExpectation` enforces in memory. Enforced here on load too. */
  readonly maxOpenExpectations: number;
}

export const DEFAULT_PERSISTED_EXPECTATION_POLICY: PersistedExpectationPolicy = {
  maxOpenExpectations: MAX_OPEN_EXPECTATIONS,
};

interface ExpectationSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly expectations: readonly VerificationExpectation[];
}

export interface PersistedExpectationStoreOptions {
  readonly policy?: Partial<PersistedExpectationPolicy> | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Durable mirror of `VerificationExpectationBook`'s open set. See the file
 * header for the exact security property this enforces and the intended
 * wiring — this class does not itself decide whether an inbound message
 * matches anything.
 */
export class PersistedExpectationStore {
  private readonly store: PersistentStore<ExpectationSnapshot>;
  private readonly policy: PersistedExpectationPolicy;
  private readonly now: () => Date;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storeOrPath: PersistentStore<ExpectationSnapshot> | string, options: PersistedExpectationStoreOptions = {}) {
    this.store = typeof storeOrPath === 'string' ? new PersistentStore<ExpectationSnapshot>(storeOrPath) : storeOrPath;
    this.policy = { ...DEFAULT_PERSISTED_EXPECTATION_POLICY, ...(options.policy ?? {}) };
    this.now = options.now ?? (() => new Date());
  }

  getPolicy(): PersistedExpectationPolicy {
    return this.policy;
  }

  private async readWithDrops(now: Date): Promise<{ expectations: VerificationExpectation[]; malformed: number }> {
    const raw = await this.store.load();
    if (!raw || typeof raw !== 'object') return { expectations: [], malformed: 0 };
    const rawExpectations = Array.isArray(raw.expectations) ? raw.expectations : [];
    const expectations = rawExpectations
      .map((entry) => validatePersistedExpectation(entry, now))
      .filter((entry): entry is VerificationExpectation => entry !== null);
    return { expectations, malformed: rawExpectations.length - expectations.length };
  }

  private async mutate<T>(
    fn: (expectations: VerificationExpectation[], malformed: number, now: Date) => Promise<{ next: VerificationExpectation[]; result: T }>,
  ): Promise<T> {
    const now = this.now();
    const run = this.writeChain.then(async () => {
      const { expectations, malformed } = await this.readWithDrops(now);
      const { next, result } = await fn(expectations, malformed, now);
      await this.store.persist({ version: 1, expectations: next });
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Live, content-validated, unexpired expectations. Read-time filter — does
   * not persist the drop; `sweep()` does that. So a read between sweeps can
   * never hand back an expired or invalid record even though `sweep()`
   * has not run yet.
   */
  async list(): Promise<readonly VerificationExpectation[]> {
    const now = this.now();
    const { expectations } = await this.readWithDrops(now);
    return expectations.filter((e) => Date.parse(e.expiresAt) > now.getTime());
  }

  /**
   * Full mirror write. Re-validates every entry with the exact rules
   * `openExpectation` enforces before writing (defense in depth — the caller
   * is expected to pass `book.list()`, which is already valid, but this store
   * never trusts a write without checking it, the same as every read).
   * Invalid entries are silently dropped rather than persisted; this is a
   * mirror op, not a disclosure boundary, so no report is produced here —
   * `sweep()` is where drops from the FILE (not from the caller) are itemised.
   */
  async replaceAll(expectations: readonly VerificationExpectation[]): Promise<void> {
    const now = this.now();
    await this.mutate(async () => {
      const valid = expectations
        .map((entry) => validatePersistedExpectation(entry, now))
        .filter((entry): entry is VerificationExpectation => entry !== null)
        .filter((entry) => Date.parse(entry.expiresAt) > now.getTime());
      return { next: valid, result: undefined };
    });
  }

  /**
   * One housekeeping pass: drop malformed records, drop already-expired
   * records, and enforce `maxOpenExpectations` (oldest-by-`openedAt` first).
   * Returns the surviving set so a boot-time supervisor can hydrate the live
   * book from it. Idempotent and safe concurrently.
   */
  async sweep(trigger: HousekeepingTrigger = 'manual'): Promise<ExpectationSweepReport> {
    return this.mutate(async (expectations, malformed, now) => {
      const removed: ExpectationDiscard[] = [];
      if (malformed > 0) {
        removed.push({
          id: '(unreadable)',
          recipientAddress: '(unknown)',
          reason: 'malformed',
          removedAt: now.getTime(),
          note: `${String(malformed)} expectation record(s) failed content validation and were dropped`,
        });
      }

      const unexpired: VerificationExpectation[] = [];
      for (const expectation of expectations) {
        if (Date.parse(expectation.expiresAt) <= now.getTime()) {
          removed.push({ id: expectation.id, recipientAddress: expectation.recipientAddress, reason: 'expired', removedAt: now.getTime() });
          continue;
        }
        unexpired.push(expectation);
      }

      const sorted = [...unexpired].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
      const overflow = sorted.length - this.policy.maxOpenExpectations;
      const final: VerificationExpectation[] = [];
      for (let index = 0; index < sorted.length; index += 1) {
        const expectation = sorted[index];
        if (!expectation) continue;
        if (index < overflow) {
          removed.push({ id: expectation.id, recipientAddress: expectation.recipientAddress, reason: 'over-cap', removedAt: now.getTime() });
          continue;
        }
        final.push(expectation);
      }

      return {
        next: final,
        result: { sweptAt: now.getTime(), removed, retained: final.length, survivors: final } satisfies ExpectationSweepReport,
      };
    });
  }

  async runRecoverySweep(): Promise<ExpectationSweepReport> {
    return this.sweep('recovery');
  }
}
