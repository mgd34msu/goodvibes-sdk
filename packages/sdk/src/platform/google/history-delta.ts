/**
 * Gmail incremental sync via `users.history.list`.
 *
 * Endpoint shape verified against Google's live API reference on 2026-07-27,
 * not recalled from training data:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 *
 *   - `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/history`
 *     Query parameters: `startHistoryId` (string, **required**), `maxResults`
 *     (uint32, default 100, max 500), `pageToken` (string), `labelId`
 *     (string), `historyTypes[]` (enum, repeatable).
 *   - `historyTypes[]` values are singular: `messageAdded`, `messageDeleted`,
 *     `labelAdded`, `labelRemoved`. The response's per-record arrays are the
 *     plural forms: `messagesAdded`, `messagesDeleted`, `labelsAdded`,
 *     `labelsRemoved`.
 *   - Response shape: `{ history: History[], nextPageToken?: string,
 *     historyId: string }`. Pagination is the ordinary
 *     `pageToken`/`nextPageToken` pair.
 *   - `startHistoryId` "should be obtained from the historyId of a message,
 *     thread, or previous list response" (the guide page additionally notes
 *     `messages.get`/`messages.list` as where a caller reads a message's
 *     `historyId` the first time — it does not mention `users.getProfile`
 *     for this purpose).
 *   - Authorization: the method requires one of `https://mail.google.com/`,
 *     `https://www.googleapis.com/auth/gmail.modify`,
 *     `https://www.googleapis.com/auth/gmail.readonly`, or
 *     `https://www.googleapis.com/auth/gmail.metadata`. **`gmail.metadata`
 *     authorizes the call but does not authorize what this module needs the
 *     call for.** Per Google's scope reference
 *     (https://developers.google.com/workspace/gmail/api/auth/scopes,
 *     verified live): `gmail.metadata` is "View your email message metadata
 *     such as labels and headers, but not the email body" — verbatim, its
 *     own description excludes the body. `gmail.readonly` is "View your
 *     email messages and settings," `gmail.modify` adds compose/send, and
 *     `https://mail.google.com/` is full access; all three include the body.
 *     So a token holding only `gmail.metadata` can list what changed but
 *     this module cannot do anything useful with that: the whole point of a
 *     delta here is new message bodies to match against verification
 *     expectations, and metadata-only can never produce one. See the
 *     `metadata-scope-only` outcome below.
 *   - **The too-old case, verbatim from the docs**: "Supplying an invalid or
 *     out of date startHistoryId typically returns an HTTP 404 error code. A
 *     historyId is typically valid for at least a week, but in some rare
 *     circumstances may be valid for only a few hours." and "If you receive
 *     an HTTP 404 error response, your application should perform a full
 *     sync." There is no partial-gap recovery documented — a 404 here means
 *     the whole window aged out, not that some records are missing.
 *
 * Two properties this module is responsible for, on top of what the
 * endpoint gives for free:
 *
 *   1. **The scope gate is load-bearing, and it is checked, never assumed.**
 *      `historyListDelta` reads the token's actual granted scopes
 *      (`GoogleTokenManager.scopes()`) rather than inferring availability
 *      from config or from the scopes the setup flow requested. Google's own
 *      restricted-scope grant model means a token can carry fewer scopes
 *      than were ever asked for, and inferring from the request would then
 *      be exactly the wrong assumption at exactly the moment it matters.
 *      With no history-capable scope present, the result is a typed
 *      `unavailable: 'no-gmail-scope'` outcome, never an empty success. An
 *      empty delta and "I am not allowed to look" are opposite facts, and
 *      collapsing them into one shape is how a mailbox goes quiet with
 *      nobody noticing.
 *
 *   2. **A 404 on `startHistoryId` is a resync signal, not silence.** Per the
 *      live docs quoted above, it means the requested history window has
 *      aged out of Gmail's retention. That becomes a typed
 *      `unavailable: 'resync-required'` outcome that tells the caller to
 *      fall back to a full mailbox listing and re-establish the cursor from
 *      a fresh `historyId`, rather than degrading into "no new messages".
 *
 *   3. **A metadata-only grant is gated too, and gated separately from "no
 *      scope at all".** A body-less delta and a delta with bodies are
 *      opposite facts in exactly the same way an empty delta and "not
 *      allowed to look" are: a caller that mistook one for the other would
 *      believe a verification email's link was checked when the body it
 *      lived in was never fetched. So `historyListDelta` never calls
 *      `history.list` at all for a metadata-only token — there is nothing
 *      useful it could do with the result — and instead returns
 *      `unavailable: 'metadata-scope-only'`, a third reason distinct from
 *      both `no-gmail-scope` and `resync-required` and from an `ok: true`
 *      success.
 *
 *   4. **"Gone" and "we could not read it" are separated, and the delta stops
 *      for the second.** `history.list` names ids and `messages.get` fetches
 *      them; the two are separate calls and anything can happen in between. A
 *      message DELETED in that gap is genuinely absent and is dropped. A
 *      message we merely failed to fetch — a 429, a 500, a refused token, a
 *      socket that never answered — is still sitting in the owner's mailbox,
 *      and both used to arrive here as the same `!fetched.ok` and be dropped
 *      alike.
 *
 *      That collapse is the ambiguity `ImapEnvelopeBatch.unreadable` exists to
 *      remove on the IMAP side, and it does more damage here, because Gmail's
 *      history is a FORWARD-ONLY log. A caller that took the resulting empty
 *      success and advanced its `startHistoryId` past a rate-limited fetch
 *      could never ask for those records again: the message is not delayed, it
 *      is unreachable, and nothing anywhere reports a fault. So the delta
 *      carries `unreadable`, on the same contract and for the same reason, and
 *      a caller cannot persist the new position without stepping over it.
 */

