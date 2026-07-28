/**
 * Where a found message goes, and the guard that keeps one arrival producing
 * one notice.
 *
 * The watcher deliberately redelivers. Its cursor advances only after a
 * message is fully processed, so a crash, a failed notice or a killed process
 * between fetch and completion leaves the cursor below the message and the
 * next pass fetches it again. That is the right trade — a duplicate suppressed
 * beats a message nobody hears about — but it is only the right trade if
 * something actually suppresses the duplicate. Without this file, the
 * redelivery the design causes on purpose becomes a second notification on the
 * owner's phone, and a reconnect loop becomes a storm of them.
 *
 * Identity is per-source and server-assigned
 * ──────────────────────────────────────────
 * Never the `Message-ID` header. That is written by the sender, so two
 * different messages can carry the same one — which would let a sender
 * suppress a later message by colliding with an earlier one, turning the
 * dedup cache into a way to silence mail.
 *
 * IMAP has a UID, unique within a `UIDVALIDITY` generation, so identity is
 * `imap:<uidValidity>:<uid>`. Gmail's API has neither: it assigns its own
 * opaque message id, so identity is `gmail:<messageId>`. Both are assigned by
 * the receiving server, which is the property that matters. The union is
 * closed and each arm carries only what its own source actually has, so a new
 * source cannot be added by reusing a field that means something else there.
 *
 * Claim, then release on failure
 * ──────────────────────────────
 * The claim happens BEFORE the work, because two concurrent deliveries of one
 * message — an IDLE wake and a fallback poll overlapping — must not both run
 * the pipeline. But a claim that outlives a failed attempt suppresses the
 * retry, and the retry is the recovery. So a failure releases the claim and
 * rethrows: the cursor stays put, the message comes again, and that pass does
 * real work.
 */

import { InboundMessageDedup, inboundDedupKey } from '../../adapters/inbound-dedup.js';
import type { InboundMailSink, InboundMailboxMessage } from './ports.js';

/** How long a handled message stays suppressed. */
export const DEFAULT_INBOUND_MAIL_DEDUP_TTL_MS = 60 * 60_000;

/**
 * The email dedup cache is its own instance, never `ntfyInboundDedup`.
 *
 * Two reasons, and the first is a correctness one: that module-scoped cache
 * carries a ten-minute TTL, and ten minutes is shorter than a crash-restart
 * cycle. The daemon checks for updates hourly and restarts itself at idle, so
 * a message fetched just before a restart would come back after it with its
 * claim already expired, and be announced twice. An hour covers the restart.
 *
 * The second is scope: sharing a cache with ntfy means one surface's traffic
 * evicting another's under the shared entry cap.
 */
export function createInboundMailDedup(
  ttlMs: number = DEFAULT_INBOUND_MAIL_DEDUP_TTL_MS,
  now?: () => number,
): InboundMessageDedup {
  return now === undefined
    ? new InboundMessageDedup(ttlMs)
    : new InboundMessageDedup(ttlMs, undefined, now);
}

/**
 * A message's identity, as the receiving server assigned it.
 *
 * A closed union rather than an optional-field bag: an IMAP message has no
 * Gmail id and a Gmail message has no UIDVALIDITY, and a shape where both are
 * optional is one where a caller can supply neither.
 */
export type InboundMailSourceId =
  | { readonly source: 'imap'; readonly uidValidity: number; readonly uid: number }
  | { readonly source: 'gmail'; readonly messageId: string };

/**
 * The stable identity string for a message.
 *
 * Returns '' when the source did not give a usable id, which
 * `InboundMessageDedup.claim` treats as "cannot dedupe, process it" — a
 * message with no identity is delivered rather than collapsed onto a shared
 * empty key with every other id-less message.
 */
