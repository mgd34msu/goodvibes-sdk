/**
 * approval-updates.ts — watching approval records over the push channel instead
 * of asking again every few seconds.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * Two consumers polled `approvals.list`: the client raise seam (approval-raiser
 * .ts, every 750ms while a prompt was open) and every surface's approvals panel
 * (a 15s refresh). The 15s one is the worse of the two — an ask raised on a
 * phone took up to fifteen seconds to appear on the terminal that could answer
 * it, and a decision made elsewhere left a stale prompt on screen for the same
 * window.
 *
 * `control.approval_update` already carries every transition of every record —
 * raised, claimed, approved, denied, cancelled, expired — the moment the broker
 * records it, with the whole record in the payload so nothing needs a follow-up
 * read. This is the subscription over it.
 *
 * ── Why it degrades rather than insists ────────────────────────────────────
 *
 * A stream can be refused (no daemon, a 401, a proxy that will not hold a
 * connection). A permission ask blocks a tool call, so a consumer that cannot
 * open a stream must still work — {@link watchApprovalUpdates} reports failure
 * to the caller instead of throwing, and the caller keeps whatever fallback it
 * had. Push is the fast path, not a new dependency.
 *
 * ── Ownership is unchanged ─────────────────────────────────────────────────
 *
 * The record on the wire is the daemon's. A subscriber renders what the record
 * says, not what it locally believes it asked for — the same parity contract
 * the decide verbs have always documented.
 */

import { openServerSentEventStream } from '../transports/sse-stream.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** The wire event name the broker publishes approval transitions on. */
export const APPROVAL_UPDATE_WIRE_EVENT = 'approval-update';
/** The event domain a subscriber must include when it narrows with `?domains=`. */
export const APPROVAL_UPDATE_DOMAIN = 'permissions';

/**
 * An approval record as a subscriber needs to read it. Deliberately narrow:
 * the id to match, the status to act on, and the decision when there is one.
 * The full record is on the event for rendering.
 */
export interface ApprovalUpdateRecord {
  readonly id: string;
  readonly status?: string | undefined;
  readonly decision?: {
    readonly approved?: boolean | undefined;
    readonly remember?: boolean | undefined;
    readonly note?: string | undefined;
  } | undefined;
  readonly [key: string]: unknown;
}

/** One `control.approval_update` frame. */
export interface ApprovalUpdateNotice {
  readonly approval: ApprovalUpdateRecord;
  readonly createdAt: number;
}

export interface WatchApprovalUpdatesOptions {
  /** The daemon's base URL, e.g. `http://127.0.0.1:3421`. */
  readonly baseUrl: string;
  /** Bearer token for the control plane. Resolved per connection attempt. */
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  /** Called for every approval transition the daemon publishes. */
  readonly onUpdate: (notice: ApprovalUpdateNotice) => void;
  /** Called when the stream drops for good. The caller decides what to do about it. */
  readonly onTerminate?: ((error: unknown) => void) | undefined;
  /** Injectable fetch (tests, or a relay-tunnelled fetch). */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A live subscription. `close()` is idempotent. */
export interface ApprovalUpdateSubscription {
  close(): void;
}

/** Whether a frame is an approval notice we can act on. */
export function readApprovalUpdateNotice(payload: unknown): ApprovalUpdateNotice | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const approval = record['approval'];
  if (typeof approval !== 'object' || approval === null) return null;
  const id = (approval as Record<string, unknown>)['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const createdAt = record['createdAt'];
  return {
    approval: approval as ApprovalUpdateRecord,
    createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
  };
}

/**
 * The control-plane events URL narrowed to the permissions domain.
 *
 * Narrowing matters: an unnarrowed subscriber receives every domain the daemon
 * publishes, which for a client that only wants approvals is a lot of traffic
 * it will discard.
 */
export function approvalUpdateStreamUrl(baseUrl: string): string {
  const url = new URL('/api/control-plane/events', baseUrl);
  url.searchParams.set('domains', APPROVAL_UPDATE_DOMAIN);
  return url.toString();
}

/**
 * Open a subscription to approval transitions.
 *
 * Resolves to null when the stream could not be opened — the caller keeps
 * whatever it was doing before, and the reason is logged once rather than
 * thrown into a keystroke path.
 */
export async function watchApprovalUpdates(
  options: WatchApprovalUpdatesOptions,
): Promise<ApprovalUpdateSubscription | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    logger.debug('[approvals] no fetch implementation is available for the approval-update stream');
    return null;
  }
  try {
    const close = await openServerSentEventStream(
      fetchImpl,
      approvalUpdateStreamUrl(options.baseUrl),
      {
        onEvent: (eventName, payload) => {
          if (eventName !== APPROVAL_UPDATE_WIRE_EVENT) return;
          const notice = readApprovalUpdateNotice(payload);
          if (!notice) return;
          try {
            options.onUpdate(notice);
          } catch (error) {
            // A throwing subscriber must not take the stream down for every
            // other watcher on it.
            logger.debug('[approvals] an approval-update subscriber threw', { error: summarizeError(error) });
          }
        },
        onTerminate: ({ error }) => options.onTerminate?.(error),
      },
      {
        ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    let closed = false;
    return {
      close: (): void => {
        if (closed) return;
        closed = true;
        close();
      },
    };
  } catch (error) {
    logger.info('[approvals] the approval-update stream could not be opened; falling back to reading records on demand', {
      error: summarizeError(error),
    });
    return null;
  }
}

/**
 * A one-shot wait for a specific approval id to be decided, over the push
 * channel.
 *
 * Returns the decided record, or null when `stop()` says the caller no longer
 * cares (its own prompt was answered) or the stream ended without a decision.
 * The seam every raise path wants: raise, then watch the id you were handed.
 */
export async function awaitApprovalDecision(input: {
  readonly subscribe: (onUpdate: (notice: ApprovalUpdateNotice) => void) => Promise<ApprovalUpdateSubscription | null>;
  readonly approvalId: string;
  readonly isDecided: (record: ApprovalUpdateRecord) => boolean;
  readonly stop: () => boolean;
}): Promise<ApprovalUpdateRecord | null> {
  let settle: ((record: ApprovalUpdateRecord | null) => void) | null = null;
  const decided = new Promise<ApprovalUpdateRecord | null>((resolve) => {
    settle = resolve;
  });
  const subscription = await input.subscribe((notice) => {
    if (notice.approval.id !== input.approvalId) return;
    if (input.stop()) {
      settle?.(null);
      return;
    }
    if (input.isDecided(notice.approval)) settle?.(notice.approval);
  });
  if (!subscription) return null;
  try {
    return await decided;
  } finally {
    subscription.close();
  }
}
