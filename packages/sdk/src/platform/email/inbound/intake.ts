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
 *      `ExpectationMatcher` — `Pick<VerificationExpectationBook,
 *      'matchCandidate'>` — so it can ask whether a message satisfies
 *      something already registered and cannot open, hydrate, widen or extend
 *      anything. A message may satisfy an expectation; it may never create one.
 *   3. **Render structure; the channel layer escapes.** The producer returns
 *      spans and `renderNoticeForChannel` picks the escaper for the surface
 *      the notice is about to be delivered to. This file CALLS that; it owns
 *      no escaper and defines no character set.
 *   4. **Record what happened, including a refusal.** A notice that could not
 *      be delivered is written with its reason, so mail that arrived and could
 *      not be announced is a fact the owner can read rather than a dropped
 *      promise.
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
  renderNoticeForChannel,
  type InboundOutcome,
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
  /** `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`, bound to that binding. */
  send(text: string): Promise<SurfaceNoticeDelivery>;
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

    const match = deps.expectations.matchCandidate({
      messageId: message.messageId,
      from: message.from,
      deliveredTo,
      toHeaderClaim: message.unverifiedToHeaderClaim,
      subject: message.subject,
      // The IMAP path fetched envelopes, so there is no body here and the
      // empty string is the honest value. The Gmail delta carries one.
      body: message.source === 'gmail' ? message.body : '',
    }, now);

    let noticeStatus: InboundNoticeStatus = 'suppressed';
    let noticeFailureReason: string | undefined;
    if (shouldAnnounce(deps.noticeMode(), match)) {
      const binding = deps.notices.resolveBinding();
      if (binding === null) {
        noticeStatus = 'no-route-binding';
      } else {
        // The channel layer owns escaping: this call names the surface the
        // notice is going to and takes back whatever that surface's escaper
        // produced. A surface with no escaper registered gets fully
        // neutralized plain text from that function, never raw span text.
        const text = renderNoticeForChannel(renderInboundMailNotice({
          senderDisplay: message.from,
          subject: message.subject,
          deliveredTo,
          outcome: noticeOutcome(match),
          links: [],
          receivedAt,
        }), binding.surfaceKind);
        const delivery: SurfaceNoticeDelivery = await deps.notices.send(text);
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

    if (message.source === 'gmail') {
      note(deps.observer, message, 'delta-drained',
        'This message was announced but NOT recorded: the inbound record store keys every record '
        + 'on a positive UIDVALIDITY and UID, and a Gmail message has neither. Its history is '
        + 'therefore unavailable to email.inbound.status until the store carries a '
        + 'source-discriminated identity.',
        receivedAt.iso);
      return;
    }

    await deps.records.record({
      account: message.account,
      mailbox: message.mailbox,
      uidValidity: message.uidValidity,
      uid: message.uid,
      senderDisplay: message.from,
      subject: message.subject,
      deliveredToAddress: deliveredTo?.address ?? null,
      deliveryEvidenceSource: deliveredTo?.source ?? 'none',
      links: [],
      outcome: recordOutcome(match),
      noticeStatus,
      ...(noticeFailureReason === undefined ? {} : { noticeFailureReason }),
      // Envelope pass: no body was fetched, so nothing is retained. An empty
      // excerpt is the truth; a summary assembled from headers would be a
      // body-shaped field holding something that is not the body.
      body: '',
      receivedAt: receivedAt.iso,
    });
  };
}
