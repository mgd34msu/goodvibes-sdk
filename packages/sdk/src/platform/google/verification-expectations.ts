/**
 * Scoped email-verification expectations.
 *
 * ── The rule this module carves a hole in ─────────────────────────────────────────
 *
 * Email is an input-only surface with NO command authority. Content arriving by email
 * is evidence, never instruction; it cannot start work, approve work, or confirm work.
 *
 * The ONE exception is a verification email that the agent itself provoked by starting a
 * signup. Even then the email is not a directive: the only thing it can establish is
 * "whoever controls this address received this token". The hole is kept exactly that
 * small by four structural constraints, all enforced below:
 *
 *   1. No open expectation -> nothing is ever extracted. Unsolicited "verify your
 *      account" mail gets no treatment at all.
 *   2. Correlation is keyed on the RECIPIENT address the agent minted for that one
 *      signup, exactly. A mail for the right service at the wrong address is refused.
 *   3. The sender / service is corroboration only. It can never, on its own, produce a
 *      match; it is reported alongside the decision and gates nothing.
 *   4. Expectations are short-lived and single-use: they expire on success, on timeout,
 *      and on explicit close.
 *
 * Extraction returns exactly one artifact, a verification link or a verification code.
 * Everything else in the body is returned only as clearly-labelled untrusted display
 * text that no decision path reads.
 *
 * This module decides and returns. It never navigates, fetches, or sends anything.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_EXPECTATION_ID_CHARS,
  normalizeExpectationId,
} from './verification-expectation-id.js';
import { normalizeDomain, normalizeEmailAddress } from './signup-address.js';
import { describeDeliveryEvidence, type DeliveredRecipient } from './delivery-evidence.js';
import { hostMatchesServiceDomain } from './verification-extraction.js';
import type { AuthoritySurface } from '../security/untrusted-content.js';
import { registrableDomain } from '../security/public-suffix.js';

/**
 * Message PARSING lives in `verification-extraction.ts` and is re-exported here
 * unchanged, so every existing import keeps working and nothing had to move in
 * `google/index.ts`.
 *
 * It moved because this file sat at the eight-hundred-line cap exactly, and the
 * fix that stopped a read from reaping an expectation, with the explanation of
 * why that mattered, could not be added without breaking that gate. The line
 * the split falls on is a real one: the book decides which expectation a
 * message satisfies, and the extraction module decides what a satisfied message
 * yields. Neither can do the other's job, which is why the whole extraction
 * section could leave without a single caller changing.
 */
export {
  extractVerification,
  hostMatchesServiceDomain,
} from './verification-extraction.js';
export type {
  VerificationArtifact,
  VerificationExtraction,
} from './verification-extraction.js';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

/**
 * What the agent is doing right now that makes this mail expected.
 *
 * Owner's distinction, and the whole point of the book: "there's a big
 * difference between using a link in a verification email for an account we're
 * creating vs a fake verification email for a service we're already signed up
 * for or didn't request a login."
 *
 *  - `signup`, the agent is creating an account. Correlation is strongest
 *    here: the alias was minted for this one service, so mail arriving at it is
 *    almost certainly from that service.
 *  - `login` , the agent is authenticating to an account that already exists,
 *    and the service is sending a code or magic link. Correlation is WEAKER,
 *    because the address is the one already registered with that service and
 *    tells you much less. The compensations are elsewhere in this module:
 *    an exact-domain link check rather than a subdomain-tolerant one, a window
 *    measured from the submission rather than a generous default, and a hard
 *    stop on ambiguity.
 *
 * There is no third kind, deliberately. Everything else that looks like
 * verification mail, a password reset nobody asked for, a security alert, an
 * MFA prompt for an unrelated login, account recovery, an invoice, is
 * human-only, permanently. No agent-initiated flow needs it, and it is exactly
 * what a phisher sends.
 */
export type VerificationExpectationKind = 'signup' | 'login';

