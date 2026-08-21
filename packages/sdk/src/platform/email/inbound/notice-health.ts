/**
 * notice-health.ts, a refusal to announce arriving mail, made VISIBLE.
 *
 * docs/inbound-email.md §3.4b: *"A terminal state is announced, not merely
 * recorded... Silent permanent death is the failure this entire round exists to
 * eliminate."* `terminal-notice.ts` applied that to the watcher dying. This
 * file applies the same rule one seam further along, to the condition that is
 * strictly more likely and was strictly less visible: the watcher is alive,
 * mail is arriving, every message is recorded, and not one of them is announced
 * to anybody.
 *
 * The refusals that reach here are the STRUCTURAL ones, `no-route-binding`,
 * `surface-delivery-disabled`, `no-deliverable-target`,
 * `unsupported-delivery-surface`, `empty-text`. The intake deliberately does
 * not throw on any of them, and that decision is right: throwing would pin the
 * cursor below a message that fails identically on every future pass, and the
 * mailbox would never drain. But "not retried" was implemented as "return
 * normally", and returning normally is indistinguishable from success
 * everywhere upstream: the cursor advanced, the sink kept its claim, the
 * supervisor went on reporting `idle`, and the health entry went on saying
 * `healthy`. The owner had mail arriving that he was never told about, and
 * nothing anywhere said so.
 *
 * So a permanent refusal is not merely recorded. It is latched here, counted,
 * logged once per condition, and folded into the two things a person actually
 * reads, `email.inbound.status` and the health entry, which reports `degraded`
 * for exactly as long as the condition lasts.
 *
 * Why the announcement is not itself a notice
 * ───────────────────────────────────────────
 * `terminal-notice.ts` reaches the owner by SENDING him one. That is not
 * available here and it is worth being explicit about why rather than leaving
 * the asymmetry to look like an oversight: the thing being reported IS the
 * notice route refusing. A "your notice route is refusing" notice would be sent
 * through the route that is refusing, and would be refused for the same reason,
 * which is a loop that reports nothing and buries the real refusal under a
 * second one. The honest surfaces are the ones that do not depend on the broken
 * path, the status verb, the health entry, and the log, and this file drives
 * all three.
 *
 * Once per CONDITION, not once per message
 * ────────────────────────────────────────
 * A mailbox with an unusable notice route refuses every message, and a log line
 * per message is a log nobody reads. The latch is keyed on the reason, exactly
 * as `terminal-notice.ts` keys its own on the mailbox and reason rather than on
 * the wording. The COUNT keeps climbing, because "37 messages have arrived and
 * none were announced" is the number that makes the state undeniable, and a
 * latch that suppressed the count as well as the line would hide it.
 */

import { logger } from '../../utils/logger.js';

/** One refusal to announce, as the intake reports it. */
export interface InboundNoticeRefusalEvent {
  /**
   * The refusal's own name, `no-route-binding`, `surface-delivery-disabled`,
   * `route-binding-disabled`, … Kept as a plain string rather than narrowed to
   * `SurfaceNoticeRefusal` because the cause is sometimes finer-grained than
   * the delivery layer's vocabulary: a missing binding because the owner has
   * connected no channel and a missing binding because the whole route-binding
   * feature is switched off are one refusal reason and two different problems,
   * and collapsing them is what let the second one read as the first.
   */
  readonly reason: string;
  /** What is wrong, in one sentence, for a person. */
  readonly detail: string;
  /** The remedial step. Never empty, a report with no fix is a complaint. */
  readonly fix: string;
  /** When this message was refused, ISO. */
  readonly at: string;
}

/** The condition as it currently stands, or nothing when notices are getting through. */
export interface InboundNoticeRefusalState extends InboundNoticeRefusalEvent {
  /** When the FIRST message was refused under this condition. */
  readonly since: string;
  /** How many messages have arrived and gone unannounced under it. */
  readonly unannounced: number;
}

/**
 * Where the intake reports whether the owner is actually being told, and where
 * the supervisor reads it back.
 *
 * Deliberately not an `InboundMailObserver`: an observer is a fan-out of events
 * that may have no subscriber, and this is a piece of STATE two collaborators
 * share, the intake writes it, `status` and `health()` read it. Routing it
 * through the observer stream is what the previous shape did with everything
 * else, and the composition root's observer implements `terminalFailure` and
 * `stateChanged` and nothing else, so a note posted there would have gone
 * precisely nowhere.
 */
export interface InboundNoticeHealth {
  /** A message was recorded and could not be announced. */
  refused(event: InboundNoticeRefusalEvent): void;
  /**
   * A notice reached the owner, so whatever was wrong is no longer wrong.
   *
   * Clears the latch and re-arms the log, which is the same discipline
   * `terminal-notice.ts` applies on recovery: the SECOND time notices start
   * failing, he is told again.
   */
  announced(at: string): void;
  /** The live condition, or null when nothing is being refused. */
  get(): InboundNoticeRefusalState | null;
}

export interface InboundNoticeHealthOptions {
  /** Overridable so a test can assert on what was logged rather than scrape stderr. */
  readonly log?: ((message: string, fields: Record<string, unknown>) => void) | undefined;
}

/**
 * The sentence `status.reason` and the health entry carry.
 *
 * A function rather than a field on the state, so every surface renders the
 * same words: the supervisor's reason string, the health entry's reason string
 * and the disclosure verb all call this, and there is no second wording to
 * drift from the first.
 */
export function describeNoticeRefusal(state: InboundNoticeRefusalState): string {
  const plural = state.unannounced === 1 ? 'message has' : 'messages have';
  return `Mail is arriving and is NOT being announced (${state.reason}): ${state.detail} ${state.fix} `
    + `${String(state.unannounced)} ${plural} been recorded without a notice since ${state.since}.`;
}

export function createInboundNoticeHealth(
  options: InboundNoticeHealthOptions = {},
): InboundNoticeHealth {
  const log = options.log ?? ((message, fields) => { logger.error(message, fields); });
  let state: InboundNoticeRefusalState | null = null;

  return {
    refused(event: InboundNoticeRefusalEvent): void {
      // A change of reason is a change of condition: the owner fixed the
      // missing binding and the surface then refused delivery is two problems,
      // and the second one has to be logged rather than absorbed into the
      // first one's latch.
      const continuing = state !== null && state.reason === event.reason;
      const next: InboundNoticeRefusalState = {
        ...event,
        since: continuing ? state!.since : event.at,
        unannounced: continuing ? state!.unannounced + 1 : 1,
      };
      state = next;
      if (continuing) return;
      log('Inbound mail is being recorded but not announced', {
        surface: 'email-inbound',
        reason: next.reason,
        detail: next.detail,
        action: next.fix,
        since: next.since,
        // Never phrased as a claim about the owner. This line says what the
        // daemon did, recorded, did not announce, and nothing about what he
        // has or has not seen, which is the wording fault §13.8 records.
        announcedToOwner: false,
      });
    },

    announced(at: string): void {
      if (state === null) return;
      const cleared = state;
      state = null;
      log('Inbound mail notices are reaching the owner again', {
        surface: 'email-inbound',
        clearedReason: cleared.reason,
        unannouncedWhileRefused: cleared.unannounced,
        since: cleared.since,
        at,
      });
    },

    get(): InboundNoticeRefusalState | null {
      return state;
    },
  };
}