export function inboundMailSourceIdentity(id: InboundMailSourceId): string {
  if (id.source === 'gmail') {
    const trimmed = id.messageId.trim();
    return trimmed.length === 0 ? '' : `gmail:${trimmed}`;
  }
  if (!Number.isInteger(id.uidValidity) || !Number.isInteger(id.uid)) return '';
  if (id.uidValidity <= 0 || id.uid <= 0) return '';
  return `imap:${String(id.uidValidity)}:${String(id.uid)}`;
}

/** The dedup key for one message, scoped to the mailbox it arrived in. */
export function inboundMailDedupKey(input: {
  readonly account: string;
  readonly mailbox: string;
  readonly id: InboundMailSourceId;
}): string {
  return inboundDedupKey(
    'email',
    `${input.account}:${input.mailbox}`,
    inboundMailSourceIdentity(input.id),
  );
}

/** Why a message was not passed on. */
export type InboundMailSuppression = 'duplicate';

export interface InboundMailSinkObserver {
  /** A message was suppressed as a repeat. Never a body. */
  suppressed?(event: {
    readonly account: string;
    readonly mailbox: string;
    /**
     * The scoped dedup key, which already carries the source-qualified
     * identity. Deliberately NOT a `uid`: a Gmail message has no UID, and a
     * field only one source can fill is one the other has to fake.
     */
    readonly key: string;
    readonly reason: InboundMailSuppression;
  }): void;
}

export interface DedupingInboundMailSinkDeps {
  /** The cache. One per daemon, shared across the mailboxes it watches. */
  readonly dedup: InboundMessageDedup;
  /**
   * What happens to a message that is genuinely new.
   *
   * Rejecting means it was NOT handled: the claim is released and the error
   * rethrown, so the watcher leaves its cursor below the message and fetches
   * it again.
   */
  readonly handle: (message: InboundMailboxMessage) => Promise<void>;
  readonly observer?: InboundMailSinkObserver | undefined;
}

/**
 * The sink the watcher is given: suppress repeats, pass on everything else.
 *
 * Deliberately does not know what "handling" means — matching an expectation,
 * writing a record, rendering a notice. It owns exactly one decision, "have I
 * seen this message before", and the thing it wraps owns the rest.
 */
export class DedupingInboundMailSink implements InboundMailSink {
  private readonly deps: DedupingInboundMailSinkDeps;

  constructor(deps: DedupingInboundMailSinkDeps) {
    this.deps = deps;
  }

  async deliver(message: InboundMailboxMessage): Promise<void> {
    // Derived from the message's own discriminant, never assumed. Hardcoding
    // 'imap' here compiled fine while the message type was a single shape, and
    // it would have keyed every Gmail message as `imap:undefined:undefined` —
    // which `inboundMailSourceIdentity` returns '' for, which `claim` treats as
    // "cannot dedupe, process it". Silent total loss of dedup on the Gmail
    // path, which is the owner's path. The union is what caught it.
    const id: InboundMailSourceId = message.source === 'gmail'
      ? { source: 'gmail', messageId: message.resourceId }
      : { source: 'imap', uidValidity: message.uidValidity, uid: message.uid };
    const key = inboundMailDedupKey({
      account: message.account,
      mailbox: message.mailbox,
      id,
    });

    if (!this.deps.dedup.claim(key)) {
      // Handled already. Resolving rather than throwing is deliberate: the
      // message IS dealt with, so the cursor should advance past it. Throwing
      // would pin the cursor below a message that will be suppressed again on
      // every future pass, and the mailbox would never drain.
      try {
        this.deps.observer?.suppressed?.({
          account: message.account,
          mailbox: message.mailbox,
          key,
          reason: 'duplicate',
        });
      } catch {
        // An observer that throws must not turn a suppressed duplicate into a
        // failed delivery, which would stall the cursor.
      }
      return;
    }

    try {
      await this.deps.handle(message);
    } catch (error) {
      // The claim outliving a failed attempt would suppress the retry, and the
      // retry is the recovery. Give it back before rethrowing.
      this.deps.dedup.release(key);
      throw error;
    }
  }
}
