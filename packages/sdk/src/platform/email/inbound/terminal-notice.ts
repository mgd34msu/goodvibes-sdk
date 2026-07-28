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

export interface InboundTerminalFailureAnnouncerOptions {
  /**
   * Where the owner is reached. Takes the STRUCTURE, so the composition root's
   * delivery helper picks the channel and its escaper.
   *
   * Its result is deliberately unread: whether a notice reached a route is the
   * delivery layer's disclosure to make, and a supervisor that awaited it would
   * be blocking a status transition on somebody's phone.
   */
  readonly send: (notice: StructuredNotice) => Promise<unknown>;
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
  /** The condition last announced, or null when nothing is outstanding. */
  let announced: string | null = null;

  return {
    terminalFailure(failure: InboundMailTerminalFailure): void {
      // Keyed on the mailbox and the reason, never on the detail: the detail
      // carries the server's wording, and a session id inside it would make
      // every hourly re-probe look like a new condition.
      const key = `${failure.account}:${failure.mailbox}:${failure.reason}`;
      log('Inbound mail stopped for a reason only a change can clear', {
        surface: 'email-inbound',
        account: failure.account,
        mailbox: failure.mailbox,
        reason: failure.reason,
        detail: failure.detail,
        action: failure.fix,
        announced: announced !== key,
      });
      if (announced === key) return;
      announced = key;
      try {
        void options.send(renderInboundMailStoppedNotice({
          account: failure.account,
          mailbox: failure.mailbox,
          reason: failure.reason,
          detail: failure.detail,
          fix: failure.fix,
          at: failure.at,
        })).catch((error: unknown) => {
          log('The inbound-mail stopped notice could not be delivered', {
            surface: 'email-inbound',
            account: failure.account,
            mailbox: failure.mailbox,
            reason: failure.reason,
            detail: summarizeError(error),
          });
        });
      } catch (error) {
        // A `send` that throws synchronously rather than rejecting. Same rule:
        // the reporting path cannot become a failure of its own.
        log('The inbound-mail stopped notice could not be delivered', {
          surface: 'email-inbound',
          account: failure.account,
          mailbox: failure.mailbox,
          reason: failure.reason,
          detail: summarizeError(error),
        });
      }
    },

    stateChanged(transition: InboundCapabilityTransition): void {
      // Anything that is not `insufficient` means the watcher is reading mail
      // again, so the next terminal failure is genuinely new and is announced.
      if (transition.to.state !== 'insufficient') announced = null;
    },
  };
}
