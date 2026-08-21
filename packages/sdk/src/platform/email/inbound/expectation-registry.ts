/**
 * The seam that was missing: something that actually registers an expectation.
 *
 * `VerificationExpectationBook` is fully built and thoroughly tested.
 * `PersistedExpectationStore` gives it durability. The watcher delivers mail
 * and the matcher answers questions about it. And until this file, `grep` for
 * `openExpectation` across `packages/sdk/src` returned doc comments and the
 * declaration, no production call site, while `new VerificationExpectationBook`
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
 * created **by content**, by the page being filled in, or by a heuristic
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
 * those; it does not restate them, and it must not, a second copy of a
 * clamp is a second clamp that can drift from the first.
 *
 * An expiry is an outcome, not silence
 * ────────────────────────────────────
 * An expectation that runs out is a signup whose verification never arrived,
 * which is a fact the workstream and the owner need. `sweep()` reports every
 * expiry through `onExpired` with a named reason. The same rule as a terminal
 * capability failure: tell them rather than go quiet.
 *
 * And a report nothing asks for is that silence with more code in it.
 * `sweep()` had exactly one caller repo-wide, its own test, while `onExpired`
 * WAS wired, in `facade-inbound-mail.ts`. So the handler that announces an
 * expiry existed and could never fire, and a signup whose verification never
 * arrived was reported to nobody: the record sat in the book until something
 * else happened to touch it. `startSweeping()` below is what makes the
 * reporting real. It is armed from the composition root beside the
 * housekeeper's own timer and NOT from the supervisor's start, because an
 * expectation can be opened through `email.expectation.open` while no source is
 * running at all, which is precisely the case where nothing else would ever
 * reap it.
 *
 * "Nothing came" and "we could no longer look" are different facts
 * ───────────────────────────────────────────────────────────────
 * An expectation is a promise to watch a mailbox for fifteen minutes. That
 * promise is only keepable while the mailbox can actually be read, so this
 * file takes a capability probe (§3.4b) and uses it in two places:
 *
 *  - `open()` REFUSES against a mailbox already known unreadable, at open
 *    time. The signup workstream needs that answer before it submits the form,
 *    not fifteen minutes later in the shape of a silence it cannot tell from
 *    "the mail never arrived".
 *  - `capabilityChanged()` fails expectations that were already open when the
 *    mailbox became unreadable, with `reason: 'capability-lost'`. Letting them
 *    lapse into `window-elapsed` would tell the owner "nothing came" when the
 *    truth is "we stopped being able to look", the same sentence for two
 *    conditions with opposite fixes.
 *
 * And the distinction that keeps that mechanism from becoming a defect of its
 * own: **a watcher in reconnect backoff is "not yet", not "cannot".** A
 * `degraded` verdict, reconnecting, polling because the server offers no
 * push, a server refusing connections under load, fails NOTHING, because
 * recovery fetches everything above the cursor and the mail is still coming.
 * Only `insufficient`, a refused credential, a mailbox that will not open,
 * means the window cannot be honoured. An unknown verdict (`null`, before the
 * watcher has probed anything) fails nothing either: absence of an answer is
 * not an answer of absence.
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
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { PersistedExpectationStore } from './expectation-store.js';
import type { InboundCapabilityReason, InboundCapabilityVerdict } from './ports.js';

/**
 * How often the registry re-checks for expectations that have run out, given
 * the default window in force.
 *
 * Derived from the window rather than fixed, because the two numbers are the
 * same promise seen from opposite ends: a fifteen-minute window swept hourly
 * would report an expiry forty-five minutes after it happened, and a
 * one-minute window swept every thirty seconds would report half of them late.
 * A thirtieth of the window keeps the lateness proportional to the promise.
 *
 * Clamped at both ends for reasons that have nothing to do with the window.
 * The floor stops a one-minute window from arming a two-second timer, which
 * would be a wake-up every two seconds for the life of the daemon to reap a
 * list that is empty almost always. The ceiling stops the hour-long maximum
 * window from pushing the cadence past a minute, because this interval is also
 * how LATE the owner hears about an expiry: `sweep()` is the only path that
 * turns an elapsed window into an `onExpired` report, and no read produces one,
 * so nothing else ever will. What a slow cadence costs is the announcement and
 * not the accuracy, `list()` and `hasOpen()` answer correctly the whole time,
 * because an elapsed expectation is filtered out of a read rather than waiting
 * for a sweep to remove it.
 */