import type { GoogleApiFailure, GoogleApiResult, GmailMessageBody } from './api-client.js';

/**
 * Scopes that authorize `users.history.list` itself, per Google's live
 * "Authorization scopes" listing for the method (see module header).
 * Includes `gmail.metadata`, which authorizes the call but not what this
 * module needs the call for — see `GMAIL_BODY_SCOPES`.
 */
export const GMAIL_HISTORY_SCOPES: readonly string[] = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
];

/**
 * Scopes that authorize reading the message **body**, per Google's live
 * scope reference (https://developers.google.com/workspace/gmail/api/auth/scopes,
 * verified live). Deliberately excludes `gmail.metadata`, whose own
 * description reads "but not the email body" — verbatim.
 */
export const GMAIL_BODY_SCOPES: readonly string[] = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
];

/**
 * The one `messages.get` status that means the message itself is not there.
 *
 * Named as a constant because the CLASSIFICATION is the load-bearing part, not
 * the number: this is the sole status on which a message is dropped from a
 * delta and the delta is allowed to move past it. Everything else — every
 * status, and the `null` a transport fault carries — is treated as "we failed
 * to read it" and holds the delta.
 *
 * The list is deliberately narrow rather than exhaustive, and it is narrow in
 * the safe direction. Widening it is how mail is lost: each status added here
 * is a new way for a message still sitting in the owner's mailbox to be
 * stepped over and never asked for again, because Gmail's history is
 * forward-only. Leaving a genuinely-permanent status OUT costs a delta that
 * retries and a verdict that stops saying healthy — visible, bounded, and
 * recoverable. So an unrecognised status is retried, never dropped.
 */
const GMAIL_MESSAGE_GONE_STATUS = 404;

/** `historyTypes[]` values, singular form, exactly as Gmail's API expects them. */
export type GmailHistoryType = 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';

export interface HistoryDeltaOptions {
  /** The last high-water mark this caller has fully processed. */
  readonly startHistoryId: string;
  readonly labelId?: string;
  /** Defaults to `['messageAdded']` — the shape this module exists to serve: new mail. */
  readonly historyTypes?: readonly GmailHistoryType[];
  /** Per-page size, 1-500. Google defaults to 100 when omitted. */
  readonly maxResultsPerPage?: number;
}

/**
 * A message this delta named and could not read.
 *
 * The Gmail counterpart of `ImapFetchProblem`, and deliberately the same idea
 * rather than a second one: a fetch that failed is not a message that is gone,
 * on either source. Carries the id the delta named, the status Google answered
 * with, and Google's own plain-language description. Never message content —
 * there is none, that is the whole point.
 */
export interface GmailFetchProblem {
  /** The Gmail message id `history.list` named and `messages.get` would not return. */
  readonly id: string;
  /** What Google answered, or null for a transport fault that never got a status. */
  readonly status: number | null;
  /** Plain language, safe to log and safe to show an owner. */
  readonly detail: string;
  /**
   * Google's own remedial step for this failure, carried rather than rewritten.
   *
   * Carried because a caller turning this into an owner-facing verdict needs
   * it and has nowhere else to get it. On a 401/403 the remedy IS the message
   * — "re-authorize" — and a verdict that reached the owner saying his mail
   * had stopped without saying what to do about it would be this module's own
   * failure mode one layer further out.
   */
  readonly fix: string;
}

