/**
 * intake.ts, what happens to a message the sink accepted.
 *
 * This is the middle the capability was missing. Everything either side of it
 * already worked: the watcher found the message, the matcher could answer
 * about it, the producer could render a notice, each channel could escape one,
 * and `deliverSurfaceNotice` could send it. Nothing joined them, so an
 * arriving message reached the end of the sink and stopped, the same shape as
 * a notice that is rendered and never sent.
 *
 * The order is the whole of the design:
 *
 *   1. **Delivery evidence first.** `deliveredRecipientFromDeliveryHeaders`
 *      brands ONLY the top-most `Delivered-To`, which is the one the receiving
 *      agent stamped. The `To:` header travels as `unverifiedToHeaderClaim`
 *      and is passed for display alone; it is never the correlation key, and
 *      there is no path here that makes it one.
 *   2. **Ask the matcher, never tell it.** The intake holds an
 *      `ExpectationMatcher`, whose signatures are projected off
 *      `VerificationExpectationBook.matchCandidate`, so it can ask whether a
 *      message satisfies something already registered, and can spend what it
 *      was handed, but cannot open, hydrate, widen or extend anything. A
 *      message may satisfy an expectation; it may never create one.
 *   3. **Ask whether this message was already announced.** `findByMessage`,
 *      keyed on the identity the receiving server assigned. See below.
 *   4. **Record what is about to happen, including a refusal.** The record
 *      goes in BEFORE the notice, in the `pending` state when a notice is
 *      still to be attempted. See below, this ordering is load-bearing.
 *   5. **Render structure; the channel layer escapes.** The producer returns
 *      spans and `renderNoticeForChannel` picks the escaper for the surface
 *      the notice is about to be delivered to. This file CALLS that; it owns
 *      no escaper and defines no character set.
 *   6. **Send the notice.** The last step that may throw.
 *   7. **Settle: the real notice status, then the grant.** Both run after the
 *      notice is out, so neither may throw, see "nothing throws after the
 *      send" below.
 *
 * Why the notice is sent AFTER the record, and not before it
 * ──────────────────────────────────────────────────────────
 * It used to be first, and the consequence is the same shape as the consume
 * defect below it: the notice went out, `records.record` then threw, a full
 * disk, a read-only state directory, the intake threw, the sink released its
 * claim, the cursor stayed below the message, and the next pass fetched it and
 * **announced it again**. Every pass. Dedup could not suppress it, because
 * releasing the claim is exactly how the retry is enabled, so the guard against
 * duplicate notices was the mechanism producing them. Reproduced: five
 * redeliveries, five notices, zero records.
 *
 * The rule the previous round stated for the expectation book applies without
 * modification to the notice, and had simply not been applied to it: **a pass
 * either completes, or it leaves the world exactly as it found it.** The notice
 * is the one step in this handler that cannot be undone, a message on the
 * owner's phone is not retractable, so it goes LAST among the steps that can
 * fail, and everything that might fail goes in front of it. A failing record
 * write now happens with nothing announced, so the redelivery announces once
 * rather than again.
 *
 * The record therefore has to be written before its own `noticeStatus` is
 * known, which is what `pending` is for. It is not a placeholder: a record
 * sitting at `pending` is the true statement that the message was recorded and
 * the notice has not resolved, and it is reachable in two real situations, a
 * transport that keeps refusing with `delivery-failed`, and a daemon killed
 * between the two steps. The second write, once the outcome IS known, replaces
 * that row rather than appending beside it, because `record()` upserts on the
 * message key.
 *
 * Nothing throws after the send
 * ─────────────────────────────
 * The corollary, and it is the part that is easy to undo by accident. Once the
 * notice is out, a throw from ANY later step, the second record write, the
 * consume, releases the claim and re-announces, which is the defect above by a
 * different verb. So both are attempted, and a failure in either is reported
 * through the observer and swallowed. What that gives up is stated rather than
 * glossed: a failed second write leaves the record at `pending` (disclosed, and
 * corrected by the next redelivery if there is one), and a failed consume
 * leaves the grant open (bounded by the expectation's own window and disclosed
 * by `onExpired`). Both are recoverable states that announce themselves. A
 * duplicate notice is neither.
 *
 * Why the message is asked about before it is announced
 * ────────────────────────────────────────────────────
 * The sink's dedup cache is an in-process `Map`. It cannot survive the daemon's
 * hourly auto-update restart, and the cursor only advances after a pass
 * completes, so a restart in that window redelivers a message that was already
 * announced, into an empty cache, and the owner is told twice. No TTL fixes
 * that at any value, because the cache does not outlive the process (§6).
 *
 * The durable answer already existed: the record store is keyed by the identity
 * the receiving server assigned, and it says what happened to the notice. A
 * message whose record already reads `delivered` is not announced again. It
 * fails in the safe direction throughout, a discarded record file, a reaped
 * record, a store that cannot be read all lead to announcing, and §6's ruling
 * is that a duplicate beats silence, and it needs no new persisted state, no
 * new bounds and no new sweep.
 *
 * Why the grant is spent LAST, and not where the match is made
 * ────────────────────────────────────────────────────────────
 * `matchCandidate` defaults to `consume: true`, so this file used to delete
 * the expectation before it had even tried to send the notice. On the one
 * failure the design explicitly retries, `delivery-failed`, the intake threw
 * with the grant already gone: the sink released its claim, the cursor stayed
 * put, the message was redelivered exactly as intended, and pass 2 found an
 * empty book and recorded `no-expectation`. The retry recovered the notice and
 * destroyed the thing the notice was about. The owner was told his own
 * verification mail was unsolicited.
 *
 * Nothing between the match and the end of the handler may mutate the
 * expectation, so every throw in between, a transport failure, a failed record
 * write, a killed process, hands the redelivery the same book pass 1 saw, and
 * it correlates identically.
 *
 * The alternative was to keep consuming up front and have the retry reuse a
 * RECORDED match. That needs a second durable store, keyed by message
 * identity, which then needs its own bounds, its own reaping and its own
 * recovery rules, a whole persisted state machine whose only job is to undo
 * an ordering choice this file is free to make differently. Deferring the
 * consume needs nothing new at all.
 *
 * What deferring costs, stated rather than glossed: the window between "notice
 * delivered" and "grant spent" is a few in-process statements, and a crash
 * inside it leaves the expectation open. That is bounded by the expectation's
 * own window, it is disclosed when the window elapses (`onExpired`), and the
 * redelivery re-matches and re-spends it if the dedup claim did not survive
 * either. The cost of the old ordering was unbounded by comparison: the
 * correlation was destroyed outright and no later pass could recover it.
 * Between a state that expires on its own and a fact that is gone for good,
 * this takes the one that expires.
 *
 * Which failures are retried, and why the distinction is load-bearing
 * ──────────────────────────────────────────────────────────────────
 * The sink claims a message BEFORE the work runs, and a claim that outlives a
 * failed attempt suppresses the retry, so a thrown error here is what
 * releases the claim and leaves the cursor below the message. Throwing is
 * therefore how a message gets another chance, and NOT throwing is how it is
 * declared done.
 *
 *   - `delivery-failed`, the transport itself failed. Transient, so it throws:
 *     the claim is released, the cursor stays put, and the next pass tries
 *     again. Silence is the failure mode this capability exists to eliminate.
 *   - Every other refusal (`no-route-binding`, `surface-delivery-disabled`,
 *     `no-deliverable-target`, `unsupported-delivery-surface`, `empty-text`)
 *     is STRUCTURAL: the owner has no route, or delivery to it is switched
 *     off. Retrying cannot clear any of them, and throwing would pin the
 *     cursor below a message that fails identically on every future pass while
 *     the mailbox never drained.
 *
 *     Recording them is not enough, and that gap is what `notice-health.ts`
 *     closes. A structural refusal returns normally, so the cursor advances and
 *     nothing ever re-announces the message, meaning the record IS the only
 *     trace, and a record is something the owner has to go and look for. The
 *     condition is therefore also reported to `noticeHealth`, which latches it,
 *     counts the messages going unannounced under it, logs it once, and makes
 *     `email.inbound.status` and the health entry say `degraded` for as long as
 *     it lasts. A capability quietly demoted to a recorder is not a healthy one.
 *   - A store write BEFORE the notice throws, because a retry can genuinely do
 *     better and nothing has gone out yet. A store write AFTER the notice does
 *     not, see "nothing throws after the send" above.
 *
 * What this does NOT do, stated so nobody reads the absence as an oversight:
 *
 * - **No link validation.** The IMAP path fetches ENVELOPES, not bodies, so
 *   there are no links to validate at this point; `links` is empty and the
 *   notice says nothing about links rather than claiming none were present.
 *   Body-bearing link verdicts belong to the round that fetches bodies.
 * - **No Gmail record.** `InboundMailRecord` requires `uidValidity` and `uid`
 *   as positive integers, and a Gmail message has neither, the store was
 *   written before Gmail became a source and never revisited (the same defect
 *   §13.2 records for the dedup identity). Rather than write a record that
 *   `validateInboundMailRecord` would discard on the next load, a record that
 *   exists until a restart and then does not, a Gmail message is announced
 *   and its absence from the store is reported through the observer. That is
 *   visible; a vanishing record is not.
 * - **It cannot start work.** There is no agent manager, session broker or
 *   reply queue in any signature in this file.
 */

