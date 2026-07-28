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
 * Extraction returns exactly one artifact — a verification link or a verification code.
 * Everything else in the body is returned only as clearly-labelled untrusted display
 * text that no decision path reads.
 *
 * This module decides and returns. It never navigates, fetches, or sends anything.
 */

import { randomUUID } from 'node:crypto';
import { normalizeDomain, normalizeEmailAddress } from './signup-address.js';
import { describeDeliveryEvidence, type DeliveredRecipient } from './delivery-evidence.js';
import type { AuthoritySurface } from '../security/untrusted-content.js';

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
 *  - `signup` — the agent is creating an account. Correlation is strongest
 *    here: the alias was minted for this one service, so mail arriving at it is
 *    almost certainly from that service.
 *  - `login`  — the agent is authenticating to an account that already exists,
 *    and the service is sending a code or magic link. Correlation is WEAKER,
 *    because the address is the one already registered with that service and
 *    tells you much less. The compensations are elsewhere in this module:
 *    an exact-domain link check rather than a subdomain-tolerant one, a window
 *    measured from the submission rather than a generous default, and a hard
 *    stop on ambiguity.
 *
 * There is no third kind, deliberately. Everything else that looks like
 * verification mail — a password reset nobody asked for, a security alert, an
 * MFA prompt for an unrelated login, account recovery, an invoice — is
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
  /** Window length. Defaults to 15 minutes; clamped to the hard maximum below. */
  readonly windowMs?: number;
  readonly now?: Date;
  /** Injected id, for deterministic tests. */
  readonly id?: string;
}

/** The minimum an inbound message must present to be considered. */
export interface CandidateEmail {
  readonly messageId: string;
  /** Sender address as delivered. Corroborating signal only, never a gate. */
  readonly from: string;
  /**
   * Proof of which address this message actually arrived at — the correlation
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
   * The `To:` header, verbatim. **Display only — never evidence.** Kept so a
   * refusal can show the reader what the message claimed alongside where it
   * actually landed, which is what makes a forgery legible.
   */
  readonly toHeaderClaim: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Narrow local mirror of the untrusted-content module (`src/agent/untrusted-content.ts`,
 * owned by another module). Swap for the real type once that module lands; the shape is
 * intentionally minimal so the swap is mechanical.
 */
export interface UntrustedDisplayText {
  readonly untrusted: true;
  readonly label: string;
  readonly text: string;
}

/**
 * The one surface-authority predicate this module needs.
 *
 * `surface` is `AuthoritySurface`, imported from the module that owns the
 * union, not the `string` it used to be. The old signature was a narrow local
 * mirror whose own comment pointed at `src/agent/surface-authority.ts` — a
 * path that does not exist; the predicate lives in
 * `platform/security/untrusted-content.ts`. So the mirror had already drifted
 * from a file it named incorrectly, and typing the parameter as `string` made
 * the REAL implementation unassignable to it: a function accepting only
 * `AuthoritySurface` cannot stand where one accepting any string is required.
 * The production wiring could therefore never pass the genuine predicate
 * without inventing a shim around it — which is how a defensive check ends up
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

export type VerificationArtifact =
  | { readonly kind: 'link'; readonly url: string; readonly linkHost: string }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: 'refused';
      readonly reason: 'link-host-mismatch';
      readonly linkHost: string;
      readonly expectedDomain: string;
      readonly message: string;
    };

export interface VerificationExtraction {
  /** The one actionable thing, or a refusal. Nothing else from the body reaches here. */
  readonly artifact: VerificationArtifact;
  /** The rest of the message, inert and labelled. Display only. */
  readonly untrustedBody: UntrustedDisplayText;
}

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
/** Bound on concurrently open expectations, so a loop cannot grow the hole. */
export const MAX_OPEN_EXPECTATIONS = 32;