export function expectationSweepIntervalMs(defaultWindowMs: number): number {
  const window = Number.isFinite(defaultWindowMs) && defaultWindowMs > 0
    ? defaultWindowMs
    : MAX_VERIFICATION_WINDOW_MS;
  return Math.max(5_000, Math.min(60_000, Math.floor(window / 30)));
}

/**
 * The book's own `matchCandidate`, so the signature below is projected off the
 * real method rather than restated beside it.
 *
 * This preserves what the previous `Pick<VerificationExpectationBook,
 * 'matchCandidate'>` was there for, and that rule is worth keeping written
 * down: the first draft declared `matchCandidate(email, now?: Date)` by hand
 * and got it wrong, the book's `now` is required, so the narrowed view
 * described a method the book does not have, and every caller through it would
 * have been type-checked against fiction. `Parameters<>` and `ReturnType<>`
 * cannot drift from what they project any more than a `Pick` could.
 */
type BookMatchCandidate = VerificationExpectationBook['matchCandidate'];

/**
 * The match-only view of the book that inbound code is given.
 *
 * `openExpectation` and `hydrateExpectation` are absent from the type, so a
 * call to either does not compile, and, since the registry now hands over a
 * purpose-built object rather than the book itself, they are absent at runtime
 * too. That is the same reasoning that removes `trySpawnAgent` from the
 * inbound context, applied to the other capability an arriving message must
 * never reach: an earlier draft handed the inbound path the whole book, which
 * would have made inbound code structurally able to register an expectation,
 * the exact thing §2 forbids.
 *
 * WHY IT IS NO LONGER THE BOOK ITSELF. `matchCandidate` mutates: a `matched`
 * answer spends the grant, an `expired` one deletes it on the way out, and the
 * no-match path sweeps every elapsed expectation. `expectation-store.ts`'s own
 * header names "open, close, **consuming match**" as the three book mutations
 * that must be mirrored to disk, and the consuming match, the only one the
 * inbound path actually causes, was the one nothing wrote through. Handing
 * over the raw book is what made that unfixable: there was no seam between the
 * mutation and the caller to put the write in.
 */
export interface ExpectationMatcher {
  /**
   * Ask whether a message satisfies something already open, and mirror to disk
   * whatever asking changed, before the answer comes back.
   *
   * Called with `{ consume: false }` by the intake, see `consumeMatch`.
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
   * announce it and record it BEFORE the grant is spent, a pass that throws
   * part-way then leaves the book exactly as it found it, and the redelivery
   * correlates again instead of reporting the owner's own verification mail as
   * unsolicited. `intake.ts` states why that ordering is the fix rather than a
   * second durable store of matches.
   */
  consumeMatch(match: VerificationMatch): Promise<void>;
}

/**
 * Why an expectation ended without a matching message.
 *
 *  - `window-elapsed`, the fifteen minutes ran out. The mailbox was being
 *    read the whole time and nothing arrived.
 *  - `capability-lost`, the mailbox stopped being readable while the window
 *    was open, so the daemon cannot say whether anything arrived.
 *
 * Two reasons rather than one because they have opposite fixes: the first is
 * "re-request the mail", the second is "repair the mailbox". Collapsing them
 * sends the owner to look for a message that may well have been delivered.
 */
export type ExpectationExpiryReason = 'window-elapsed' | 'capability-lost';

/** An expectation that ended without a matching message arriving. */
export interface ExpectationExpiryReport {
  readonly id: string;
  readonly serviceDomain: string;
  readonly recipientAddress: string;
  readonly purpose: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  /** Named, so a consumer branches on the reason rather than parsing prose. */
  readonly reason: ExpectationExpiryReason;
  /**
   * The watcher reason behind a `capability-lost` ending, absent otherwise.
   *
   * Carried as a field rather than left inside `detail` for the same reason
   * `reason` is: a consumer that needs to know whether this was a credential
   * or a folder name must not have to read English to find out.
   */
  readonly capabilityReason?: InboundCapabilityReason | undefined;
  /** One sentence for a person. */
  readonly detail: string;
}