import { deliveredRecipientFromDeliveryHeaders } from '../../google/delivery-evidence.js';
import {
  receiptTimestamp,
  renderInboundMailNotice,
  type InboundOutcome,
  type StructuredNotice,
} from '../inbound-notice.js';
import { summarizeError } from '../../utils/error-display.js';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { ExpectationMatcher } from './expectation-registry.js';
import type { InboundNoticeHealth } from './notice-health.js';
import type { InboundMailboxMessage, InboundMailNote, InboundMailObserver } from './ports.js';
import type {
  InboundMailMessageKey,
  InboundMailOutcome,
  InboundMailStore,
  InboundNoticeStatus,
} from './record-store.js';
import type { SurfaceNoticeDelivery, SurfaceNoticeRefusal } from '../../daemon/types.js';
import type { VerificationMatch } from '../../google/verification-expectations.js';

/** `surfaces.email.inbound.notice.mode`, as the intake reads it. */
export type InboundNoticeMode = 'all' | 'expected-only' | 'none';

/**
 * What this module needs from a route binding: the surface it points at.
 *
 * A `Pick` off the real declaration rather than a restated `{ surfaceKind:
 * string }`. A restated shape would accept a hand-built object whose
 * `surfaceKind` is any string at all, and the whole point of reading the
 * binding is that the value came from the binding.
 */