export interface GmailHistoryDelta {
  /**
   * The new high-water mark.
   *
   * Persist this as the next call's `startHistoryId` **only when `unreadable`
   * is empty** — see the field below, which exists to make that condition
   * something a caller has to look at rather than something it can forget.
   */
  readonly historyId: string;
  /** Full bodies of messages added since `startHistoryId`, deduped, in `messagesAdded` order. */
  readonly messages: readonly GmailMessageBody[];
  /**
   * Messages this delta named and could not fetch. Load-bearing, not diagnostic.
   *
   * The same contract `ImapEnvelopeBatch.unreadable` carries, for the same
   * reason and with the same consequence: while this is non-empty, an id
   * missing from `messages` is NOT evidence the message is gone, and
   * `historyId` is NOT a position that has been reached. Gmail's history is a
   * forward-only log — records at or below a `startHistoryId` are never
   * returned again — so a caller that advanced past an unread message would
   * not merely delay it, it would make it permanently unreachable.
   *
   * There is no partial advance available here. Unlike a UID, a `historyId` is
   * one position for the WHOLE delta, so there is no "just below the one that
   * failed" to move to. The whole delta is therefore unresolved: the caller
   * keeps its old position and asks again, and dedup absorbs the re-delivery
   * of whatever did come back this time.
   */
  readonly unreadable: readonly GmailFetchProblem[];
}

export type HistoryUnavailableReason = 'no-gmail-scope' | 'metadata-scope-only' | 'resync-required';

/**
 * A failure with an explicit reason a caller can switch on, distinguishing
 * "the capability is off" (`no-gmail-scope`), "readable but bodies are not"
 * (`metadata-scope-only`), and "the cursor aged out" (`resync-required`) from
 * an ordinary transient `GoogleApiFailure`. A caller can never mistake any of
 * these three for a full delta, because a full delta is the sole `ok: true`
 * shape and none of these three carry one.
 */
export interface HistoryDeltaUnavailable extends GoogleApiFailure {
  readonly unavailable: HistoryUnavailableReason;
}

export type HistoryListDeltaResult =
  | { readonly ok: true; readonly value: GmailHistoryDelta }
  | HistoryDeltaUnavailable
  | GoogleApiFailure;

