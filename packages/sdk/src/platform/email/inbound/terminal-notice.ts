/**
 * terminal-notice.ts — routing a terminal inbound-mail failure to the OWNER.
 *
 * docs/inbound-email.md §3.4b: *"A terminal state is announced, not merely
 * recorded... Silent permanent death is the failure this entire round exists to
 * eliminate."*
 *
 * Everything needed for that already existed and none of it was joined up. The
 * watcher reaches a terminal verdict, builds an `InboundMailTerminalFailure`
 * carrying the exact remedial step, and announces it once per transition. The
 * supervisor forwards it. The composition root holds
 * `deliverStructuredNotice` — the same port arriving mail is announced through
 * — and used it for arriving mail and not for the one condition that means no
 * mail will ever arrive again: the only consumer of `terminalFailure` was
 * `logger.error`. A log line is a record, not an announcement, and this is the
 * capability whose whole promise is that the owner does not have to be watching
 * for it to be told.
 *
 * Two properties this file is responsible for.
 *
 * **Once per transition, not once per probe.** The watcher already suppresses
 * a repeat of the same verdict, but it is not the only thing that can produce a
 * terminal failure — a supervisor whose run loop dies produces one too — so the
 * latch lives here as well, keyed on the condition rather than on the wording:
 * a server that phrases the same refusal differently each hour must not become
 * an hourly alarm. Recovering to any non-`insufficient` state re-arms it, so
 * the SECOND time the credential is refused he is told again.
 *
 * **Structure, never rendered text.** The notice is built from structured
 * fields by `renderInboundMailStoppedNotice`: our reason and our fix as
 * `literal` spans, the server's own wording as an `untrusted` one. Nothing here
 * ever holds a channel-formatted string, so the escaping stays where the
 * channel is known (§7.2).
 */

import { renderInboundMailStoppedNotice } from '../inbound-notice.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type { StructuredNotice } from '../inbound-notice.js';
import type {
  InboundCapabilityTransition,
  InboundMailObserver,
  InboundMailTerminalFailure,
} from './ports.js';

/**
 * Whether a notice actually reached the owner.
 *
 * Never a bare boolean and never `void`, for the reason the whole file exists:
 * the delivery port RESOLVES a refusal rather than rejecting it, so a caller
 * that only catches sees every refusal as a success. `void` would be worse
 * still — a port that says nothing forces this module to guess, and the guess
 * that used to be made here was "it went out".
 *
 * Structurally compatible with the daemon layer's `SurfaceNoticeDelivery`,
 * which is what the composition root binds, without importing across the
 * layer boundary.
 */
export type InboundNoticeDelivery =
  | { readonly delivered: true }
  | {
    readonly delivered: false;
    /** Which guard refused, when the delivery layer named one. */
    readonly reason?: string | undefined;
    /** The transport's own message, when there was one. */
    readonly error?: string | undefined;
  };

export interface InboundTerminalFailureAnnouncerOptions {
  /**
   * Where the owner is reached. Takes the STRUCTURE, so the composition root's
   * delivery helper picks the channel and its escaper.
   *
   * Its result is READ, and this is the correction that matters most in this
   * file. It used to be `Promise<unknown>`, documented as "deliberately
   * unread" on the reasoning that delivery disclosure belonged to the delivery
   * layer. That reasoning had a hole in it: `deliverStructuredNotice` reports a
   * refusal by RESOLVING `{ delivered: false, reason }`, not by rejecting, so
   * the `.catch()` this module relied on never fired. With no route binding
   * configured — the ordinary state of a fresh install — the owner was not
   * told, the latch was set anyway, every later occurrence was suppressed, and
   * the log line recorded `announced: true`. A log asserting the owner was told
   * when he was not, for the one condition that means no mail will ever arrive
   * again.
   *
   * The send is still not awaited by the observer, which stays synchronous: the
   * result is inspected in a continuation, so a status transition is never
   * blocked on somebody's phone.
   */
  readonly send: (notice: StructuredNotice) => Promise<InboundNoticeDelivery>;
  /** Overridable for tests that assert on what was logged. */
  readonly log?: ((message: string, fields: Record<string, unknown>) => void) | undefined;
}

/** An observer that announces terminal failures and re-arms on recovery. */
export interface InboundTerminalFailureAnnouncer extends InboundMailObserver {
  terminalFailure(failure: InboundMailTerminalFailure): void;
  stateChanged(transition: InboundCapabilityTransition): void;
}

/**
 * Build the observer the composition root passes to `InboundMailSupervisor`.
 *
 * Synchronous, because `InboundMailObserver` is synchronous: it is a report
 * sink and the reporting path must never be able to hold up the watcher. The
 * send is started and its failure is logged rather than propagated — a
 * notification route being down must not become a second failure on top of the
 * one being reported.
 */