export type NoticeRouteBinding = Pick<AutomationRouteBinding, 'surfaceKind'>;

/**
 * Where the owner's notice goes, or, when there is nowhere, WHY.
 *
 * A discriminated answer rather than `NoticeRouteBinding | null`, and the null
 * is precisely what went wrong. Two entirely different states produced it: the
 * owner has connected no channel, and the whole route-binding feature is
 * switched off (`integrations.routeBinding`), in which case
 * `RouteBindingManager.listBindings()` answers `[]` no matter how many bindings
 * are stored. Both arrived here as `null`, both were recorded as
 * `no-route-binding`, and the second, an unrelated flag silently turning
 * inbound mail into a recorder, was indistinguishable from the first.
 *
 * The refusal's prose lives with the caller that resolves the route, because
 * that is where the config keys are known. This module records the refusal and
 * reports it; it does not name settings it cannot read.
 */
export type NoticeRouteResolution =
  | { readonly kind: 'bound'; readonly binding: NoticeRouteBinding }
  | {
    readonly kind: 'unavailable';
    /** The condition's own name, finer-grained than the delivery layer's vocabulary. */
    readonly reason: string;
    /** What is wrong, in one sentence, for a person. */
    readonly detail: string;
    /** The remedial step. */
    readonly fix: string;
  };

export interface InboundMailNoticeRoute {
  /** The owner's notice route binding, or why there is none. */
  resolveBinding(): NoticeRouteResolution;
  /**
   * `DaemonSurfaceDeliveryHelper.deliverStructuredNotice`, bound to that
   * binding.
   *
   * Takes the STRUCTURE, never a rendered string. The intake therefore cannot
   * pick an escaper, cannot pick the wrong one, and cannot skip escaping, it
   * never holds a channel-formatted string to pass. That is the same guarantee
   * the producer has, extended across the port: the only code that turns spans
   * into text is the code that knows the destination.
   */
  send(notice: StructuredNotice): Promise<SurfaceNoticeDelivery>;
}