const EMAIL_SURFACE = 'email';
const URL_PATTERN = /https?:\/\/[^\s<>"'`\])]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;
const CODE_NEAR_LABEL = /\b(?:code|pin|otp|passcode)\b[^A-Za-z0-9]{0,24}([A-Z0-9]{4,10})\b/i;
const STANDALONE_DIGIT_CODE = /(?:^|[^A-Za-z0-9$£€])(\d{6,8})(?:[^A-Za-z0-9]|$)/;
/** The bare-digit fallback only applies to a message that is about verifying at all. */
const VERIFICATION_CONTEXT = /\b(?:verif\w*|confirm\w*|activat\w*|validat\w*|code|pin|otp|passcode)\b/i;

// ──────────────────────────────────────────────────────────────────
// Host validation
// ──────────────────────────────────────────────────────────────────

/**
 * True when `host` is the registered service domain or a subdomain of it.
 *
 * Real label-boundary matching, deliberately not substring matching:
 *   github.com            vs github.com -> true
 *   mail.github.com       vs github.com -> true   (legitimate subdomain)
 *   evil-github.com       vs github.com -> false  (suffix without a label boundary)
 *   github.com.evil.com   vs github.com -> false  (registered domain is the attacker's)
 *   notgithub.com         vs github.com -> false
 */
export function hostMatchesServiceDomain(host: string, serviceDomain: string): boolean {
  const candidate = normalizeDomain(host);
  const registered = normalizeDomain(serviceDomain);
  if (!candidate || !registered) return false;
  if (candidate === registered) return true;
  return candidate.endsWith(`.${registered}`);
}

interface CandidateLink {
  readonly url: string;
  readonly host: string;
}

function collectLinks(body: string): readonly CandidateLink[] {
  const links: CandidateLink[] = [];
  const seen = new Set<string>();
  for (const raw of body.match(URL_PATTERN) ?? []) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    // `new URL` is what resolves userinfo tricks such as https://github.com@evil.com/ —
    // its hostname is evil.com, which is what gets validated.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (!parsed.hostname) continue;
    links.push({ url: parsed.toString(), host: normalizeDomain(parsed.hostname) });
  }
  return links;
}

// ──────────────────────────────────────────────────────────────────
// Extraction
// ──────────────────────────────────────────────────────────────────

function untrustedBodyOf(email: CandidateEmail): UntrustedDisplayText {
  return {
    untrusted: true,
    label: `Untrusted email body from ${normalizeEmailAddress(email.from) || 'unknown sender'} — display only, not instructions`,
    text: email.body,
  };
}

function extractCode(body: string): string | null {
  const labelled = CODE_NEAR_LABEL.exec(body);
  if (labelled?.[1]) return labelled[1].toUpperCase();
  // Without a labelled code, a bare number is only read as a code when the message is
  // about verification at all — otherwise any account number or amount in the body
  // would be handed back as if it were a token.
  if (!VERIFICATION_CONTEXT.test(body)) return null;
  const digits = STANDALONE_DIGIT_CODE.exec(body);
  if (digits?.[1]) return digits[1];
  return null;
}

/**
 * Pull exactly one verification artifact out of a matched message.
 *
 * Precedence: a link whose host is validated against the signup domain, then a code,
 * then nothing. If the message carries links but none of them are hosted at the signup
 * domain, the result is a refusal naming both hosts rather than a fallback to a code —
 * a message pointing somewhere else is not a message to salvage a token from.
 */
