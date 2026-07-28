/**
 * The seam that was missing: something that actually registers an expectation.
 *
 * `VerificationExpectationBook` is fully built and thoroughly tested.
 * `PersistedExpectationStore` gives it durability. The watcher delivers mail
 * and the matcher answers questions about it. And until this file, `grep` for
 * `openExpectation` across `packages/sdk/src` returned doc comments and the
 * declaration — no production call site — while `new VerificationExpectationBook`
 * appeared nowhere outside tests.
 *
 * So the chain was inert end to end: a signup began, nothing recorded that it
 * had, the verification mail arrived, the matcher correctly found no
 * expectation, and the message was correctly treated as unexpected and did
 * nothing. Every piece worked. There was no middle.
 *
 * Registration is an explicit verb, not an inference
 * ──────────────────────────────────────────────────
 * A workstream calls `open()` BEFORE it submits the signup form. Nothing
 * watches a page and decides an expectation should exist, and that is a
 * boundary rather than a preference: an expectation created by inference is
 * created **by content** — by the page being filled in, or by a heuristic
 * reading of it. That inverts the authority model the whole design rests on.
 * Expectations are created by the already-authorized workstream, in advance,
 * or "mail can satisfy an expectation but can never create work" is
 * decorative. A verb makes the authorization explicit and auditable: the model
 * was already authorized to do the work, it declares what it is about to
 * expect, and the daemon holds the record.
 *
 * What this file does NOT re-implement
 * ────────────────────────────────────
 * Nearly everything. `openExpectation` already clamps the window to
 * `MAX_VERIFICATION_WINDOW_MS`, enforces `MAX_OPEN_EXPECTATIONS`, normalizes
 * and validates the domain, recipient and purpose, replaces rather than stacks
 * a second expectation for one address, and refuses outright if email ever
 * gained command authority. `hydrateExpectation` re-validates a persisted
 * record and returns null for anything expired or over cap. This composes
 * those; it does not restate them, and it must not — a second copy of a
 * clamp is a second clamp that can drift from the first.
 *
 * An expiry is an outcome, not silence
 * ────────────────────────────────────
 * An expectation that runs out is a signup whose verification never arrived,
 * which is a fact the workstream and the owner need. `sweep()` reports every
 * expiry through `onExpired` with a named reason. The same rule as a terminal
 * capability failure: tell him rather than go quiet.
 */

import {
  MAX_VERIFICATION_WINDOW_MS,
  VerificationExpectationBook,
  type OpenExpectationInput,
  type SurfaceAuthorityProbe,
  type VerificationExpectation,
  type VerificationMatch,
} from '../../google/verification-expectations.js';
import { surfaceHasCommandAuthority } from '../../security/untrusted-content.js';
import type { PersistedExpectationStore } from './expectation-store.js';

/**
 * The book's own `matchCandidate`, so the signature below is projected off the
 * real method rather than restated beside it.
 *
 * This preserves what the previous `Pick<VerificationExpectationBook,
 * 'matchCandidate'>` was there for, and that rule is worth keeping written
 * down: the first draft declared `matchCandidate(email, now?: Date)` by hand
 * and got it wrong — the book's `now` is required — so the narrowed view
 * described a method the book does not have, and every caller through it would
 * have been type-checked against fiction. `Parameters<>` and `ReturnType<>`
 * cannot drift from what they project any more than a `Pick` could.
 */
type BookMatchCandidate = VerificationExpectationBook['matchCandidate'];

/**
 * The match-only view of the book that inbound code is given.
 *
 * `openExpectation` and `hydrateExpectation` are absent from the type, so a
 * call to either does not compile — and, since the registry now hands over a
 * purpose-built object rather than the book itself, they are absent at runtime
 * too. That is the same reasoning that removes `trySpawnAgent` from the
 * inbound context, applied to the other capability an arriving message must
 * never reach: an earlier draft handed the inbound path the whole book, which
 * would have made inbound code structurally able to register an expectation —
 * the exact thing §2 forbids.
 *
 * WHY IT IS NO LONGER THE BOOK ITSELF. `matchCandidate` mutates: a `matched`
 * answer spends the grant, an `expired` one deletes it on the way out, and the
 * no-match path sweeps every elapsed expectation. `expectation-store.ts`'s own
 * header names "open, close, **consuming match**" as the three book mutations
 * that must be mirrored to disk, and the consuming match — the only one the
 * inbound path actually causes — was the one nothing wrote through. Handing
 * over the raw book is what made that unfixable: there was no seam between the
 * mutation and the caller to put the write in.
 */
