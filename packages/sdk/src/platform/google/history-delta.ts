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
 *     `https://www.googleapis.com/auth/gmail.metadata`.
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
 */

import type { GoogleApiFailure, GoogleApiResult, GmailMessageBody } from './api-client.js';

/**
 * Scopes that authorize `users.history.list`, per Google's live
 * "Authorization scopes" listing for the method (see module header).
 * `gmail.metadata` is the narrowest of the four and still authorizes it.
 */
export const GMAIL_HISTORY_SCOPES: readonly string[] = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
];

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

export interface GmailHistoryDelta {
  /** The new high-water mark. Persist this as the next call's `startHistoryId`. */
  readonly historyId: string;
  /** Full bodies of messages added since `startHistoryId`, deduped, in `messagesAdded` order. */
  readonly messages: readonly GmailMessageBody[];
}

export type HistoryUnavailableReason = 'no-gmail-scope' | 'resync-required';

/**
 * A failure with an explicit reason a caller can switch on, distinguishing
 * "the capability is off" (`no-gmail-scope`) and "the cursor aged out"
 * (`resync-required`) from an ordinary transient `GoogleApiFailure`.
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

function hasHistoryScope(granted: readonly string[]): boolean {
  const set = new Set(granted);
  return GMAIL_HISTORY_SCOPES.some((scope) => set.has(scope));
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
 * Never returns an empty success in place of "not allowed to look" — see the
 * module header. Callers should persist the returned `historyId` as the next
 * call's `startHistoryId` only when `ok` is `true`.
 */
export async function collectHistoryDelta(
  deps: HistoryDeltaDeps,
  options: HistoryDeltaOptions,
): Promise<HistoryListDeltaResult> {
  if (!hasHistoryScope(deps.scopes())) {
    return {
      ok: false,
      unavailable: 'no-gmail-scope',
      status: null,
      problem:
        'The granted Google credential carries no Gmail read scope (readonly, modify, metadata, or full mail), so users.history.list cannot be called.',
      fix: 'This mailbox is served over IMAP IDLE instead, which needs no Gmail OAuth scope. Granting a Gmail scope is a restricted-scope decision that requires explicit, separate authorization.',
    };
  }

  const collected = await collectAddedMessageIds(deps, options);
  if (!collected.ok) return collected;

  const messages: GmailMessageBody[] = [];
  for (const id of collected.ids) {
    const fetched = await deps.getMessage(id);
    // A message that vanished between history.list and getMessage (deleted in
    // the interim) is dropped from this delta rather than failing it — it no
    // longer exists to report on. Everything still present is returned.
    if (fetched.ok) messages.push(fetched.value);
  }

  return { ok: true, value: { historyId: collected.historyId, messages } };
}