/**
 * What the registry asks before it promises to watch a mailbox.
 *
 * `null` means nothing has probed yet, which is NOT the same as "the mailbox
 * is fine" and NOT the same as "the mailbox is broken". It is treated as
 * permission to proceed, because refusing on a question nobody has asked yet
 * would make every expectation opened before the watcher's first connection
 * fail for a condition that may not exist.
 */
export type ExpectationCapabilityProbe = () => InboundCapabilityVerdict | null;

/**
 * The refusal `open()` raises when the mailbox cannot be read.
 *
 * A distinct class rather than a message a caller has to pattern-match:
 * this is a statement about the machine's condition, not about the request,
 * and the gateway verb has to answer it with a different status from the
 * caller-error refusals the book raises. Substring-matching prose to tell the
 * two apart is how a reworded sentence silently changes an HTTP status.
 */
export class ExpectationMailboxUnreadableError extends Error {
  readonly capability: InboundCapabilityVerdict;

  constructor(message: string, capability: InboundCapabilityVerdict) {
    super(message);
    this.name = 'ExpectationMailboxUnreadableError';
    this.capability = capability;
  }
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
   * §2.2: the book's own defensive check, refuse to open an expectation if
   * email ever gained command authority, has never run in production,
   * because the book has never been constructed in production. Defaulting to
   * the real predicate is what takes it off the shelf.
   */
  readonly authority?: SurfaceAuthorityProbe | undefined;
  /**
   * Whether the mailbox an expectation would be satisfied from can be read
   * right now (§3.4b). Omitted means "never ask", which is the behaviour a
   * caller that has no watcher wants; it is not a default of "healthy".
   */
  readonly capability?: ExpectationCapabilityProbe | undefined;
  readonly now?: (() => Date) | undefined;
  /** Default window when a caller names none. Clamped by the book. */
  readonly defaultWindowMs?: number | undefined;
  /** Where an ended expectation is reported, elapsed or capability-lost. */
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
  private readonly capability: ExpectationCapabilityProbe | undefined;
  private readonly view: ExpectationMatcher;
  /**
   * The probe the book was built with, exposed so the boot wiring can be
   * asserted rather than assumed.
   *
   * §12 gate #25 is "the expectation book is instantiated in production with a
   * REAL authority probe". Nothing observable distinguished the genuine
   * predicate from a permissive stub, because both answer `false` for email,
   * the difference only shows on a surface that DOES hold command authority.
   * This getter is what lets a test ask.
   */
  private readonly authorityProbe: SurfaceAuthorityProbe;
  /** The periodic sweep, once armed. Null while nothing is scheduled. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InboundExpectationRegistryOptions) {
    this.authorityProbe = options.authority ?? { surfaceHasCommandAuthority };
    this.book = new VerificationExpectationBook(this.authorityProbe);
    this.capability = options.capability;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.defaultWindowMs = options.defaultWindowMs;
    this.onExpired = options.onExpired;
    this.view = {
      matchCandidate: async (...args) => {
        const match = this.book.matchCandidate(...args);
        // Written through UNCONDITIONALLY rather than only for the kinds
        // believed to mutate. Predicting which ones do would couple this line
        // to the order of the book's internal early returns, and a wrong
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
   * the type, and so every book mutation the inbound path can cause has a
   * seam to be mirrored to disk from. See `ExpectationMatcher`.
   *
   * One object, built once, so its identity is stable across reads.
   */
  get matcher(): ExpectationMatcher {
    return this.view;
  }

  /**
   * The authority probe this registry's book is actually using.
   *
   * Read-only, and read by the boot-wiring gate: a composition that swapped in
   * a stub would answer `false` for every surface, including `owner-direct`,
   * and the real predicate does not.
   */
  get authority(): SurfaceAuthorityProbe {
    return this.authorityProbe;
  }

  /** The capability verdict in force, or `null` when nothing has probed. */
  get capabilityVerdict(): InboundCapabilityVerdict | null {
    return this.capability?.() ?? null;
  }