/** Narrow I/O this module needs from `GoogleApiClient` and `GoogleTokenManager`. */
export interface HistoryDeltaDeps {
  /** The token's actual granted scopes. Never inferred from config or from what was requested. */
  readonly scopes: () => readonly string[];
  /** One page of the raw `users.history.list` response, authenticated. */
  readonly fetchHistoryPage: (params: URLSearchParams) => Promise<GoogleApiResult<unknown>>;
  /** Fetch one full message by id — reuses `GoogleApiClient.getMessage`, including its provenance and delivery-evidence handling. */
  readonly getMessage: (id: string) => Promise<GoogleApiResult<GmailMessageBody>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function hasAnyScope(granted: readonly string[], wanted: readonly string[]): boolean {
  const set = new Set(granted);
  return wanted.some((scope) => set.has(scope));
}

function buildHistoryPageParams(options: HistoryDeltaOptions, pageToken: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  params.set('startHistoryId', options.startHistoryId);
  params.set('maxResults', String(Math.max(1, Math.min(500, options.maxResultsPerPage ?? 100))));
  if (options.labelId !== undefined) params.set('labelId', options.labelId);
  for (const type of options.historyTypes ?? ['messageAdded']) params.append('historyTypes', type);
  if (pageToken !== undefined) params.set('pageToken', pageToken);
  return params;
}

/** Collect every added-message id across every page of one `historyTypes` sweep, plus the new high-water mark. */
async function collectAddedMessageIds(
  deps: HistoryDeltaDeps,
  options: HistoryDeltaOptions,
): Promise<{ readonly ok: true; readonly historyId: string; readonly ids: readonly string[] } | HistoryDeltaUnavailable | GoogleApiFailure> {
  const seen = new Set<string>();
  const ids: string[] = [];
  let latestHistoryId = options.startHistoryId;
  let pageToken: string | undefined;

  do {
    const page = await deps.fetchHistoryPage(buildHistoryPageParams(options, pageToken));
    if (!page.ok) {
      if (page.status === 404) {
        return {
          ok: false,
          unavailable: 'resync-required',
          status: 404,
          problem:
            `Google reported startHistoryId ${options.startHistoryId} is outside the available history range. ` +
            'History records are typically retained for about a week and sometimes less, and a 404 here means the whole window has aged out rather than that some records are missing.',
          fix: 'Perform a full mailbox sync (listMessages), then re-establish the cursor from the historyId of a current message before resuming historyListDelta.',
        };
      }
      return page;
    }

    const value = isRecord(page.value) ? page.value : {};
    if (typeof value.historyId === 'string' && value.historyId.length > 0) {
      latestHistoryId = value.historyId;
    }

    const records = Array.isArray(value.history) ? value.history : [];
    for (const record of records) {
      if (!isRecord(record)) continue;
      const added = Array.isArray(record.messagesAdded) ? record.messagesAdded : [];
      for (const entry of added) {
        if (!isRecord(entry)) continue;
        const message = isRecord(entry.message) ? entry.message : {};
        const id = readString(message.id);
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }

    pageToken = typeof value.nextPageToken === 'string' && value.nextPageToken.length > 0 ? value.nextPageToken : undefined;
  } while (pageToken !== undefined);

  return { ok: true, historyId: latestHistoryId, ids };
}

/**
 * Fetch what is new since `options.startHistoryId`, gated on the token's
 * actual granted scopes.
 *
 * Never returns an empty success in place of "not allowed to look", and never
 * in place of "we could not read what was there" — see the module header.
 *
 * Callers persist the returned `historyId` as the next call's
 * `startHistoryId` only when `ok` is `true` AND `value.unreadable` is empty.
 * Both conditions, not just the first: an `ok` delta whose `unreadable` is
 * non-empty is a delta that has not been fully read, and its `historyId` names
 * a position nothing has reached.
 */
export async function collectHistoryDelta(
  deps: HistoryDeltaDeps,
  options: HistoryDeltaOptions,
): Promise<HistoryListDeltaResult> {
  const granted = deps.scopes();

  if (!hasAnyScope(granted, GMAIL_HISTORY_SCOPES)) {
    return {
      ok: false,
      unavailable: 'no-gmail-scope',
      status: null,
      problem:
        'The granted Google credential carries no Gmail read scope (readonly, modify, metadata, or full mail), so users.history.list cannot be called.',
      fix: 'This mailbox is served over IMAP IDLE instead, which needs no Gmail OAuth scope. Granting a Gmail scope is a restricted-scope decision that requires explicit, separate authorization.',
    };
  }

  if (!hasAnyScope(granted, GMAIL_BODY_SCOPES)) {
    // Only `gmail.metadata` is present. It authorizes the history.list call
    // itself, but its own scope description excludes the message body, and a
    // body-less delta cannot match a verification expectation or serve any
    // other purpose this module exists for. Refuse before making the call at
    // all, rather than making it and returning a delta with empty bodies.
    return {
      ok: false,
      unavailable: 'metadata-scope-only',
      status: null,
      problem:
        'The granted Google credential carries only the gmail.metadata scope, which authorizes users.history.list but explicitly excludes the message body ("but not the email body" — Google\'s own scope description). This module cannot produce a usable delta without bodies.',
      fix: 'Grant a body-capable Gmail scope (gmail.readonly, gmail.modify, or https://mail.google.com/) to enable history-based delta sync, or rely on the IMAP IDLE watcher instead.',
    };
  }

  const collected = await collectAddedMessageIds(deps, options);
  if (!collected.ok) return collected;

  const messages: GmailMessageBody[] = [];
  const unreadable: GmailFetchProblem[] = [];
  for (const id of collected.ids) {
    const fetched = await deps.getMessage(id);
    if (fetched.ok) {
      messages.push(fetched.value);
      continue;
    }
    if (fetched.status === GMAIL_MESSAGE_GONE_STATUS) {
      // The one failure that really does mean "there is nothing here to
      // report on": the message was deleted in the gap between history.list
      // naming it and getMessage being asked for it. Dropped from the delta,
      // and the delta may advance past it.
      continue;
    }
    // Everything else — a rate limit, a server fault, a refused credential, a
    // socket that never answered — is a message we FAILED TO READ, which is a
    // different fact from a message that is gone. It holds the delta.
    unreadable.push({ id, status: fetched.status, detail: fetched.problem, fix: fetched.fix });
  }

  return { ok: true, value: { historyId: collected.historyId, messages, unreadable } };
}