export interface VerificationExpectation {
  readonly id: string;
  /** Which agent-initiated action opened this. See VerificationExpectationKind. */
  readonly kind: VerificationExpectationKind;
  /** The domain the agent actually signed up at. Link hosts are validated against this. */
  readonly serviceDomain: string;
  /** The exact alias the agent handed to the signup form. */
  readonly recipientAddress: string;
  readonly purpose: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  /**
   * Constant reminder, carried on the record itself: matching this expectation grants no
   * command authority. It only establishes control of `recipientAddress`.
   */
  readonly authority: 'evidence-only';
}

export interface OpenExpectationInput {
  /** Defaults to `signup`, the original and stricter-correlating case. */
  readonly kind?: VerificationExpectationKind | undefined;
  readonly serviceDomain: string;
  readonly recipientAddress: string;
  readonly purpose: string;
  /**
   * Window length. Defaults to 15 minutes; clamped to the hard maximum below.
   *
   * Spelled `| undefined` to match `kind` above. Under
   * `exactOptionalPropertyTypes` the bare `?:` form accepts an ABSENT property
   * but refuses one explicitly set to `undefined`, so a caller assembling this
   * from optional inputs (`{ ...base, windowMs: maybeWindow }`) was refused
   * here while the identical shape for `kind` was accepted. The optionals in
   * one interface disagreed about that; now they agree.
   */
  readonly windowMs?: number | undefined;
  readonly now?: Date | undefined;
  /** Injected id, for deterministic tests. */
  readonly id?: string | undefined;
}