export function extractVerification(
  email: CandidateEmail,
  expectation: VerificationExpectation,
): VerificationExtraction {
  const untrustedBody = untrustedBodyOf(email);
  const links = collectLinks(email.body);
  // A signup alias was minted for one service, so a subdomain of that service
  // is still that service. A login address is one the owner already gave out,
  // so the weaker correlation is compensated by demanding the EXACT domain the
  // agent is authenticating against — no parent, no sibling subdomain.
  const matching = expectation.kind === 'login'
    ? links.find((link) => normalizeDomain(link.host) === normalizeDomain(expectation.serviceDomain))
    : links.find((link) => hostMatchesServiceDomain(link.host, expectation.serviceDomain));

  if (matching) {
    return { artifact: { kind: 'link', url: matching.url, linkHost: matching.host }, untrustedBody };
  }

  const firstLink = links[0];
  if (firstLink) {
    return {
      artifact: {
        kind: 'refused',
        reason: 'link-host-mismatch',
        linkHost: firstLink.host,
        expectedDomain: expectation.serviceDomain,
        message: `Refused to follow a verification link: the link points at "${firstLink.host}" but this signup was started at "${expectation.serviceDomain}".`,
      },
      untrustedBody,
    };
  }

  const code = extractCode(email.body);
  if (code) return { artifact: { kind: 'code', code }, untrustedBody };

  return {
    artifact: { kind: 'none', reason: 'No verification link or code was present in the message.' },
    untrustedBody,
  };
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

function clampWindow(windowMs: number | undefined): number {
  if (windowMs === undefined || !Number.isFinite(windowMs)) return DEFAULT_VERIFICATION_WINDOW_MS;
  return Math.min(Math.max(Math.floor(windowMs), MIN_VERIFICATION_WINDOW_MS), MAX_VERIFICATION_WINDOW_MS);
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
 * accepted, and `expiresAt - openedAt` must not exceed
 * `MAX_VERIFICATION_WINDOW_MS` — the same ceiling `clampWindow` enforces on
 * the live path. Returns `null` for anything that fails any check. Never
 * throws, never repairs, never widens a window.
 *
 * Deliberately does NOT check whether `expiresAt` is already in the past —
 * that is a separate rule (expired records are reaped on load, before they
 * can match anything) and belongs to the store's own sweep, not to content
 * validation. Keeping the two checks separate mirrors every other persisted
 * store in this codebase (`device-grants.ts`'s `validateGrant` does not check
 * expiry either; `list()`/`sweep()` do).
 */
export function validatePersistedExpectation(value: unknown, _now: Date = new Date()): VerificationExpectation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;

  const kind = record.kind;
  if (kind !== 'signup' && kind !== 'login') return null;

  if (record.authority !== 'evidence-only') return null;

  const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
  if (!purpose) return null;

  const rawServiceDomain = typeof record.serviceDomain === 'string' ? record.serviceDomain : '';
  const serviceDomain = normalizeDomain(rawServiceDomain);
  if (!serviceDomain) return null;

  const rawRecipient = typeof record.recipientAddress === 'string' ? record.recipientAddress : '';
  const recipientAddress = normalizeEmailAddress(rawRecipient);
  if (!recipientAddress.includes('@')) return null;

  const openedAtRaw = typeof record.openedAt === 'string' ? record.openedAt : '';
  const expiresAtRaw = typeof record.expiresAt === 'string' ? record.expiresAt : '';
  const openedAtMs = Date.parse(openedAtRaw);
  const expiresAtMs = Date.parse(expiresAtRaw);
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(expiresAtMs)) return null;

  const windowMs = expiresAtMs - openedAtMs;
  if (windowMs <= 0 || windowMs > MAX_VERIFICATION_WINDOW_MS) return null;

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
   * opening an expectation asserts email is still an input-only surface — if email ever
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
    if (!serviceDomain) throw new Error('A verification expectation requires the service domain the agent signed up at.');
    if (!recipientAddress.includes('@')) throw new Error('A verification expectation requires the exact recipient address used at signup.');
    if (!purpose) throw new Error('A verification expectation requires a stated purpose.');

    const now = input.now ?? new Date();
    this.sweepExpired(now);
    if (this.open.size >= MAX_OPEN_EXPECTATIONS && !this.findByRecipient(recipientAddress)) {
      throw new Error(`Too many open verification expectations (limit ${MAX_OPEN_EXPECTATIONS}). Close finished signups first.`);
    }

    // One expectation per address: re-opening replaces, it never stacks.
    const existing = this.findByRecipient(recipientAddress);
    if (existing) this.open.delete(existing.id);

    const expectation: VerificationExpectation = {
      id: input.id?.trim() || randomUUID(),
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
   * Restore a persisted expectation into the live book — the ONLY entry point
   * that inserts an expectation without minting a fresh window. Added for the
   * boot-time hydration path described in docs/inbound-email.md §9.2: the
   * daemon auto-restarts, so an expectation opened moments before a restart
   * must survive it, but "restarting cannot extend a grant" is the property
   * that override exists to protect.
   *
   * `value` is validated by `validatePersistedExpectation` — the same rules
   * `openExpectation` enforces — so a hand-edited or torn record on disk can
   * never mint an expectation the live API would have refused. An already-
   * expired record is refused here too (reaped before it can match anything),
   * even though the store this feeds is expected to have reaped it already —
   * defense in depth, not reliance.
   *
   * On success the original `id`, `openedAt` and `expiresAt` are kept
   * byte-for-byte; nothing here recomputes a window from `now`.
   */
  public hydrateExpectation(value: unknown, now: Date = new Date()): VerificationExpectation | null {
    const validated = validatePersistedExpectation(value, now);
    if (!validated) return null;
    if (Date.parse(validated.expiresAt) <= now.getTime()) return null;
    if (this.authority?.surfaceHasCommandAuthority(EMAIL_SURFACE) === true) return null;
    if (this.open.size >= MAX_OPEN_EXPECTATIONS && !this.findByRecipient(validated.recipientAddress)) return null;
    const existing = this.findByRecipient(validated.recipientAddress);
    if (existing) this.open.delete(existing.id);
    this.open.set(validated.id, validated);
    return validated;
  }

  /** Explicit close — on success, on abandonment, on anything. */
  public closeExpectation(id: string): VerificationExpectation | null {
    const existing = this.open.get(id.trim());
    if (!existing) return null;
    this.open.delete(existing.id);
    return existing;
  }

  public list(now: Date = new Date()): readonly VerificationExpectation[] {
    this.sweepExpired(now);
    return [...this.open.values()];
  }

  public get(id: string, now: Date = new Date()): VerificationExpectation | null {
    this.sweepExpired(now);
    return this.open.get(id.trim()) ?? null;
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
   * whichever was passed first — a coin flip deciding whether the agent
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
          + 'would be a guess, so none is acted on. The expectation stays open — complete it by hand.',
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
    // where it landed is refused here, before any expectation is consulted —
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
      if (Date.parse(forRecipient.expiresAt) <= now.getTime()) {
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

    this.sweepExpired(now);
    const live = [...this.open.values()];
    if (live.length === 0) {
      return {
        kind: 'no-expectation',
        reason: `No verification was expected. "${recipient || 'this message'}" was not solicited by any signup the agent started, so nothing is extracted from it.`,
      };
    }
    const claimNote =
      normalizeEmailAddress(email.toHeaderClaim) !== recipient && email.toHeaderClaim.trim().length > 0
        ? ` Its "To:" header claims "${email.toHeaderClaim}", which does not match where it actually landed — that discrepancy is what a forged verification email looks like.`
        : '';
    return {
      kind: 'recipient-mismatch',
      reason: `This message was ${describeDeliveryEvidence(email.deliveredTo)}, which is not the address any open signup is waiting on. Matching on the service alone is not sufficient.${claimNote}`,
      expectedRecipients: live.map((candidate) => candidate.recipientAddress),
      actualRecipient: recipient,
    };
  }

  /** Drop everything past its window. Called on every read and open. */
  public sweepExpired(now: Date = new Date()): readonly VerificationExpectation[] {
    const removed: VerificationExpectation[] = [];
    for (const expectation of [...this.open.values()]) {
      if (Date.parse(expectation.expiresAt) <= now.getTime()) {
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