export interface InboundMailIntakeDeps {
  /**
   * Match-only. The methods that insert are absent from this type, so an
   * arriving message cannot register what it wants to be waiting for.
   */
  readonly expectations: ExpectationMatcher;
  /**
   * `record` and `findByMessage`, the intake writes one message's record and
   * reads that same message's back. It does not sweep, list or delete: it has
   * no business seeing any message but the one it was handed.
   */
  readonly records: Pick<InboundMailStore, 'record' | 'findByMessage'>;
  readonly notices: InboundMailNoticeRoute;
  readonly noticeMode: () => InboundNoticeMode;
  readonly now: () => Date;
  /**
   * Where "mail is arriving and nobody is being told" is made visible.
   *
   * Optional because the intake is exercised on its own in several suites, and
   * absent it the behaviour is exactly today's, recorded, not surfaced. The
   * composition root always supplies one; a build that did not would be the
   * defect this exists to close, so `facade-inbound-mail.ts` passes the same
   * instance here and to the supervisor that reports it.
   */
  readonly noticeHealth?: InboundNoticeHealth | undefined;
  readonly observer?: InboundMailObserver | undefined;
}

/**
 * What each structural refusal means, and what clears it.
 *
 * A `Record` keyed off the projected refusal vocabulary rather than a list, so
 * the compiler fails this object if `SurfaceNoticeRefusal` grows a reason,
 * the same exhaustiveness rule `record-store.ts` uses for the same union.
 * `delivery-failed` is excluded by type because it is not structural: it throws
 * and is retried, and it is the one refusal that never reaches here.
 */
const STRUCTURAL_REFUSALS: Readonly<Record<
  Exclude<SurfaceNoticeRefusal, 'delivery-failed'>,
  { readonly detail: string; readonly fix: string }
>> = {
  'no-route-binding': {
    detail: 'the notice route resolved to nothing at the moment the notice was sent, so there '
      + 'was nowhere to deliver it.',
    fix: 'Connect a channel the daemon can reach you on, or point '
      + 'surfaces.email.inbound.notice.route at an existing route binding.',
  },
  'empty-text': {
    detail: 'the rendered notice came out empty, so the delivery layer refused to send it.',
    fix: 'This is a fault in the notice renderer rather than in your configuration; report it '
      + 'with the account and mailbox named above.',
  },
  'unsupported-delivery-surface': {
    detail: 'the notice route points at a surface this build cannot deliver to.',
    fix: 'Set surfaces.email.inbound.notice.route to a binding on a surface this build supports.',
  },
  'surface-delivery-disabled': {
    detail: 'delivery to the notice route\'s surface is switched off.',
    fix: 'Turn delivery on for that surface, or point surfaces.email.inbound.notice.route at a '
      + 'surface whose delivery is enabled.',
  },
  'no-deliverable-target': {
    detail: 'the notice route has no reachable target, no chat, channel or thread was ever '
      + 'captured for it.',
    fix: 'Send one message to the daemon from that channel so it captures a reply target, or '
      + 'point surfaces.email.inbound.notice.route at a binding that already has one.',
  },
};

/** The record store's outcome vocabulary, from the matcher's own verdict. */
function recordOutcome(match: VerificationMatch): InboundMailOutcome {
  switch (match.kind) {
    case 'matched': return 'matched-expectation';
    case 'expired': return 'expired-expectation';
    case 'recipient-mismatch': return 'recipient-mismatch';
    case 'ambiguous': return 'ambiguous';
    case 'no-delivery-evidence': return 'no-delivery-evidence';
    case 'no-expectation':
    default: return 'no-expectation';
  }
}

/**
 * The notice's outcome line.
 *
 * `matched` carries the expectation's own purpose and service domain, both of
 * which the producer renders as `untrusted`, authority over the call that
 * registered the expectation is not authority over the strings it passed.
 * Everything that is not a match or an expiry is `inert`: the owner is told
 * mail arrived and that nothing acted on it, which is the true statement.
 *
 * `bodiesWithheld` short-circuits all of it. When the message was read under a
 * grant that excludes bodies, the only honest outcome line is the one that says
 * so, and it is returned BEFORE `match` is consulted rather than after: the
 * caller never builds a match on this path, so there is nothing here for a
 * later edit to accidentally start preferring.
 */
function noticeOutcome(match: VerificationMatch, bodiesWithheld: boolean): InboundOutcome {
  if (bodiesWithheld) {
    return {
      kind: 'capability-degraded',
      // Produced entirely by the daemon's own capability probe, the Google
      // grant's scope list, so `inbound-notice.ts` may render it without it
      // ever having quoted a server or a sender.
      missingCapability: 'read message bodies under the granted scope',
    };
  }
  if (match.kind === 'matched') {
    return {
      kind: 'matched-expectation',
      purpose: match.expectation.purpose,
      serviceDomain: match.expectation.serviceDomain,
    };
  }
  if (match.kind === 'expired') return { kind: 'expired-expectation' };
  return { kind: 'inert' };
}