/** The minimum an inbound message must present to be considered. */
export interface CandidateEmail {
  readonly messageId: string;
  /** Sender address as delivered. Corroborating signal only, never a gate. */
  readonly from: string;
  /**
   * Proof of which address this message actually arrived at, the correlation
   * key, and the only field that gates a match.
   *
   * Typed as `DeliveredRecipient` rather than `string` on purpose: the brand
   * makes it impossible to pass a value taken from a `To:`/`Cc:`/`Bcc:`
   * header, which the sender controls and can trivially forge to name an open
   * expectation. `null` means the message carried no delivery evidence, and
   * that is refused rather than guessed at.
   */
  readonly deliveredTo: DeliveredRecipient | null;
  /**
   * The `To:` header, verbatim. **Display only, never evidence.** Kept so a
   * refusal can show the reader what the message claimed alongside where it
   * actually landed, which is what makes a forgery legible.
   */
  readonly toHeaderClaim: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * The one surface-authority predicate this module needs.
 *
 * `surface` is `AuthoritySurface`, imported from the module that owns the
 * union, not the `string` it used to be. The old signature was a narrow local
 * mirror whose own comment pointed at `src/agent/surface-authority.ts`, a
 * path that does not exist; the predicate lives in
 * `platform/security/untrusted-content.ts`. So the mirror had already drifted
 * from a file it named incorrectly, and typing the parameter as `string` made
 * the REAL implementation unassignable to it: a function accepting only
 * `AuthoritySurface` cannot stand where one accepting any string is required.
 * The production wiring could therefore never pass the genuine predicate
 * without inventing a shim around it, which is how a defensive check ends up
 * guarded by a second, weaker copy of the thing it is checking.
 *
 * A test double supplying `(surface: string) => boolean` is still assignable,
 * because a function that accepts more than it is asked to accept always is.
 */
export interface SurfaceAuthorityProbe {
  readonly surfaceHasCommandAuthority: (surface: AuthoritySurface) => boolean;
}

export type VerificationMatch =
  | {
      readonly kind: 'matched';
      readonly expectation: VerificationExpectation;
      /** Secondary signal only. Never gates the match. */
      readonly senderCorroboration: 'sender-domain-matches' | 'sender-domain-unrelated';
    }
  | { readonly kind: 'no-expectation'; readonly reason: string }
  | {
      readonly kind: 'recipient-mismatch';
      readonly reason: string;
      readonly expectedRecipients: readonly string[];
      readonly actualRecipient: string;
    }
  | { readonly kind: 'expired'; readonly reason: string; readonly expectation: VerificationExpectation }
  | {
      /**
       * More than one message matched the same open expectation.
       *
       * A phisher racing a genuine login is exactly the case that produces
       * two, and choosing between them is a coin flip on a security decision.
       * Neither is acted on and both are surfaced.
       */
      readonly kind: 'ambiguous';
      readonly reason: string;
      readonly expectation: VerificationExpectation;
      readonly candidateMessageIds: readonly string[];
    }
  | {
      /**
       * The message carried nothing proving which address it arrived at. Its
       * `To:` header is not a substitute, so there is nothing to correlate on
       * and nothing is extracted.
       */
      readonly kind: 'no-delivery-evidence';
      readonly reason: string;
      readonly toHeaderClaim: string;
    };

export interface MatchOptions {
  /**
   * Expire the expectation on a successful match so the same address cannot be used
   * twice. Defaults to true; pass false only for a dry-run inspection.
   */
  readonly consume?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

export const DEFAULT_VERIFICATION_WINDOW_MS = 15 * 60 * 1_000;
/** Hard ceiling. No caller can open an indefinite window. */
export const MAX_VERIFICATION_WINDOW_MS = 60 * 60 * 1_000;
export const MIN_VERIFICATION_WINDOW_MS = 1_000;

/**
 * Field length bounds.
 *
 * `MAX_OPEN_EXPECTATIONS` bounds the COUNT of records and nothing bounded
 * their size, so a single expectation carrying a one-megabyte `purpose`
 * validated, and thirty-two of them made a thirty-two megabyte file that is
 * entirely well-formed. A store that reaps and bounds by count while accepting
 * unbounded fields is bounded in the axis nobody attacks.
 *
 * 253 is the DNS name limit; 320 is the RFC 5321 maximum for an address; a
 * purpose is a sentence a workstream wrote about itself, and 512 is generous
 * for that.
 */
export const MAX_SERVICE_DOMAIN_CHARS = 253;
export const MAX_RECIPIENT_ADDRESS_CHARS = 320;
export const MAX_PURPOSE_CHARS = 512;

// Re-exported so this module stays the one entry point callers already import.
export { MAX_EXPECTATION_ID_CHARS, normalizeExpectationId } from './verification-expectation-id.js';


/**
 * Whether a service domain is one a link could actually be validated against.
 *
 * `normalizeDomain` only trims, lowercases and strips a trailing dot and port
 *, it performs no hostname validation at all, so `"com"` survived it intact
 * on BOTH the load path and the live verb. That mattered because
 * `hostMatchesServiceDomain` accepts any host ending in `.${serviceDomain}`:
 * an expectation scoped to `"com"` authorises a link at every `.com` host in
 * existence. One edit of a 0644 file, or one call to the open verb, minted a
 * wildcard-TLD grant.
 *
 * `registrableDomain` answers the real question, is there a label BELOW a
 * public suffix, and returns null for a bare TLD, for a multi-label public
 * suffix like `co.uk`, and for a single label. Used rather than a regex
 * because the set of public suffixes is data, not a pattern: `co.uk` is a
 * suffix and `co.com` is not, and no regex knows the difference.
 */
export function isRegistrableServiceDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_SERVICE_DOMAIN_CHARS) return false;
  return registrableDomain(domain) !== null;
}
/** Bound on concurrently open expectations, so a loop cannot grow the hole. */
export const MAX_OPEN_EXPECTATIONS = 32;

const EMAIL_SURFACE = 'email';
// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

function clampWindow(windowMs: number | undefined): number {
  if (windowMs === undefined || !Number.isFinite(windowMs)) return DEFAULT_VERIFICATION_WINDOW_MS;
  return Math.min(Math.max(Math.floor(windowMs), MIN_VERIFICATION_WINDOW_MS), MAX_VERIFICATION_WINDOW_MS);
}

/**
 * Whether an expectation's window has closed at `now`.
 *
 * One expression, used by every read and by `sweepExpired`, so "expired" cannot
 * come to mean one thing to a filter and another to the reaper, a `<` here and
 * a `<=` there would leave a row that reads as open and sweeps as expired.
 */
