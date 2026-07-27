/**
 * conflict-policy.ts — what to do about a Telegram 409, decided as pure data.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * Inbound Telegram went permanently dead on a live machine. Polling stopped
 * and stayed stopped until a human restarted the daemon; every message in
 * between was unread, with nothing but a log line to say so.
 *
 * Telegram answers `getUpdates` with 409 in two unrelated situations — a
 * registered webhook, and another process long-polling the same token — and
 * they used to be told apart by matching the error description against
 * "terminated by other getUpdates", with "webhook" as the fallback for
 * everything else. So a 409 whose description was missing, reworded, or
 * replaced by an intermediary's own error body was read as a webhook
 * conflict, and the webhook branch gave up after three attempts. A string
 * that has to be exhaustive in order to be safe is a guess, not a
 * classification.
 *
 * The machine's own evidence settled which case it actually was:
 * `getWebhookInfo` reported no webhook, the logs contained no `setWebhook`
 * call, and `deleteWebhook` ran three times without the 409 ever clearing.
 * **A conflict that survives a successful deleteWebhook is not a webhook
 * conflict.**
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 * 1. `getWebhookInfo` is the authority. The description corroborates and
 *    enriches what a person reads; it never decides on its own.
 * 2. `deleteWebhook` is idempotent and harmless, so it is attempted whenever a
 *    webhook is even plausible rather than only when it is proven.
 * 3. **Nothing here is ever terminal.** A stuck webhook can be removed by a
 *    person at any moment; a competing consumer is frequently transient — a
 *    test daemon, a second checkout, a stale process. Both must recover on
 *    their own, so the caller keeps polling either way.
 * 4. Crossing the escalation threshold changes only how LOUDLY it is said.
 *
 * Kept pure so every branch is provable without a socket, a fake server, or a
 * clock.
 */

/** How many conflicts to absorb quietly before escalating to an error. */
export const CONFLICT_ESCALATION_ATTEMPTS = 3;

/** What the supervisor should do about one 409. */
export type TelegramConflictAction =
  | {
      /** A webhook is registered, or plausibly is. Clear it and poll again. */
      readonly kind: 'clear-webhook';
      /** True once this has gone on long enough that a person needs telling. */
      readonly escalate: boolean;
      /** Populated when escalating: what is wrong and what to do about it. */
      readonly reason: string | null;
      /** The url Telegram reported, when it reported one. */
      readonly webhookUrl: string | null;
    }
  | {
      /** Another process holds this token. Report it, back off, poll again. */
      readonly kind: 'competing-consumer';
      readonly escalate: boolean;
      /** Always populated: a coordinator is told on every occurrence. */
      readonly reason: string;
      /** Whether a webhook was implicated first and ruled out by evidence. */
      readonly ruledOutWebhook: boolean;
    };

export interface TelegramConflictInput {
  /** Telegram's `description`, or a synthesized `HTTP nnn` when it sent none. */
  readonly description: string;
  /** The url `getWebhookInfo` reported, or null when it reported none. */
  readonly webhookUrl: string | null;
  /** `cluster.enabled` — whether there is an election to defer to. */
  readonly clustered: boolean;
  /** 1-based count of consecutive conflicts. */
  readonly attempt: number;
}

function competingConsumerReason(detail: string, clustered: boolean): string {
  return `another process is already long-polling this bot token (${detail}). `
    + 'Two consumers cannot share one token. '
    + (clustered
      ? 'Standing down so leader election can decide which node consumes it, and retrying meanwhile.'
      : 'Clustering is off, so there is no election to defer to: backing off and retrying, because the '
        + 'other consumer is often transient (a test daemon, a second checkout, a stale process).');
}

/**
 * Decide what one 409 means and what to do about it.
 *
 * Never returns "give up" — there is no such action, deliberately. See rule 3.
 */
export function classifyTelegramConflict(input: TelegramConflictInput): TelegramConflictAction {
  const detail = input.description.trim() || 'no description';
  const escalate = input.attempt > CONFLICT_ESCALATION_ATTEMPTS;
  const webhookProven = input.webhookUrl !== null && input.webhookUrl.trim().length > 0;
  const descriptionBlamesWebhook = /webhook/i.test(detail);

  if (webhookProven) {
    return {
      kind: 'clear-webhook',
      escalate,
      webhookUrl: input.webhookUrl,
      reason: escalate
        ? `a webhook is registered for this bot (${input.webhookUrl ?? 'unknown url'}) and `
          + `${String(CONFLICT_ESCALATION_ATTEMPTS)} attempts to remove it did not succeed. `
          + 'getUpdates and a registered webhook cannot both be active. Remove the webhook '
          + '(deleteWebhook) or set surfaces.telegram.mode=webhook. '
          + 'Polling keeps retrying and will resume by itself once the webhook is gone.'
        : null,
    };
  }

  if (descriptionBlamesWebhook && !escalate) {
    // Telegram blamed a webhook and reports none. Contradictory, and clearing
    // costs nothing, so clear and look again before drawing a conclusion.
    return { kind: 'clear-webhook', escalate: false, webhookUrl: null, reason: null };
  }

  if (descriptionBlamesWebhook) {
    // The description blamed a webhook, Telegram reports none, and repeated
    // deletes changed nothing. This is the exact shape the live failure had,
    // and it is where the old code declared the conflict unrecoverable.
    const ruledOut = `${detail} — but getWebhookInfo reports no webhook registered, and `
      + `${String(CONFLICT_ESCALATION_ATTEMPTS)} deleteWebhook attempts did not clear it, `
      + 'so this is another process polling the same token rather than a webhook';
    return {
      kind: 'competing-consumer',
      escalate: true,
      ruledOutWebhook: true,
      reason: competingConsumerReason(ruledOut, input.clustered),
    };
  }

  return {
    kind: 'competing-consumer',
    escalate,
    ruledOutWebhook: false,
    reason: competingConsumerReason(detail, input.clustered),
  };
}