/**
 * Was this message read without its body?
 *
 * ── This is the security half of the metadata path, and it is not a
 *    convenience check ──────────────────────────────────────────────────────
 *
 * `VerificationExpectationBook.matchCandidate` gates a match on the DELIVERY
 * EVIDENCE ADDRESS and nothing else. `CandidateEmail.body` is passed to it and
 * is not consulted in the match decision at all. So a metadata-only message,
 * which carries real, receiver-written `Delivered-To` headers, because those
 * are headers, would match an open expectation for that alias and consume it,
 * on evidence nobody read. The verification link the expectation exists to
 * wait for lives in a body that was never fetched.
 *
 * That is why `createInboundMailIntake` does not call `matchCandidate` at all
 * on this path, rather than calling it and discarding the answer. A discarded
 * answer is one edit away from being used, and `consume` defaults to `true` on
 * that method, a future call that forgot the option would spend the grant on
 * its way to being ignored.
 *
 * ── Why the field is re-checked at run time ──────────────────────────────
 *
 * `GmailInboundMessage.bodyAvailability` is a required field, so every
 * production construction site states it. `bunx tsc -b` does not typecheck
 * `test/`, though, so a rig that builds a Gmail message literal without it
 * compiles, and the value would then be `undefined`, which is neither of the
 * two allowed strings. Rather than let `undefined` fall through the `===`
 * comparison as "not metadata-only" and be treated as a full body, an absent or
 * unrecognised value THROWS. A thrown intake releases the sink's claim and the
 * message is retried, which is the safe direction; treating it as a full body
 * is the unsafe one.
 */
function bodiesWithheldFrom(message: InboundMailboxMessage): boolean {
  if (message.source !== 'gmail') return false;
  const availability: unknown = message.bodyAvailability;
  if (availability === 'metadata-only') return true;
  if (availability === 'full') return false;
  throw new Error(
    'A Gmail inbound message arrived without a usable bodyAvailability field '
    + `(${JSON.stringify(availability)}). That field is what decides whether this message may `
    + 'satisfy a verification expectation, and guessing it as "full" would let a message read '
    + 'without its body satisfy one on delivery evidence alone. Refusing instead: the message '
    + 'stays above the cursor and is retried.',
  );
}

/** Whether this outcome is announced, under the configured notice mode. */
function shouldAnnounce(mode: InboundNoticeMode, match: VerificationMatch): boolean {
  if (mode === 'none') return false;
  if (mode === 'expected-only') return match.kind === 'matched' || match.kind === 'expired';
  return true;
}

/** A transport failure that another pass could clear. Everything else is structural. */
export class InboundNoticeTransportError extends Error {
  constructor(reason: string) {
    super(`The inbound-mail notice could not be delivered (${reason}). The message stays above `
      + 'the cursor so the next pass announces it rather than leaving the owner with silence.');
    this.name = 'InboundNoticeTransportError';
  }
}

function note(
  observer: InboundMailObserver | undefined,
  message: InboundMailboxMessage,
  kind: InboundMailNote['kind'],
  detail: string,
  at: string,
): void {
  try {
    observer?.note?.({ account: message.account, mailbox: message.mailbox, kind, detail, at });
  } catch {
    // An observer that throws must not turn a handled message into a failed
    // one: failing here would pin the cursor and re-deliver the message
    // forever, which is a far worse outcome than a lost log line.
  }
}