function hasElapsed(expectation: VerificationExpectation, now: Date): boolean {
  return Date.parse(expectation.expiresAt) <= now.getTime();
}

/**
 * Validate a PERSISTED expectation record by content, using the exact rules
 * `openExpectation` enforces. Added for
 * `platform/email/inbound/expectation-store.ts` (docs/inbound-email.md §9.2),
 * which persists expectations across a restart with their original absolute
 * `expiresAt` rather than keeping them in memory only.
 *
 * This is the load-bearing security property of that store: **a file on disk
 * must not be able to mint an expectation the live API would have refused.**
 * `authority` must read exactly `'evidence-only'`, `serviceDomain` and
 * `recipientAddress` must normalize to something `openExpectation` would have
 * accepted, `id` must be one this daemon would have minted (see
 * `normalizeExpectationId`, the field that had no bound at all), and
 * `expiresAt - openedAt` must not exceed `MAX_VERIFICATION_WINDOW_MS`, the
 * same ceiling `clampWindow` enforces on the live path. Returns `null` for
 * anything that fails any check. Never throws, never repairs, never widens a
 * window.
 *
 * Validated against the PRESENT, not only against itself.
 *
 * The window used to be checked as a delta alone, `expiresAt - openedAt`
 * within the ceiling, and the `now` parameter was accepted and ignored. A
 * record dated `openedAt: 2999-01-01` with a thirty-minute window therefore
 * had a perfectly valid delta, validated, survived the sweep (which only
 * reaps records already EXPIRED, and this one expires in the year 2999) and
 * hydrated into a live expectation that never ages out. `openExpectation`
 * computes `expiresAt = now + clampWindow(...)`, so a live grant cannot
 * outlive the hour, which made the load path strictly weaker than the API it
 * claims to mirror, and falsified §9.2's guarantee that "a file on disk cannot
 * mint an expectation the live API would have refused".
 *
 * The earlier reasoning for leaving expiry to the sweep, that
 * `device-grants.ts` does the same, held only for records in the PAST, which
 * a sweep does catch. A future-dated record is caught by neither, and that is
 * the gap. Both ends are checked here now:
 *
 *   - `expiresAt` must be in the future, or the record is already spent;
 *   - `openedAt` must NOT be in the future, or the record describes a grant
 *     that has not been issued yet;
 *   - the delta must sit within [MIN, MAX], the same bounds `clampWindow`
 *     enforces on the live path, `<= 0` used to be the only floor, so the
 *     load path accepted a one-millisecond window the API would have raised
 *     to a second.
 */
