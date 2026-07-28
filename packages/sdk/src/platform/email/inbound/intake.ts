/**
 * intake.ts — what happens to a message the sink accepted.
 *
 * This is the middle the capability was missing. Everything either side of it
 * already worked: the watcher found the message, the matcher could answer
 * about it, the producer could render a notice, each channel could escape one,
 * and `deliverSurfaceNotice` could send it. Nothing joined them, so an
 * arriving message reached the end of the sink and stopped — the same shape as
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
 *      message satisfies something already registered — and can spend what it
 *      was handed — but cannot open, hydrate, widen or extend anything. A
 *      message may satisfy an expectation; it may never create one.
 *   3. **Render structure; the channel layer escapes.** The producer returns
 *      spans and `renderNoticeForChannel` picks the escaper for the surface
 *      the notice is about to be delivered to. This file CALLS that; it owns
 *      no escaper and defines no character set.
 *   4. **Record what happened, including a refusal.** A notice that could not
 *      be delivered is written with its reason, so mail that arrived and could
 *      not be announced is a fact the owner can read rather than a dropped
 *      promise.
 *   5. **Spend the grant last.** The match is asked for with `consume: false`
 *      and the expectation is closed only after the notice and the record are
 *      both done with. See below.
 *
 * Why the grant is spent LAST, and not where the match is made
 * ────────────────────────────────────────────────────────────
 * `matchCandidate` defaults to `consume: true`, so this file used to delete
 * the expectation before it had even tried to send the notice. On the one
 * failure the design explicitly retries — `delivery-failed` — the intake threw
 * with the grant already gone: the sink released its claim, the cursor stayed
 * put, the message was redelivered exactly as intended, and pass 2 found an
 * empty book and recorded `no-expectation`. The retry recovered the notice and
 * destroyed the thing the notice was about. The owner was told his own
 * verification mail was unsolicited.
 *
 * The rule that fixes it, stated as a rule because the ordering is otherwise
 * easy to undo by accident: **a pass either completes, or it leaves the book
 * exactly as it found it.** Nothing between the match and the end of the
 * handler may mutate the expectation, so every throw in between — a transport
 * failure, a failed record write, a killed process — hands the redelivery the
 * same book pass 1 saw, and it correlates identically.
 *
 * The alternative was to keep consuming up front and have the retry reuse a
 * RECORDED match. That needs a second durable store, keyed by message
 * identity, which then needs its own bounds, its own reaping and its own
 * recovery rules — a whole persisted state machine whose only job is to undo
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
 * failed attempt suppresses the retry — so a thrown error here is what
 * releases the claim and leaves the cursor below the message. Throwing is
 * therefore how a message gets another chance, and NOT throwing is how it is
 * declared done.
 *
 *   - `delivery-failed` — the transport itself failed. Transient, so it throws:
 *     the claim is released, the cursor stays put, and the next pass tries
 *     again. Silence is the failure mode this capability exists to eliminate.
 *   - Every other refusal (`no-route-binding`, `surface-delivery-disabled`,
 *     `no-deliverable-target`, `unsupported-delivery-surface`, `empty-text`)
 *     is STRUCTURAL: the owner has no route, or delivery to it is switched
 *     off. Retrying cannot clear any of them, and throwing would pin the
 *     cursor below a message that fails identically on every future pass while
 *     the mailbox never drained. Those are recorded with their reason and
 *     disclosed through `email.inbound.status` instead.
 *   - A failed store write throws, because a retry can genuinely do better.
 *
 * What this does NOT do, stated so nobody reads the absence as an oversight:
 *
 * - **No link validation.** The IMAP path fetches ENVELOPES, not bodies, so
 *   there are no links to validate at this point; `links` is empty and the
 *   notice says nothing about links rather than claiming none were present.
 *   Body-bearing link verdicts belong to the round that fetches bodies.
 * - **No Gmail record.** `InboundMailRecord` requires `uidValidity` and `uid`
 *   as positive integers, and a Gmail message has neither — the store was
 *   written before Gmail became a source and never revisited (the same defect
 *   §13.2 records for the dedup identity). Rather than write a record that
 *   `validateInboundMailRecord` would discard on the next load — a record that
 *   exists until a restart and then does not — a Gmail message is announced
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
import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { ExpectationMatcher } from './expectation-registry.js';
import type { InboundMailboxMessage, InboundMailNote, InboundMailObserver } from './ports.js';
import type { InboundMailOutcome, InboundMailStore, InboundNoticeStatus } from './record-store.js';
import type { SurfaceNoticeDelivery } from '../../daemon/types.js';
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

export interface InboundMailNoticeRoute {
  /** The owner's notice route binding, or null when he has none configured. */
  resolveBinding(): NoticeRouteBinding | null;
  /**
   * `DaemonSurfaceDeliveryHelper.deliverStructuredNotice`, bound to that
   * binding.
   *
   * Takes the STRUCTURE, never a rendered string. The intake therefore cannot
   * pick an escaper, cannot pick the wrong one, and cannot skip escaping — it
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
  /** Only `record` — the intake writes; it does not sweep, list or delete. */
  readonly records: Pick<InboundMailStore, 'record'>;
  readonly notices: InboundMailNoticeRoute;
  readonly noticeMode: () => InboundNoticeMode;
  readonly now: () => Date;
  readonly observer?: InboundMailObserver | undefined;
}

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
 * which the producer renders as `untrusted` — authority over the call that
 * registered the expectation is not authority over the strings it passed.
 * Everything that is not a match or an expiry is `inert`: the owner is told
 * mail arrived and that nothing acted on it, which is the true statement.
 */
