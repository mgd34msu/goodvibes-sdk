/**
 * turn-end-notice.ts, the Orchestrator's own end-of-turn popup (bell above 5s,
 * desktop notification above 30s, behavior.notifyOnComplete).
 *
 * It used to read "GoodVibes / Response complete (42s)" for every turn,
 * finished or not. It now names the turn and says how it ended (owner ruling
 * 2026-09-29): see runtime/turn-notification.ts for the words and the
 * behavior.notificationsMetadataOnly privacy rule.
 *
 * The Orchestrator records how the turn ended as it happens (a cancel in the
 * abort path, a failure reason in the error path or from the turn loop) and
 * calls send() once from its finally block, which reads and resets the record.
 */
import { notifyCompletion } from '../utils/notify.js';
import { buildTurnNotification, readNotificationsMetadataOnly, resolveTurnName } from '../runtime/turn-notification.js';

/** The config and conversation surface send() reads. */
export interface TurnEndNoticeContext {
  readonly configGet: (key: string) => unknown;
  readonly conversation: { readonly title: string; getTitleSource(): 'user' | 'system' };
  readonly turnText: string;
  readonly sessionId: string;
  readonly durationMs: number;
}

export class TurnEndNotice {
  private cancelled = false;
  private failed = false;
  private failureReason: string | null = null;

  /** Delivery; a field so tests can read the text the popup would carry. */
  notify: typeof notifyCompletion = notifyCompletion;

  /** The turn was cancelled (the abort path). */
  markCancelled(): void {
    this.cancelled = true;
  }

  /** The turn failed; the first reason given is kept. */
  markFailed(reason?: string | null): void {
    this.failed = true;
    if (reason && !this.failureReason) this.failureReason = reason;
  }

  /** Send the popup (unless behavior.notifyOnComplete is off) and reset for the next turn. */
  send(context: TurnEndNoticeContext): void {
    const outcome = this.cancelled ? 'cancelled' : this.failed ? 'failed' : 'completed';
    const reason = this.failureReason;
    this.cancelled = false;
    this.failed = false;
    this.failureReason = null;
    if (context.configGet('behavior.notifyOnComplete') === false) return;
    const notice = buildTurnNotification({
      outcome,
      elapsedMs: context.durationMs,
      name: resolveTurnName({ title: context.conversation.title, titleSource: context.conversation.getTitleSource(), turnText: context.turnText }),
      reason,
      sessionId: context.sessionId,
    }, { metadataOnly: readNotificationsMetadataOnly(context.configGet) });
    this.notify(notice.title, notice.body, context.durationMs);
  }
}