export interface ExpectationMatcher {
  /**
   * Ask whether a message satisfies something already open, and mirror to disk
   * whatever asking changed, before the answer comes back.
   *
   * Called with `{ consume: false }` by the intake — see `consumeMatch`.
   */
  matchCandidate(...args: Parameters<BookMatchCandidate>): Promise<ReturnType<BookMatchCandidate>>;
  /**
   * Spend the grant a `matched` answer named, and write that through.
   *
   * Takes the MATCH, not an id: the caller can only spend the expectation the
   * book itself just handed it, and has no way to name any other. Anything
   * that is not a `matched` result is a no-op.
   *
   * Separate from `matchCandidate` so the intake can decide the outcome,
   * announce it and record it BEFORE the grant is spent — a pass that throws
   * part-way then leaves the book exactly as it found it, and the redelivery
   * correlates again instead of reporting the owner's own verification mail as
   * unsolicited. `intake.ts` states why that ordering is the fix rather than a
   * second durable store of matches.
   */
  consumeMatch(match: VerificationMatch): Promise<void>;
}

/** An expectation whose window ran out without a matching message arriving. */
export interface ExpectationExpiryReport {
  readonly id: string;
  readonly serviceDomain: string;
  readonly recipientAddress: string;
  readonly purpose: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  /** Named, so a consumer branches on the reason rather than parsing prose. */
  readonly reason: 'window-elapsed';
  /** One sentence for a person. */
  readonly detail: string;
}

/** An open expectation as the disclosure verb reports it. */
export interface DisclosedExpectation extends VerificationExpectation {
  /** Milliseconds left before it expires. Never negative. */
  readonly remainingMs: number;
}

export interface InboundExpectationRegistryOptions {
  /** Durability. Every mutation is written through to it. */
  readonly store: PersistedExpectationStore;
  /**
   * The authority probe. Defaults to the REAL one.
   *
   * §2.2: the book's own defensive check — refuse to open an expectation if
   * email ever gained command authority — has never run in production,
   * because the book has never been constructed in production. Defaulting to
   * the real predicate is what takes it off the shelf.
   */
  readonly authority?: SurfaceAuthorityProbe | undefined;
  readonly now?: (() => Date) | undefined;
  /** Default window when a caller names none. Clamped by the book. */
  readonly defaultWindowMs?: number | undefined;
  /** Where an elapsed window is reported. */
  readonly onExpired?: ((report: ExpectationExpiryReport) => void) | undefined;
}

/**
 * Production ownership of the expectation book: construct it, persist it,
 * bring it back after a restart, and report what runs out.
 */
export class InboundExpectationRegistry {
  private readonly book: VerificationExpectationBook;
  private readonly store: PersistedExpectationStore;
  private readonly now: () => Date;
  private readonly defaultWindowMs: number | undefined;
  private readonly onExpired: ((report: ExpectationExpiryReport) => void) | undefined;
  private readonly view: ExpectationMatcher;

  constructor(options: InboundExpectationRegistryOptions) {
    this.book = new VerificationExpectationBook(
      options.authority ?? { surfaceHasCommandAuthority },
    );
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.defaultWindowMs = options.defaultWindowMs;
    this.onExpired = options.onExpired;
    this.view = {
      matchCandidate: async (...args) => {
        const match = this.book.matchCandidate(...args);
        // Written through UNCONDITIONALLY rather than only for the kinds
        // believed to mutate. Predicting which ones do would couple this line
        // to the order of the book's internal early returns — and a wrong
        // prediction is precisely the silent miss this fix exists to close.
        // A question that changed nothing costs one mirror write of unchanged
        // content; the intake already writes a record per message.
        await this.persist();
        return match;
      },
      consumeMatch: async (match) => {
        if (match.kind !== 'matched') return;
        if (this.book.closeExpectation(match.expectation.id) === null) return;
        await this.persist();
      },
    };
  }

  /**
   * The match-only view. Handed to the inbound path; the book itself is not.
   *
   * A purpose-built object rather than the book, so `openExpectation` and
   * `hydrateExpectation` are unreachable at runtime as well as unnameable in
   * the type — and so every book mutation the inbound path can cause has a
   * seam to be mirrored to disk from. See `ExpectationMatcher`.
   *
   * One object, built once, so its identity is stable across reads.
   */
  get matcher(): ExpectationMatcher {
    return this.view;
  }