export function createInboundTerminalFailureAnnouncer(
  options: InboundTerminalFailureAnnouncerOptions,
): InboundTerminalFailureAnnouncer {
  const log = options.log ?? ((message, fields) => { logger.error(message, fields); });
  /**
   * The condition whose notice REACHED the owner, or null when none has.
   *
   * Set only after a confirmed delivery. It used to be set before the send, on
   * the assumption that attempting was the same as arriving — which made the
   * FIRST failure permanent: the owner was never told, and the latch then
   * suppressed every subsequent occurrence of the same condition for the life
   * of the process.
   */
  let announced: string | null = null;
  /**
   * Conditions with a send outstanding right now.
   *
   * Separate from `announced` because the two answer different questions. This
   * one stops a burst of identical failures from firing a send each while the
   * first is still in flight; `announced` stops them once one has actually
   * landed. Collapsing them is what produced the defect — a single flag cannot
   * mean both "being tried" and "confirmed".
   */
  const inFlight = new Set<string>();
  /**
   * Bumped whenever the watcher recovers.
   *
   * A send that started before a recovery must not latch after it: by the time
   * it resolves, the condition it describes has cleared and re-occurred, and
   * that re-occurrence is a new thing the owner has not been told about.
   */
  let generation = 0;

  return {
    terminalFailure(failure: InboundMailTerminalFailure): void {
      // Keyed on the mailbox and the reason, never on the detail: the detail
      // carries the server's wording, and a session id inside it would make
      // every hourly re-probe look like a new condition.
      const key = `${failure.account}:${failure.mailbox}:${failure.reason}`;
      const base = {
        surface: 'email-inbound',
        account: failure.account,
        mailbox: failure.mailbox,
        reason: failure.reason,
      };

      // The CONDITION, recorded synchronously. Deliberately carries no
      // `announced` field: nothing has been sent at this point, so there is no
      // honest value for it. Claiming one here is precisely the defect — the
      // old line wrote `announced: true` whenever the latch happened to be
      // clear, which is a statement about a local variable dressed up as a
      // statement about the owner.
      log('Inbound mail stopped for a reason only a change can clear', {
        ...base,
        detail: failure.detail,
        action: failure.fix,
        alreadyAnnounced: announced === key,
      });

      if (announced === key || inFlight.has(key)) return;

      const undelivered = (detail: string, delivery: string): void => {
        log('The inbound-mail stopped notice could not be delivered', {
          ...base,
          announced: false,
          delivery,
          detail,
        });
      };

      const sentAt = generation;
      inFlight.add(key);
      let pending: Promise<InboundNoticeDelivery>;
      try {
        pending = options.send(renderInboundMailStoppedNotice({
          account: failure.account,
          mailbox: failure.mailbox,
          reason: failure.reason,
          detail: failure.detail,
          fix: failure.fix,
          at: failure.at,
        }));
      } catch (error) {
        // A `send` that throws synchronously rather than rejecting. The
        // reporting path cannot become a failure of its own — but it also does
        // not get to latch, because nothing was delivered.
        inFlight.delete(key);
        undelivered(summarizeError(error), 'send-threw');
        return;
      }

      void pending.then(
        (result) => {
          inFlight.delete(key);
          // A port that answered with something other than a delivery verdict
          // — an untyped embedder returning `undefined`, say. It has not said
          // the owner was reached, so he was not reached. Reading `.delivered`
          // off it unguarded would throw inside this handler, where the
          // rejection arm below cannot catch it.
          if (result === null || typeof result !== 'object' || !('delivered' in result)) {
            undelivered(
              'the notice port returned no delivery verdict, so whether the owner was '
              + 'reached is unknown and must not be assumed',
              'no-verdict',
            );
            return;
          }
          if (!result.delivered) {
            // The case `.catch()` could never see.
            undelivered(
              result.error ?? 'the delivery layer refused the notice',
              result.reason ?? 'refused',
            );
            return;
          }
          if (sentAt !== generation) {
            // It landed, but the watcher recovered while it was in flight, so
            // the condition has since cleared. Latching now would silence the
            // re-occurrence the owner has not heard about.
            log('The inbound-mail stopped notice was delivered after the condition cleared', {
              ...base,
              announced: true,
              stale: true,
            });
            return;
          }
          announced = key;
          log('The inbound-mail stopped notice was delivered to the owner', {
            ...base,
            announced: true,
          });
        },
        (error: unknown) => {
          inFlight.delete(key);
          undelivered(summarizeError(error), 'send-rejected');
        },
      );
    },

    stateChanged(transition: InboundCapabilityTransition): void {
      // Anything that is not `insufficient` means the watcher is reading mail
      // again, so the next terminal failure is genuinely new and is announced.
      if (transition.to.state === 'insufficient') return;
      announced = null;
      generation += 1;
      // A send still in flight belongs to the condition that just cleared, so
      // it must not block the next one from being attempted.
      inFlight.clear();
    },
  };
}