export function validatePersistedExpectation(value: unknown, now: Date = new Date()): VerificationExpectation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const id = normalizeExpectationId(record.id);
  if (id === null) return null;

  const kind = record.kind;
  if (kind !== 'signup' && kind !== 'login') return null;

  if (record.authority !== 'evidence-only') return null;

  const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
  if (!purpose || purpose.length > MAX_PURPOSE_CHARS) return null;

  const rawServiceDomain = typeof record.serviceDomain === 'string' ? record.serviceDomain : '';
  const serviceDomain = normalizeDomain(rawServiceDomain);
  // Not merely non-empty: a bare TLD normalises to itself and authorises every
  // host beneath it. See `isRegistrableServiceDomain`.
  if (!isRegistrableServiceDomain(serviceDomain)) return null;

  const rawRecipient = typeof record.recipientAddress === 'string' ? record.recipientAddress : '';
  const recipientAddress = normalizeEmailAddress(rawRecipient);
  if (!recipientAddress.includes('@') || recipientAddress.length > MAX_RECIPIENT_ADDRESS_CHARS) return null;

  const openedAtRaw = typeof record.openedAt === 'string' ? record.openedAt : '';
  const expiresAtRaw = typeof record.expiresAt === 'string' ? record.expiresAt : '';
  const openedAtMs = Date.parse(openedAtRaw);
  const expiresAtMs = Date.parse(expiresAtRaw);
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(expiresAtMs)) return null;

  // A grant that has not been issued yet is not a grant.
  //
  // This one check is what closes the future-dating hole, and it is
  // deliberately the ONLY absolute-time check here. Refusing an already-EXPIRED
  // record at this layer as well would be strictly stronger and was the first
  // thing I wrote, but it takes the `expired` classification away from
  // `sweep()`, which then reports a merely-spent record as malformed. The
  // owner would be told their store was corrupt when a signup simply timed out,
  // and §9's disclosure is worth more than a redundant check: a past-expiry
  // record is already caught by the sweep and by `hydrateExpectation`.
  //
  // A future-dated record was caught by NEITHER, it is not malformed by
  // delta and it is not expired, which is precisely why it survived. With
  // `openedAt` pinned to the past, the delta ceiling bounds `expiresAt`: a
  // record claiming to expire in 2999 can only do so by also claiming to have
  // opened in 2999 (refused here) or by declaring a delta of centuries
  // (refused below).
  if (openedAtMs > now.getTime()) return null;

  const windowMs = expiresAtMs - openedAtMs;
  if (windowMs < MIN_VERIFICATION_WINDOW_MS || windowMs > MAX_VERIFICATION_WINDOW_MS) return null;

  return {
    id,
    kind,
    serviceDomain,
    recipientAddress,
    purpose,
    openedAt: new Date(openedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    authority: 'evidence-only',
  };
}

function senderCorroboration(
  email: CandidateEmail,
  expectation: VerificationExpectation,
): 'sender-domain-matches' | 'sender-domain-unrelated' {
  const from = normalizeEmailAddress(email.from);
  const at = from.lastIndexOf('@');
  const senderHost = at >= 0 ? normalizeDomain(from.slice(at + 1)) : '';
  return hostMatchesServiceDomain(senderHost, expectation.serviceDomain)
    ? 'sender-domain-matches'
    : 'sender-domain-unrelated';
}

/**
 * In-memory book of open expectations.
 *
 * Deliberately not persisted: an expectation is a 15-minute grant, and a grant that
 * survives a restart is a grant nobody remembers issuing.
 */
export class VerificationExpectationBook {
  private readonly open = new Map<string, VerificationExpectation>();

  /**
   * @param authority Optional probe against the surface-authority module. When supplied,
   * opening an expectation asserts email is still an input-only surface, if email ever
   * gains command authority the narrow hole here is no longer the narrow hole, and that
   * should fail loudly rather than quietly widen.
   */
  public constructor(private readonly authority?: SurfaceAuthorityProbe) {}