/** Build the handler the `DedupingInboundMailSink` wraps. */
export function createInboundMailIntake(
  deps: InboundMailIntakeDeps,
): (message: InboundMailboxMessage) => Promise<void> {
  return async (message: InboundMailboxMessage): Promise<void> => {
    const now = deps.now();
    const receivedAt = receiptTimestamp(now);
    const deliveredTo = deliveredRecipientFromDeliveryHeaders(message.deliveredTo);

    // Read BEFORE anything else, and it throws on an unusable value rather than
    // guessing, see `bodiesWithheldFrom`.
    const bodiesWithheld = bodiesWithheldFrom(message);

    // `consume: false`, the grant is NOT spent here. See the ordering note in
    // the file header: it is spent at the very end, once this pass is known to
    // be completing.
    //
    // On the body-less path the book is NOT ASKED AT ALL. `matchCandidate`
    // gates on the delivery-evidence address, which is a header and therefore
    // present on a metadata-only message, so asking would produce a genuine
    // `matched` for an expectation whose verification link nobody read. The
    // substituted verdict below is the true statement about what happened, and
    // it is a shape `recordOutcome` and `consumeMatch` already handle: nothing
    // was matched, so nothing is spent.
    const match: VerificationMatch = bodiesWithheld
      ? {
        kind: 'no-expectation',
        reason:
          'This message was read under a Google grant that authorizes message headers and '
          + 'excludes message bodies (gmail.metadata), so its body was never fetched. A '
          + 'verification link lives in a body; an expectation satisfied on headers alone would '
          + 'be satisfied on evidence nobody read. No expectation was consulted and none was '
          + 'spent.',
      }
      : await deps.expectations.matchCandidate({
        messageId: message.messageId,
        from: message.from,
        deliveredTo,
        toHeaderClaim: message.unverifiedToHeaderClaim,
        subject: message.subject,
        // The IMAP path fetched envelopes, so there is no body here and the
        // empty string is the honest value. The Gmail delta carries one.
        body: message.source === 'gmail' ? message.body : '',
      }, now, { consume: false });

    // The identity is the message's own, not a shape assumed from one source.
    // Until the record store carried a discriminated identity, this path
    // returned early for Gmail and nothing was ever recorded for it.
    const identity = message.source === 'gmail'
      ? { source: 'gmail' as const, resourceId: message.resourceId, historyId: message.historyId }
      : { source: 'imap' as const, uidValidity: message.uidValidity, uid: message.uid };
    const key: InboundMailMessageKey = message.source === 'gmail'
      ? {
        source: 'gmail',
        account: message.account,
        mailbox: message.mailbox,
        resourceId: message.resourceId,
      }
      : {
        source: 'imap',
        account: message.account,
        mailbox: message.mailbox,
        uidValidity: message.uidValidity,
        uid: message.uid,
      };

    /** One write of this message's record, at whatever status is known so far. */
    const write = async (
      status: InboundNoticeStatus,
      failureReason: string | undefined,
    ): Promise<void> => {
      await deps.records.record({
        ...identity,
        account: message.account,
        mailbox: message.mailbox,
        senderDisplay: message.from,
        subject: message.subject,
        deliveredToAddress: deliveredTo?.address ?? null,
        deliveryEvidenceSource: deliveredTo?.source ?? 'none',
        links: [],
        outcome: recordOutcome(match),
        noticeStatus: status,
        ...(failureReason === undefined ? {} : { noticeFailureReason: failureReason }),
        // Whatever the source actually has. Gmail's history delta carries the
        // body; IMAP's envelope pass does not, and an empty excerpt is the
        // truth there, a summary assembled from headers would be a
        // body-shaped field holding something that is not the body.
        //
        // The store redacts card shapes out of this before persisting (§11.0),
        // so passing Gmail's real body is what puts that path in service. It
        // had never executed: every Gmail record was discarded before reaching
        // it.
        body: message.source === 'gmail' ? message.body : '',
        receivedAt: receivedAt.iso,
      });
    };

    // Whether the OWNER has already been told about this exact message, from
    // the one place that survives a restart. A read that throws is a read that
    // happens before anything is announced, so it is allowed to throw: the
    // retry announces once rather than again.
    const prior = await deps.records.findByMessage(key);
    const alreadyAnnounced = prior !== null && prior.noticeStatus === 'delivered';

    // Decide everything BEFORE anything irreversible happens.
    const plan: NoticePlan = !shouldAnnounce(deps.noticeMode(), match)
      ? { kind: 'settled', status: 'suppressed' }
      : alreadyAnnounced
        // Announced on an earlier pass whose cursor advance never landed. The
        // message is genuinely handled; announcing it again is the duplicate
        // the dedup cache exists to prevent and cannot, across a restart.
        ? { kind: 'settled', status: 'delivered' }
        : planFor(
          deps.notices.resolveBinding(),
          message,
          deliveredTo,
          match,
          receivedAt,
          bodiesWithheld,
        );

    // THE RECORD GOES IN FIRST, and this is the ordering the file header is
    // about. Everything that can fail happens with nothing announced, so a
    // failure here produces a redelivery that announces ONCE.
    await write(plan.kind === 'send' ? 'pending' : plan.status, undefined);

    let status: InboundNoticeStatus;
    let failureReason: string | undefined;
    let refusal: { readonly reason: string; readonly detail: string; readonly fix: string } | null
      = plan.kind === 'settled' ? plan.refusal ?? null : null;

    if (plan.kind === 'send') {
      // Structure out, never a string. The delivery helper resolves the
      // surface from the binding it already holds and renders there, so the
      // escaper is chosen by the code that knows the destination rather than
      // here. A surface with no verified escaper gets fully-neutralized plain
      // text, never raw span concatenation.
      //
      // THE LAST STEP THAT MAY THROW.
      const delivery: SurfaceNoticeDelivery = await deps.notices.send(plan.notice);
      if (delivery.delivered) {
        status = 'delivered';
      } else if (delivery.reason === 'delivery-failed') {
        // Rethrown, not recorded: the sink releases its claim, the cursor
        // stays below this message, and the next pass announces it. The record
        // stays at `pending`, which is what it truthfully is, and the retry
        // replaces it rather than writing a second row.
        throw new InboundNoticeTransportError(delivery.error ?? 'delivery-failed');
      } else {
        status = delivery.reason;
        failureReason = delivery.error;
        refusal = { reason: delivery.reason, ...STRUCTURAL_REFUSALS[delivery.reason] };
      }
    } else {
      status = plan.status;
    }

    // ─── Past this line the notice is out. Nothing below may throw. ───

    if (refusal !== null) {
      deps.noticeHealth?.refused({ ...refusal, at: receivedAt.iso });
      note(deps.observer, message, 'notice-refused',
        `${refusal.reason}: ${refusal.detail} ${refusal.fix}`, receivedAt.iso);
    } else if (status === 'delivered' && plan.kind === 'send') {
      deps.noticeHealth?.announced(receivedAt.iso);
    }

    // The real notice status, replacing the `pending` row written above. A
    // failure is reported rather than thrown, see the header: throwing here
    // re-announces a notice that has already gone out.
    if (plan.kind === 'send') {
      try {
        await write(status, failureReason);
      } catch (error) {
        note(deps.observer, message, 'post-notice-write-failed',
          `the inbound record could not be updated from 'pending' to '${status}' `
          + `(${summarizeError(error)}); the notice itself was already sent, so this pass `
          + 'completes rather than re-announcing the message.', receivedAt.iso);
      }
    }

    // LAST. Announced, recorded, and only now spent, see the header. A no-op
    // for every outcome that is not a match, and swallowed for the same reason
    // the write above is: a throw here re-announces.
    try {
      await deps.expectations.consumeMatch(match);
    } catch (error) {
      note(deps.observer, message, 'post-notice-write-failed',
        `the matched expectation could not be closed (${summarizeError(error)}); it stays open `
        + 'until its own window elapses, which is disclosed, rather than re-announcing this '
        + 'message to close it.', receivedAt.iso);
    }
  };
}