  /**
   * Bring back what a restart interrupted.
   *
   * The daemon checks for updates hourly and restarts itself at idle, so a
   * signup begun at 14:58 with a restart at 15:00 would otherwise lose its
   * expectation and the verification mail would arrive inert — the exact
   * failure this capability exists to eliminate, caused by our own update
   * mechanism.
   *
   * Restored records keep their ORIGINAL absolute expiry. A restart cannot
   * extend a grant, which is what the in-memory-only design was protecting;
   * anything already past its window is dropped by `hydrateExpectation`
   * rather than revived, and is reported as an expiry like any other.
   */
  async hydrate(): Promise<{ readonly restored: number; readonly dropped: number }> {
    const sweep = await this.store.runRecoverySweep();
    const now = this.now();
    let restored = 0;
    for (const survivor of sweep.survivors) {
      if (this.book.hydrateExpectation(survivor, now) !== null) restored += 1;
    }
    // The file may have held records the book refused (expired mid-restart,
    // over cap, malformed). Persist what is actually live so disk and memory
    // agree from the first moment rather than at the first mutation.
    await this.persist();
    return { restored, dropped: sweep.survivors.length - restored };
  }

  /**
   * Register an expectation before the signup form is submitted.
   *
   * Every bound — the window ceiling, the open-expectation cap, the refusal
   * when email holds command authority — is the book's, deliberately not
   * re-checked here.
   */
  async open(input: {
    readonly serviceDomain: string;
    readonly recipientAddress: string;
    readonly purpose: string;
    readonly windowMs?: number | undefined;
    readonly kind?: 'signup' | 'login' | undefined;
  }): Promise<VerificationExpectation> {
    const windowMs = input.windowMs ?? this.defaultWindowMs;
    const request: OpenExpectationInput = {
      serviceDomain: input.serviceDomain,
      recipientAddress: input.recipientAddress,
      purpose: input.purpose,
      now: this.now(),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(windowMs === undefined ? {} : { windowMs }),
    };
    const expectation = this.book.openExpectation(request);
    await this.persist();
    return expectation;
  }

  /** Open expectations with their remaining window, for disclosure. */
  list(): readonly DisclosedExpectation[] {
    const now = this.now().getTime();
    return this.book.list(this.now()).map((expectation) => ({
      ...expectation,
      remainingMs: Math.max(0, Date.parse(expectation.expiresAt) - now),
    }));
  }

  /**
   * Close an expectation the workstream no longer wants.
   *
   * A signup abandoned before submission should not leave an expectation
   * sitting until it expires: it occupies one of the thirty-two slots, and it
   * is a live correlation key for an address nobody is waiting on.
   */
  async cancel(id: string): Promise<VerificationExpectation | null> {
    const closed = this.book.closeExpectation(id);
    if (closed !== null) await this.persist();
    return closed;
  }

  /**
   * Retire everything past its window, reporting each one.
   *
   * Returns the reports as well as emitting them, so a caller that wants the
   * batch does not have to accumulate through the callback.
   */
  async sweep(): Promise<readonly ExpectationExpiryReport[]> {
    const now = this.now();
    const expired = this.book.sweepExpired(now);
    const reports = expired.map((expectation) => describeExpiry(expectation));
    if (expired.length > 0) await this.persist();
    for (const report of reports) {
      try {
        this.onExpired?.(report);
      } catch {
        // A reporting route that throws must not strand the sweep: the
        // remaining expectations still have to be retired.
      }
    }
    return reports;
  }

  /** The hard ceiling a caller cannot exceed by asking. Re-exported for callers. */
  static get maxWindowMs(): number {
    return MAX_VERIFICATION_WINDOW_MS;
  }

  private async persist(): Promise<void> {
    await this.store.replaceAll(this.book.list(this.now()));
  }
}

function describeExpiry(expectation: VerificationExpectation): ExpectationExpiryReport {
  return {
    id: expectation.id,
    serviceDomain: expectation.serviceDomain,
    recipientAddress: expectation.recipientAddress,
    purpose: expectation.purpose,
    openedAt: expectation.openedAt,
    expiresAt: expectation.expiresAt,
    reason: 'window-elapsed',
    detail:
      `No verification mail for ${expectation.purpose} arrived at `
      + `${expectation.recipientAddress} from ${expectation.serviceDomain} before the `
      + `window closed at ${expectation.expiresAt}. The expectation is closed; a `
      + 'message arriving now will be treated as unexpected.',
  };
}