  /** Registered explicitly when the agent initiates a signup. Nothing else opens one. */
  public openExpectation(input: OpenExpectationInput): VerificationExpectation {
    if (this.authority?.surfaceHasCommandAuthority(EMAIL_SURFACE) === true) {
      throw new Error(
        'Email has been granted command authority; scoped verification expectations assume email is input-only. Refusing to open one.',
      );
    }
    const serviceDomain = normalizeDomain(input.serviceDomain);
    const recipientAddress = normalizeEmailAddress(input.recipientAddress);
    const purpose = input.purpose.trim();
    // The SAME domain rule the load path applies. `"com"` used to pass here
    // too, this half of the defect was reachable through the live verb with
    // no file edit at all, and an expectation scoped to a bare TLD authorises
    // a link at every host beneath it.
    if (!isRegistrableServiceDomain(serviceDomain)) {
      throw new Error(
        `A verification expectation needs a registrable service domain, a name with a label below `
        + `a public suffix, like 'github.com'. '${serviceDomain || input.serviceDomain}' is a public `
        + `suffix or is not a hostname, and scoping an expectation to one would authorise every host beneath it.`,
      );
    }
    if (!recipientAddress.includes('@') || recipientAddress.length > MAX_RECIPIENT_ADDRESS_CHARS) {
      throw new Error('A verification expectation requires the exact recipient address used at signup.');
    }
    if (!purpose) throw new Error('A verification expectation requires a stated purpose.');
    if (purpose.length > MAX_PURPOSE_CHARS) {
      throw new Error(`A verification expectation's purpose must be at most ${String(MAX_PURPOSE_CHARS)} characters.`);
    }
    // The SAME id rule the load path applies, refused here rather than left to
    // be dropped later. An id this accepted and `validatePersistedExpectation`
    // refuses works until the daemon restarts and then vanishes without a word,
    // because the store re-validates every entry it writes.
    const askedForId = input.id !== undefined && input.id.trim().length > 0;
    const suppliedId = askedForId ? normalizeExpectationId(input.id) : null;
    if (askedForId && suppliedId === null) {
      throw new Error(
        `A verification expectation's id must be at most ${String(MAX_EXPECTATION_ID_CHARS)} `
        + 'characters of letters, digits, dot, underscore, colon or hyphen. Omit it and one is '
        + 'minted.',
      );
    }

    const now = input.now ?? new Date();
    this.sweepExpired(now);
    if (this.open.size >= MAX_OPEN_EXPECTATIONS && !this.findByRecipient(recipientAddress)) {
      throw new Error(`Too many open verification expectations (limit ${MAX_OPEN_EXPECTATIONS}). Close finished signups first.`);
    }

    // One expectation per address: re-opening replaces, it never stacks.
    const existing = this.findByRecipient(recipientAddress);
    if (existing) this.open.delete(existing.id);

    const expectation: VerificationExpectation = {
      id: suppliedId ?? randomUUID(),
      serviceDomain,
      recipientAddress,
      purpose,
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + clampWindow(input.windowMs)).toISOString(),
      kind: input.kind ?? 'signup',
      authority: 'evidence-only',
    };
    this.open.set(expectation.id, expectation);
    return expectation;
  }

  /**
   * Restore a persisted expectation into the live book, the ONLY entry point
   * that inserts an expectation without minting a fresh window. Added for the
   * boot-time hydration path described in docs/inbound-email.md §9.2: the
   * daemon auto-restarts, so an expectation opened moments before a restart
   * must survive it, but "restarting cannot extend a grant" is the property
   * that override exists to protect.
   *
   * `value` is validated by `validatePersistedExpectation`, the same rules
   * `openExpectation` enforces, so a hand-edited or torn record on disk can
   * never mint an expectation the live API would have refused. An already-
   * expired record is refused here too (reaped before it can match anything),
   * even though the store this feeds is expected to have reaped it already,
   * defense in depth, not reliance.
   *
   * On success the original `id`, `openedAt` and `expiresAt` are kept
   * byte-for-byte; nothing here recomputes a window from `now`.
   */
  public hydrateExpectation(value: unknown, now: Date = new Date()): VerificationExpectation | null {
    const validated = validatePersistedExpectation(value, now);
    if (!validated) return null;
    if (hasElapsed(validated, now)) return null;
    if (this.authority?.surfaceHasCommandAuthority(EMAIL_SURFACE) === true) return null;
    if (this.open.size >= MAX_OPEN_EXPECTATIONS && !this.findByRecipient(validated.recipientAddress)) return null;
    const existing = this.findByRecipient(validated.recipientAddress);
    if (existing) this.open.delete(existing.id);
    this.open.set(validated.id, validated);
    return validated;
  }

  /** Explicit close, on success, on abandonment, on anything. */
  public closeExpectation(id: string): VerificationExpectation | null {
    const existing = this.open.get(id.trim());
    if (!existing) return null;
    this.open.delete(existing.id);
    return existing;
  }

  /**
   * The expectations that are open at `now`.
   *
   * A READ. It filters; it does not reap, and that distinction is the whole
   * point of this comment.
   *
   * `list()` used to call `sweepExpired(now)` and throw the return value away.
   * The rows it dropped were the rows that had just run out, the ones
   * `InboundExpectationRegistry.sweep()` exists to turn into
   * `ExpectationExpiryReport`s and hand to `onExpired`. Whichever of the two
   * ran first won, and the loser found an empty list and reported nothing. The
   * Gmail source asks a presence predicate before every poll wait, five seconds
   * apart while an expectation is open, against a reporting sweep that runs
   * every thirty seconds at the shipped window: the fast read reaped the
   * expiry, and the signup whose verification never arrived ended in exactly
   * the silence §2.3 was written to abolish.
   *
   * The returned VALUE is unchanged, an expired expectation was absent before
   * and is absent now, so no caller sees a difference except that reading no
   * longer destroys the record. Reaping happens in `sweepExpired`, whose
   * callers either report what it removed or need the removal for their own
   * accounting (`openExpectation`, for the open-expectation cap).
   */
  public list(now: Date = new Date()): readonly VerificationExpectation[] {
    return [...this.open.values()].filter((expectation) => !hasElapsed(expectation, now));
  }

  /**
   * Whether anything at all is open at `now`, without building the list and
   * without reaping, see `list()`.
   *
   * Present as its own method rather than left to `list().length > 0` because
   * that expression is what the Gmail source's presence predicate was, and a
   * predicate is precisely the caller that has no reason to mutate anything.
   */
  public hasOpen(now: Date = new Date()): boolean {
    for (const expectation of this.open.values()) {
      if (!hasElapsed(expectation, now)) return true;
    }
    return false;
  }

  public get(id: string, now: Date = new Date()): VerificationExpectation | null {
    const existing = this.open.get(id.trim());
    if (existing === undefined || hasElapsed(existing, now)) return null;
    return existing;
  }

  /**
   * Decide whether an inbound message is the verification the agent provoked.
   *
   * Order is load-bearing: an expired expectation for this recipient is reported as
   * expired (a late arrival, refused), an unknown recipient is reported as a mismatch,
   * and an empty book is reported as no-expectation. None of the three extract anything.
   */
  /**
   * Decide across a SET of candidate messages, refusing when more than one
   * matches the same expectation.
   *
   * `matchCandidate` answers about one message and cannot see a race. A
   * phisher who times a mail to arrive alongside a genuine login code produces
   * two messages that both correlate, and a single-message API would act on
   * whichever was passed first, a coin flip deciding whether the agent
   * follows the attacker's link. Callers that can see the mailbox should use
   * this instead.
   *
   * Nothing is consumed when the answer is ambiguous: the expectation stays
   * open so the owner can finish by hand.
   */
  public matchCandidates(
    emails: readonly CandidateEmail[],
    now: Date,
    options?: MatchOptions,
  ): VerificationMatch {
    const matched: { email: CandidateEmail; expectation: VerificationExpectation }[] = [];
    for (const email of emails) {
      const result = this.matchCandidate(email, now, { consume: false });
      if (result.kind === 'matched') matched.push({ email, expectation: result.expectation });
    }

    if (matched.length === 0) {
      const first = emails[0];
      return first === undefined
        ? { kind: 'no-expectation', reason: 'No messages were offered, so nothing was matched.' }
        : this.matchCandidate(first, now, { consume: false });
    }

    const distinct = new Set(matched.map((entry) => entry.expectation.id));
    if (matched.length > 1 && distinct.size === 1) {
      const expectation = matched[0]!.expectation;
      return {
        kind: 'ambiguous',
        expectation,
        candidateMessageIds: matched.map((entry) => entry.email.messageId),
        reason:
          `${String(matched.length)} messages match the open expectation for "${expectation.recipientAddress}". `
          + 'One of them may be a forgery timed to arrive alongside the real one, and choosing between them '
          + 'would be a guess, so none is acted on. The expectation stays open, complete it by hand.',
      };
    }

    // Derive the answer BEFORE consuming: closing first makes the re-run see an
    // empty book and report no-expectation, which would turn every successful
    // single match into a refusal.
    const chosen = matched[0]!;
    const decision = this.matchCandidate(chosen.email, now, { consume: false });
    if (options?.consume !== false) this.closeExpectation(chosen.expectation.id);
    return decision;
  }

  public matchCandidate(email: CandidateEmail, now: Date, options?: MatchOptions): VerificationMatch {
    // Correlation runs on delivery evidence and nothing else. A message whose
    // `To:` header names an open expectation but which carries no proof of
    // where it landed is refused here, before any expectation is consulted,
    // otherwise the header would be doing the work the brand exists to prevent.
    if (email.deliveredTo === null) {
      return {
        kind: 'no-delivery-evidence',
        reason:
          `This message carries ${describeDeliveryEvidence(null)}. Its "To:" header claims "${email.toHeaderClaim || 'nothing'}", but a sender sets that field themselves, so it cannot establish which address the message arrived at. Nothing is extracted.`,
        toHeaderClaim: email.toHeaderClaim,
      };
    }

    const recipient = email.deliveredTo.address;
    const known = [...this.open.values()];

    const forRecipient = known.find((candidate) => candidate.recipientAddress === recipient);
    if (forRecipient) {
      if (hasElapsed(forRecipient, now)) {
        this.open.delete(forRecipient.id);
        return {
          kind: 'expired',
          reason: `The verification expectation for "${forRecipient.recipientAddress}" expired at ${forRecipient.expiresAt}; this message arrived after it closed.`,
          expectation: forRecipient,
        };
      }
      if (options?.consume !== false) this.open.delete(forRecipient.id);
      return { kind: 'matched', expectation: forRecipient, senderCorroboration: senderCorroboration(email, forRecipient) };
    }

    // Filtered, not swept: this arm only needs to know which addresses are
    // still being waited on so it can say so. Reaping here would delete an
    // elapsed expectation on the way to composing an error message, and the
    // report the sweeper owes the owner for it would go with it, see `list()`.
    const live = this.list(now);
    if (live.length === 0) {
      return {
        kind: 'no-expectation',
        reason: `No verification was expected. "${recipient || 'this message'}" was not solicited by any signup the agent started, so nothing is extracted from it.`,
      };
    }
    const claimNote =
      normalizeEmailAddress(email.toHeaderClaim) !== recipient && email.toHeaderClaim.trim().length > 0
        ? ` Its "To:" header claims "${email.toHeaderClaim}", which does not match where it actually landed, that discrepancy is what a forged verification email looks like.`
        : '';
    return {
      kind: 'recipient-mismatch',
      reason: `This message was ${describeDeliveryEvidence(email.deliveredTo)}, which is not the address any open signup is waiting on. Matching on the service alone is not sufficient.${claimNote}`,
      expectedRecipients: live.map((candidate) => candidate.recipientAddress),
      actualRecipient: recipient,
    };
  }

  /**
   * Drop everything past its window and RETURN what was dropped.
   *
   * The return value is not incidental, it is the only record that an
   * expectation ended, and `InboundExpectationRegistry.sweep()` turns it into
   * the `onExpired` report the owner is told about. A caller that discards it
   * has silently thrown away a signup outcome, which is why the reads above no
   * longer call this at all.
   *
   * `openExpectation` still does, and legitimately: it needs the elapsed rows
   * gone before it counts open expectations against `MAX_OPEN_EXPECTATIONS`, or
   * a book full of expired rows would refuse a live signup. That one loses the
   * reports of anything it reaps, which is bounded by how rarely a workstream
   * opens an expectation and is the price of the cap being accurate; the
   * periodic sweep is what makes it rare.
   */
  public sweepExpired(now: Date = new Date()): readonly VerificationExpectation[] {
    const removed: VerificationExpectation[] = [];
    for (const expectation of [...this.open.values()]) {
      if (hasElapsed(expectation, now)) {
        this.open.delete(expectation.id);
        removed.push(expectation);
      }
    }
    return removed;
  }

  private findByRecipient(recipientAddress: string): VerificationExpectation | null {
    return [...this.open.values()].find((candidate) => candidate.recipientAddress === recipientAddress) ?? null;
  }
}