function noticeOutcome(match: VerificationMatch): InboundOutcome {
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

    // `consume: false` — the grant is NOT spent here. See the ordering note in
    // the file header: it is spent at the very end, once this pass is known to
    // be completing.
    const match = await deps.expectations.matchCandidate({
      messageId: message.messageId,
      from: message.from,
      deliveredTo,
      toHeaderClaim: message.unverifiedToHeaderClaim,
      subject: message.subject,
      // The IMAP path fetched envelopes, so there is no body here and the
      // empty string is the honest value. The Gmail delta carries one.
      body: message.source === 'gmail' ? message.body : '',
    }, now, { consume: false });

    let noticeStatus: InboundNoticeStatus = 'suppressed';
    let noticeFailureReason: string | undefined;
    if (shouldAnnounce(deps.noticeMode(), match)) {
      const binding = deps.notices.resolveBinding();
      if (binding === null) {
        noticeStatus = 'no-route-binding';
      } else {
        // Structure out, never a string. The delivery helper resolves the
        // surface from the binding it already holds and renders there, so the
        // escaper is chosen by the code that knows the destination rather than
        // here. A surface with no verified escaper gets fully-neutralized plain
        // text, never raw span concatenation.
        const notice = renderInboundMailNotice({
          senderDisplay: message.from,
          subject: message.subject,
          deliveredTo,
          outcome: noticeOutcome(match),
          links: [],
          receivedAt,
        });
        const delivery: SurfaceNoticeDelivery = await deps.notices.send(notice);
        if (delivery.delivered) {
          noticeStatus = 'delivered';
        } else if (delivery.reason === 'delivery-failed') {
          // Rethrown, not recorded: the sink releases its claim, the cursor
          // stays below this message, and the next pass announces it.
          throw new InboundNoticeTransportError(delivery.error ?? 'delivery-failed');
        } else {
          noticeStatus = delivery.reason;
          noticeFailureReason = delivery.error;
        }
      }
    }

    // The identity is the message's own, not a shape assumed from one source.
    // Until the record store carried a discriminated identity, this path
    // returned early for Gmail and nothing was ever recorded for it.
    const identity = message.source === 'gmail'
      ? { source: 'gmail' as const, resourceId: message.resourceId, historyId: message.historyId }
      : { source: 'imap' as const, uidValidity: message.uidValidity, uid: message.uid };

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
      noticeStatus,
      ...(noticeFailureReason === undefined ? {} : { noticeFailureReason }),
      // Whatever the source actually has. Gmail's history delta carries the
      // body; IMAP's envelope pass does not, and an empty excerpt is the
      // truth there — a summary assembled from headers would be a
      // body-shaped field holding something that is not the body.
      //
      // The store redacts card shapes out of this before persisting (§11.0),
      // so passing Gmail's real body is what puts that path in service. It
      // had never executed: every Gmail record was discarded before reaching
      // it.
      body: message.source === 'gmail' ? message.body : '',
      receivedAt: receivedAt.iso,
    });

    // LAST. Announced, recorded, and only now spent — see the header. A no-op
    // for every outcome that is not a match.
    await deps.expectations.consumeMatch(match);
  };
}