  /**
   * Bring back what a restart interrupted.
   *
   * The daemon checks for updates hourly and restarts itself at idle, so a
   * signup begun at 14:58 with a restart at 15:00 would otherwise lose its
   * expectation and the verification mail would arrive inert, the exact
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
   * Every bound, the window ceiling, the open-expectation cap, the refusal
   * when email holds command authority, is the book's, deliberately not
   * re-checked here.
   *
   * The ONE check this file adds is the capability one (§12 gate #31), and it
   * belongs here rather than in the book: the book knows about authority and
   * windows, and knows nothing about whether a mailbox opens. Refusing now is
   * the whole point, a workstream that learns at open time can pick another
   * route, and a workstream that learns from a fifteen-minute silence has
   * already lost the fifteen minutes and cannot tell the silence apart from
   * "the service never sent it".
   */
  async open(input: {
    readonly serviceDomain: string;
    readonly recipientAddress: string;
    readonly purpose: string;
    readonly windowMs?: number | undefined;
    readonly kind?: 'signup' | 'login' | undefined;
  }): Promise<VerificationExpectation> {
    const verdict = this.capability?.() ?? null;
    // `insufficient` ONLY. A degraded watcher, reconnecting, polling because
    // the server offers no push, still delivers, just later, and refusing a
    // signup over a reconnect that resolves in three seconds would be this
    // check causing the outage it exists to report.
    if (verdict !== null && verdict.state === 'insufficient') {
      throw new ExpectationMailboxUnreadableError(
        `Refusing to expect verification mail for ${input.purpose} at `
        + `${input.recipientAddress}: the mailbox cannot be read (${verdict.reason}). `
        + `${verdict.detail} ${verdict.fix} Until that is fixed, a verification message `
        + 'would arrive and go unseen, so the expectation is refused now rather than '
        + 'left to run out in silence.',
        verdict,
      );
    }
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

  /**
   * Whether anything is being waited on right now.
   *
   * For the callers that want a boolean and nothing else, the Gmail source's
   * poll-cadence predicate is the one this exists for. It asks before every
   * sleep, which at the shipped `gmailPollSecondsExpecting` is every five
   * seconds for as long as a signup is mid-flight.
   *
   * That predicate used to be `expectations.list().length > 0`, and the length
   * was the harmless half. `list()` reached `VerificationExpectationBook.list`,
   * which called `sweepExpired` and discarded what it removed, so the fast
   * probe REAPED the expectation that had just run out and threw the record of
   * it away, and `sweep()` (every thirty seconds at the shipped window, and the
   * only path that maps an expiry through `describeExpiry`, persists it and
   * fires `onExpired`) arrived to find nothing left to report. A verification
   * that never came ended in silence, the single outcome `onExpired` and
   * `startSweeping` exist to make impossible.
   *
   * So this asks the book a question and changes nothing: `book.hasOpen`
   * filters where `book.list` used to reap. It is not merely cheaper than
   * building the list; it is the reason the reporting path still has something
   * to report.
   */
  hasOpen(): boolean {
    return this.book.hasOpen(this.now());
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
    this.report(reports);
    return reports;
  }

  /**
   * Sweep on an interval, so an expiry is reported when it happens rather than
   * whenever something else next touches the book.
   *
   * Not optional wiring, and not a convenience. `sweep()` is the only thing
   * that turns an elapsed window into an `onExpired` report, and with no caller
   * the whole "an expiry is an outcome, not silence" property above was
   * unreachable, the one component built to stop a signup dying quietly was
   * itself dying quietly. Idempotent: a second call replaces the first timer
   * rather than adding one, so a re-arm cannot leave two sweeps running.
   *
   * There is deliberately NO in-flight guard, and that is a decision rather
   * than an omission. One was written here and then removed, because no test
   * could be made to fail without it: `sweep()` takes what it reaps out of the
   * book SYNCHRONOUSLY (`book.sweepExpired`) and only then awaits the disk
   * write, so a tick landing during a slow write finds an empty list, reports
   * nothing, and writes nothing. A guard against that would be defensive code
   * whose absence nothing can detect, which is the same unfalsifiable shape as
   * the dead paths this round exists to remove. If `sweep()` ever awaits before
   * it takes the records, this needs revisiting and this paragraph is the
   * reason why.
   *
   * The timer is unref'd, so it never by itself keeps the process alive.
   */
  startSweeping(intervalMs: number): void {
    this.stopSweeping();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        // `sweep()` already swallows a throwing `onExpired` per report, so
        // reaching here means the book or the store write broke. Logged rather
        // than discarded: a sweep that has stopped working is a daemon that has
        // gone back to never reporting an expiry, which is the exact condition
        // this timer exists to end.
        logger.error('The inbound-mail expectation sweep failed', {
          surface: 'email-inbound',
          detail: summarizeError(error),
        });
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop the periodic sweep. Safe to call when nothing is armed. */
  stopSweeping(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * The watcher's capability changed. Fail what can no longer be honoured, and
   * nothing else (§12 gates #32 and #33).
   *
   * Three answers, and the middle one is the one that must not be got wrong:
   *
   *  - `insufficient`, the mailbox cannot be read. Every open expectation is
   *    closed with `capability-lost`, because the promise behind it was "we
   *    are watching", and we are not.
   *  - `degraded`, reconnecting, backing off, polling instead of pushing.
   *    **Nothing is failed.** "Not yet" is not "cannot": the reconnect fetches
   *    everything above the cursor, so a message that arrives during a backoff
   *    is delivered when the socket comes back and still satisfies its
   *    expectation. Failing here would close a live expectation seconds before
   *    the mail it was waiting for landed.
   *  - `healthy`, nothing to do.
   *
   * Idempotent: called on every transition, including repeats of the same
   * verdict, and a second `insufficient` with nothing open reports nothing.
   */
  async capabilityChanged(
    verdict: InboundCapabilityVerdict,
  ): Promise<readonly ExpectationExpiryReport[]> {
    if (verdict.state !== 'insufficient') return [];
    const now = this.now();
    const open = this.book.list(now);
    if (open.length === 0) return [];
    const reports = open.map((expectation) => describeCapabilityLoss(expectation, verdict));
    for (const expectation of open) this.book.closeExpectation(expectation.id);
    await this.persist();
    this.report(reports);
    return reports;
  }

  /** The hard ceiling a caller cannot exceed by asking. Re-exported for callers. */
  static get maxWindowMs(): number {
    return MAX_VERIFICATION_WINDOW_MS;
  }

  private async persist(): Promise<void> {
    await this.store.replaceAll(this.book.list(this.now()));
  }

  /** Emit each report, never letting one broken route strand the rest. */
  private report(reports: readonly ExpectationExpiryReport[]): void {
    for (const report of reports) {
      try {
        this.onExpired?.(report);
      } catch {
        // A reporting route that throws must not strand the pass: the
        // remaining expectations still have to be retired.
      }
    }
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

/**
 * The report for an expectation the daemon stopped being able to honour.
 *
 * Deliberately worded so it cannot be read as "the mail never came". The
 * daemon does not know whether it came; it knows it stopped being able to
 * look, which is a different thing to tell somebody and a different thing to
 * fix.
 */
function describeCapabilityLoss(
  expectation: VerificationExpectation,
  verdict: InboundCapabilityVerdict,
): ExpectationExpiryReport {
  return {
    id: expectation.id,
    serviceDomain: expectation.serviceDomain,
    recipientAddress: expectation.recipientAddress,
    purpose: expectation.purpose,
    openedAt: expectation.openedAt,
    expiresAt: expectation.expiresAt,
    reason: 'capability-lost',
    capabilityReason: verdict.reason,
    detail:
      `The mailbox stopped being readable while waiting for verification mail for `
      + `${expectation.purpose} at ${expectation.recipientAddress} from `
      + `${expectation.serviceDomain} (${verdict.reason}). ${verdict.detail} ${verdict.fix} `
      + 'This is NOT "nothing arrived", the message may well have been delivered and '
      + 'gone unseen. The expectation is closed; re-open it once the mailbox reads '
      + 'again, or complete the verification another way.',
  };
}