/** What this pass intends to do about a notice, decided before anything irreversible runs. */
type NoticePlan =
  | { readonly kind: 'send'; readonly notice: StructuredNotice }
  | {
    readonly kind: 'settled';
    readonly status: InboundNoticeStatus;
    readonly refusal?: { readonly reason: string; readonly detail: string; readonly fix: string };
  };

/** Turn a route resolution into either a notice to send or a refusal to record. */
function planFor(
  route: NoticeRouteResolution,
  message: InboundMailboxMessage,
  deliveredTo: ReturnType<typeof deliveredRecipientFromDeliveryHeaders>,
  match: VerificationMatch,
  receivedAt: ReturnType<typeof receiptTimestamp>,
  bodiesWithheld: boolean,
): NoticePlan {
  if (route.kind === 'unavailable') {
    // Recorded under the delivery layer's own vocabulary, `no-route-binding`
    // is what "there is no route" is called everywhere else, while the
    // condition reported to the owner keeps the finer reason the resolver
    // knew. One fact, two audiences, neither of them given a guess.
    return {
      kind: 'settled',
      status: 'no-route-binding',
      refusal: { reason: route.reason, detail: route.detail, fix: route.fix },
    };
  }
  return {
    kind: 'send',
    notice: renderInboundMailNotice({
      senderDisplay: message.from,
      subject: message.subject,
      deliveredTo,
      outcome: noticeOutcome(match, bodiesWithheld),
      links: [],
      receivedAt,
    }),
  };
}
