/**
 * Gmail and Google Calendar over their REST APIs.
 *
 * Endpoints and parameter names here were read from Google's live API
 * reference on 2026-07-26 rather than recalled:
 *   - GET  https://gmail.googleapis.com/gmail/v1/users/{userId}/messages
 *          (q, maxResults, pageToken, labelIds, includeSpamTrash)
 *   - POST https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send
 *   - GET  https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
 *          (timeMin, timeMax, singleEvents, orderBy, maxResults)
 *
 * Two properties this module is responsible for:
 *
 *   1. **No token ever escapes.** Access tokens go into an Authorization
 *      header and nowhere else. Every error is built from status and Google's
 *      own error message, with the token scrubbed.
 *
 *   2. **Mail content is marked untrusted at the boundary.** Message bodies
 *      are attacker-controlled: anyone who knows the address can put text in
 *      front of the agent. Results carry an explicit provenance marker so the
 *      caller cannot accidentally treat a body as instructions. The
 *      surface-authority layer enforces what may then be done with it.
 */

import type { GoogleTokenManager } from './token-manager.js';
import {
  collectHistoryDelta,
  type HistoryDeltaDeps,
  type HistoryDeltaOptions,
  type HistoryListDeltaResult,
} from './history-delta.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * The headers `readMessageMetadata` asks for, and the only ones it asks for.
 *
 * `metadataHeaders[]` is documented verbatim as "When given and format is
 * `METADATA`, only include headers specified", so naming them narrows what
 * crosses this boundary to exactly the fields the notice and the delivery
 * evidence are built from. Omitting the parameter would return every header on
 * the message — `Received` chains, `Authentication-Results`, `List-Unsubscribe`,
 * anything a sender chose to add — none of which anything downstream reads, all
 * of which would then be in memory and in whatever a caller logged.
 *
 * `Delivered-To` and `X-Original-To` are the two `deliveryHeaderValues` reads,
 * and they are the receiver-written ones — the correlation evidence. `From`,
 * `To`, `Subject` and `Date` are what the owner's notice shows. Nothing else is
 * requested, so nothing else can arrive.
 */
const METADATA_HEADERS: readonly string[] = [
  'From', 'To', 'Subject', 'Date', 'Delivered-To', 'X-Original-To',
];

/** Injected HTTP, so every call is testable without network. */
export interface GoogleApiFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A failure the caller can act on, with no secret material in it. */
export interface GoogleApiFailure {
  readonly ok: false;
  readonly status: number | null;
  readonly problem: string;
  readonly fix: string;
}

export type GoogleApiResult<T> = { readonly ok: true; readonly value: T } | GoogleApiFailure;

/**
 * Provenance marker carried by every piece of mail-derived content.
 * `'untrusted-external'` means: evidence about the world, never instructions.
 */
export const MAIL_CONTENT_PROVENANCE = 'untrusted-external' as const;

export interface GmailMessageSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
  readonly snippet: string;
  readonly unread: boolean;
  /** Always `'untrusted-external'`. Present so it cannot be forgotten downstream. */
  readonly provenance: typeof MAIL_CONTENT_PROVENANCE;
}

/**
 * A message read under `format=METADATA`: headers and delivery evidence, and
 * **no body of any kind**.
 *
 * Endpoint and parameters read from Google's live reference on 2026-07-28, not
 * recalled:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *
 *   - `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}`
 *     with query parameters `format` (enum) and `metadataHeaders[]` (string),
 *     whose description is verbatim: "When given and format is `METADATA`,
 *     only include headers specified."
 *   - Authorization scopes for the method, verbatim and in full:
 *     `https://mail.google.com/`, `.../auth/gmail.modify`,
 *     `.../auth/gmail.readonly`, `.../auth/gmail.metadata`. A `gmail.metadata`
 *     token is therefore authorized to make this call — which is the entire
 *     reason this type exists.
 *   - `Message.historyId` is declared **string**, and `internalDate` is a
 *     string in int64 format. Neither is ever parsed to a `Number` here: a
 *     decimal uint64 above 2^53 truncates, and a truncated history position is
 *     a cursor that looks valid and names the wrong record.
 *
 * Why this is a SEPARATE type from `GmailMessageBody` rather than one with an
 * empty `body`
 * ─────────────────────────────────────────────────────────────────────────
 * `GmailMessageBody` extends this and adds `body`, so the assignability runs
 * one way only: a body-bearing message satisfies a metadata-shaped parameter,
 * and a metadata-only message does NOT satisfy a body-bearing one. Anything
 * that needs a body — matching a verification link, redacting a body excerpt —
 * takes `GmailMessageBody` and cannot be handed one of these by accident.
 *
 * `snippet` is deliberately EMPTY on this path, and that is not cosmetic. A
 * snippet is derived from the message body: Gmail should not return one to a
 * `gmail.metadata` token at all, but "should not" is the provider's promise
 * rather than this daemon's guarantee, and a body excerpt arriving through the
 * one path built to carry no body is exactly the shape nobody would look for.
 * `readMessageMetadata` blanks it unconditionally, so the property holds
 * whatever Google sends.
 */
export interface GmailMessageMetadata extends GmailMessageSummary {
  /**
   * Every `Delivered-To` / `X-Original-To` header on the message, in order.
   *
   * These are written by the receiving infrastructure, not the sender, which is
   * what makes them usable as proof of which address a message actually
   * arrived at. `To:` is sender-controlled and is deliberately kept separate.
   */
  readonly deliveredTo: readonly string[];
}

export interface GmailMessageBody extends GmailMessageMetadata {
  readonly body: string;
}

/**
 * The mailbox itself, as `users.getProfile` describes it.
 *
 * Endpoint read from Google's live reference on 2026-07-28, not recalled:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 *
 *   - `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/profile`, where
 *     `userId` takes "The user's email address. The special value `me` can be
 *     used to indicate the authenticated user." — verbatim.
 *   - Response body: `emailAddress` (string), `messagesTotal` (integer),
 *     `threadsTotal` (integer), and `historyId` (string), whose description
 *     reads **"The ID of the mailbox's current history record"** — verbatim.
 *   - Authorization scopes, verbatim and in full: `https://mail.google.com/`,
 *     `.../auth/gmail.modify`, `.../auth/gmail.compose`,
 *     `.../auth/gmail.readonly`, `.../auth/gmail.metadata`. Every scope that
 *     authorizes `users.history.list` therefore also authorizes this call, so a
 *     credential that can read a delta can always establish a position.
 *
 * `messagesTotal` and `threadsTotal` are carried because they are what the
 * response contains, and dropping them would make this a partial mapping that
 * the next caller has to widen. Nothing here is a secret: the address is the
 * one the owner connected, and the counts are two integers.
 */
export interface GmailProfile {
  readonly emailAddress: string;
  readonly messagesTotal: number;
  readonly threadsTotal: number;
  /** Decimal uint64 as a STRING. Never parsed to a number — it does not fit one. */
  readonly historyId: string;
}

export interface CalendarEventRecord {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location: string;
  readonly description: string;
  readonly htmlLink: string;
}

export interface SendMailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly from?: string;
}

export interface CreateEventInput {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
  readonly calendarId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reject anything that could inject an extra header line. Subjects and
 * addresses are the two attacker-reachable fields in a send, and a bare CR or
 * LF in either is enough to forge headers.
 */
function validateHeaderValue(value: string, field: string): string | null {
  if (/[\r\n]/.test(value)) {
    return `The ${field} contains a line break, which is not allowed because it could forge additional mail headers.`;
  }
  if (value.trim().length === 0) {
    return `The ${field} is empty.`;
  }
  return null;
}

function validateAddress(value: string, field: string): string | null {
  const structural = validateHeaderValue(value, field);
  if (structural !== null) return structural;
  // Deliberately permissive on the local part, strict on structure.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    return `The ${field} "${value.trim()}" is not a valid email address.`;
  }
  return null;
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive intact. */
function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function headerValue(headers: readonly unknown[], name: string): string {
  const target = name.toLowerCase();
  for (const entry of headers) {
    if (!isRecord(entry)) continue;
    if (readString(entry.name).toLowerCase() === target) return readString(entry.value);
  }
  return '';
}

/**
 * Collect the receiver-written delivery headers.
 *
 * Order is preserved because the first `Delivered-To` is the outermost
 * envelope recipient, which is the one that identifies the alias the message
 * was addressed to before any forwarding.
 */
function deliveryHeaderValues(headers: readonly unknown[]): readonly string[] {
  const wanted = new Set(['delivered-to', 'x-original-to']);
  const found: string[] = [];
  for (const entry of headers) {
    if (!isRecord(entry)) continue;
    if (!wanted.has(readString(entry.name).toLowerCase())) continue;
    const value = readString(entry.value).trim();
    if (value.length > 0) found.push(value);
  }
  return found;
}

/** Walk a Gmail payload tree for the first text/plain part. */
function extractPlainTextBody(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const mimeType = readString(payload.mimeType);
  const bodyRecord = isRecord(payload.body) ? payload.body : null;
  const data = bodyRecord === null ? '' : readString(bodyRecord.data);

  if (mimeType === 'text/plain' && data.length > 0) return decodeBase64Url(data);

  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const found = extractPlainTextBody(part);
    if (found.length > 0) return found;
  }

  // Fall back to whatever body data exists so an HTML-only mail is not blank.
  return data.length > 0 ? decodeBase64Url(data) : '';
}

export class GoogleApiClient {
  constructor(
    private readonly tokens: GoogleTokenManager,
    private readonly fetchPort: GoogleApiFetchPort,
  ) {}

  /**
   * Authorized request. Refreshes once on a 401 — a token can expire between
   * the expiry check and the call landing, and one silent retry is the
   * difference between a working tool and a flaky one.
   */
  private async request(
    url: string,
    init: RequestInit = {},
    retryOnUnauthorized = true,
  ): Promise<GoogleApiResult<unknown>> {
    const tokenOutcome = await this.tokens.accessToken();
    if (!tokenOutcome.ok) {
      return { ok: false, status: null, problem: tokenOutcome.problem, fix: tokenOutcome.fix };
    }

    let response: Response;
    try {
      response = await this.fetchPort.fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${tokenOutcome.token.accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      return {
        ok: false,
        status: null,
        problem: `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'Check network connectivity and try again.',
      };
    }

    if (response.status === 401 && retryOnUnauthorized) {
      const refreshed = await this.tokens.forceRefresh();
      if (refreshed.ok) return this.request(url, init, false);
      return { ok: false, status: 401, problem: refreshed.problem, fix: refreshed.fix };
    }

    const raw = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      return { ok: false, status: response.status, ...this.describeHttpFailure(response.status, parsed) };
    }

    return { ok: true, value: parsed };
  }

  private describeHttpFailure(status: number, parsed: unknown): { problem: string; fix: string } {
    const errorRecord = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
    const message = errorRecord === null ? '' : readString(errorRecord.message);

    if (status === 403 && /insufficient|scope/i.test(message)) {
      return {
        problem: `Google refused the request because the credential lacks the required permission: ${message}`,
        fix: 'Re-authorize with the needed scope: /google setup --path oauth',
      };
    }
    if (status === 403 && /disabled|not been used/i.test(message)) {
      return {
        problem: `The required Google API is not enabled for this project: ${message}`,
        fix: 'Enable it, then retry: /google setup --path oauth',
      };
    }
    if (status === 429) {
      return {
        problem: 'Google is rate-limiting this account.',
        fix: 'Wait a minute and try again.',
      };
    }
    return {
      problem: message.length > 0 ? `Google returned ${status}: ${message}` : `Google returned HTTP ${status}.`,
      fix: 'If this persists, re-authorize: /google setup',
    };
  }

  // -------------------------------------------------------------------------
  // Gmail
  // -------------------------------------------------------------------------

  /** List message summaries. `query` uses Gmail search syntax (e.g. "is:unread"). */
  async listMessages(options: { query?: string; maxResults?: number } = {}): Promise<GoogleApiResult<readonly GmailMessageSummary[]>> {
    const params = new URLSearchParams();
    if (options.query !== undefined && options.query.trim().length > 0) params.set('q', options.query.trim());
    params.set('maxResults', String(Math.max(1, Math.min(100, options.maxResults ?? 20))));

    const listed = await this.request(`${GMAIL_BASE}/messages?${params.toString()}`);
    if (!listed.ok) return listed;

    const ids = isRecord(listed.value) && Array.isArray(listed.value.messages) ? listed.value.messages : [];
    const summaries: GmailMessageSummary[] = [];
    for (const entry of ids) {
      if (!isRecord(entry)) continue;
      const id = readString(entry.id);
      if (id.length === 0) continue;
      const detail = await this.fetchMessage(id, 'metadata');
      if (detail.ok) summaries.push(detail.value);
    }
    return { ok: true, value: summaries };
  }

  /** Read one message including its plain-text body. */
  async getMessage(id: string): Promise<GoogleApiResult<GmailMessageBody>> {
    return this.fetchMessage(id, 'full');
  }

  /**
   * Read one message's HEADERS AND DELIVERY EVIDENCE, with no body.
   *
   * `GET .../messages/{id}?format=metadata&metadataHeaders=...`, the request a
   * `gmail.metadata` token is authorized to make (see `GmailMessageMetadata`
   * for the live-docs citation). This is the call that gives
   * `surfaces.email.inbound.onInsufficientCapability: 'notice-only'` something
   * to actually do: a grant that excludes bodies can still say who sent what,
   * to which address, and when it landed.
   *
   * Deliberately NOT a `format` parameter on `getMessage`. The two calls return
   * different guarantees and the return TYPE is what carries the difference —
   * a caller that needs a body gets a compile error rather than a `body` field
   * that is empty for a reason it cannot see. That is also why this does not
   * reuse `fetchMessage`: that method's `metadata` overload feeds
   * `listMessages`, whose summaries keep Gmail's `snippet`, and this path must
   * blank it.
   */
  async readMessageMetadata(id: string): Promise<GoogleApiResult<GmailMessageMetadata>> {
    const params = new URLSearchParams();
    params.set('format', 'metadata');
    for (const header of METADATA_HEADERS) params.append('metadataHeaders', header);
    const result = await this.request(
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params.toString()}`,
    );
    if (!result.ok) return result;
    const record = isRecord(result.value) ? result.value : {};
    const payload = isRecord(record.payload) ? record.payload : {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const labelIds = Array.isArray(record.labelIds) ? record.labelIds : [];

    return {
      ok: true,
      value: {
        id: readString(record.id, id),
        threadId: readString(record.threadId),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        subject: headerValue(headers, 'Subject'),
        date: headerValue(headers, 'Date'),
        // Blanked unconditionally rather than carried. A snippet is body-derived
        // text; Google should not send one to a metadata-only grant, but this
        // path's whole promise is "no body reached us", and a promise that
        // depends on the provider keeping its own is not a promise this daemon
        // can make. Dropping it costs nothing — no consumer of this method reads
        // a snippet — and it makes the property hold whatever arrives.
        snippet: '',
        unread: labelIds.some((label) => label === 'UNREAD'),
        provenance: MAIL_CONTENT_PROVENANCE,
        deliveredTo: deliveryHeaderValues(headers),
      },
    };
  }

  private async fetchMessage(id: string, format: 'metadata'): Promise<GoogleApiResult<GmailMessageSummary>>;
  private async fetchMessage(id: string, format: 'full'): Promise<GoogleApiResult<GmailMessageBody>>;
  private async fetchMessage(id: string, format: 'metadata' | 'full'): Promise<GoogleApiResult<GmailMessageBody>> {
    const result = await this.request(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=${format}`);
    if (!result.ok) return result;
    const record = isRecord(result.value) ? result.value : {};
    const payload = isRecord(record.payload) ? record.payload : {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const labelIds = Array.isArray(record.labelIds) ? record.labelIds : [];

    return {
      ok: true,
      value: {
        id: readString(record.id, id),
        threadId: readString(record.threadId),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        subject: headerValue(headers, 'Subject'),
        date: headerValue(headers, 'Date'),
        snippet: readString(record.snippet),
        unread: labelIds.some((label) => label === 'UNREAD'),
        provenance: MAIL_CONTENT_PROVENANCE,
        body: format === 'full' ? extractPlainTextBody(payload) : '',
        deliveredTo: deliveryHeaderValues(headers),
      },
    };
  }

  /**
   * Incremental sync via `users.history.list` — what changed since
   * `options.startHistoryId`, without re-listing the mailbox.
   *
   * Gated on the token's actual granted scopes, checked at call time via
   * `this.tokens.scopes()` rather than assumed from what setup requested.
   * With no Gmail read scope present this returns
   * `unavailable: 'no-gmail-scope'`, never an empty success. A `startHistoryId`
   * that has aged out of Gmail's retention window returns
   * `unavailable: 'resync-required'` instead of an empty delta. See
   * `history-delta.ts` for the full design rationale and the live-docs
   * citations it is built against.
   */
  async historyListDelta(options: HistoryDeltaOptions): Promise<HistoryListDeltaResult> {
    return collectHistoryDelta(this.historyDeltaPort(), options);
  }

  /**
   * The narrow I/O slice `collectHistoryDelta` takes, over this client.
   *
   * Exposed because a long-lived caller — `GmailMailSource` — drives the delta
   * itself rather than through `historyListDelta`: it has to inspect
   * `unreadable` before it may move its cursor, and it re-enters on its own
   * poll interval. Handing it THIS object rather than letting it build a second
   * one is the point. `request` is private, so a hand-built port would need its
   * own fetch, its own Authorization header and its own 401-retry, and the
   * scope gate would then read a different token manager's answer than the one
   * actually making the calls.
   */
  historyDeltaPort(): HistoryDeltaDeps {
    return {
      scopes: () => this.tokens.scopes(),
      fetchHistoryPage: (params) => this.request(`${GMAIL_BASE}/history?${params.toString()}`),
      getMessage: (id) => this.getMessage(id),
      readMessageMetadata: (id) => this.readMessageMetadata(id),
    };
  }

  /** The mailbox's address, size and current history position. See `GmailProfile`. */
  async getProfile(): Promise<GoogleApiResult<GmailProfile>> {
    const result = await this.request(`${GMAIL_BASE}/profile`);
    if (!result.ok) return result;
    const record = isRecord(result.value) ? result.value : {};
    return {
      ok: true,
      value: {
        emailAddress: readString(record.emailAddress),
        messagesTotal: typeof record.messagesTotal === 'number' ? record.messagesTotal : 0,
        threadsTotal: typeof record.threadsTotal === 'number' ? record.threadsTotal : 0,
        // Read as a string and never coerced: a decimal uint64 loses precision
        // as a JS number, and a history position that is off by one is a
        // message that is never fetched again.
        historyId: readString(record.historyId),
      },
    };
  }

  /**
   * The mailbox's current `historyId`, for a caller establishing a position.
   *
   * This is the call `GmailMailSource.currentHistoryId` needed and had nowhere
   * to get: its own comment recorded that "`GoogleApiClient` exposes neither a
   * profile call nor a `historyId` today", which is what left the Gmail source
   * unbuildable in any composition.
   *
   * Google's sync guide names `messages.get` / `messages.list` as where a
   * client reads a message's `historyId` for a full sync
   * (https://developers.google.com/workspace/gmail/api/guides/sync, verified
   * live 2026-07-28: "To retrieve the historyId of a recent message, use the
   * messages.get or messages.list methods"). `users.getProfile` is used here
   * instead, deliberately: it answers "the ID of the mailbox's current history
   * record" in one request that lists nothing, which is exactly what
   * establishing-without-backfilling means. Reading it off the newest message
   * would name a position BELOW that message, and re-announcing mail that was
   * already in the mailbox is precisely what the establish path refuses to do.
   */
  async currentHistoryId(): Promise<GoogleApiResult<string>> {
    const profile = await this.getProfile();
    return profile.ok ? { ok: true, value: profile.value.historyId } : profile;
  }

  /** Send a plain-text message. */
  async sendMessage(input: SendMailInput): Promise<GoogleApiResult<{ readonly id: string; readonly threadId: string }>> {
    const toError = validateAddress(input.to, 'recipient address');
    if (toError !== null) return { ok: false, status: null, problem: toError, fix: 'Correct the recipient address and try again.' };
    const subjectError = validateHeaderValue(input.subject, 'subject');
    if (subjectError !== null) return { ok: false, status: null, problem: subjectError, fix: 'Correct the subject and try again.' };
    if (input.from !== undefined) {
      const fromError = validateAddress(input.from, 'sender address');
      if (fromError !== null) return { ok: false, status: null, problem: fromError, fix: 'Correct the sender address and try again.' };
    }

    const headerLines = [
      `To: ${input.to.trim()}`,
      ...(input.from === undefined ? [] : [`From: ${input.from.trim()}`]),
      `Subject: ${encodeSubject(input.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
    ];
    const raw = base64Url(`${headerLines.join('\r\n')}\r\n\r\n${input.body}`);

    const result = await this.request(`${GMAIL_BASE}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!result.ok) return result;
    const record = isRecord(result.value) ? result.value : {};
    return { ok: true, value: { id: readString(record.id), threadId: readString(record.threadId) } };
  }

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------

  async listEvents(
    options: { calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number } = {},
  ): Promise<GoogleApiResult<readonly CalendarEventRecord[]>> {
    const calendarId = options.calendarId ?? 'primary';
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.max(1, Math.min(250, options.maxResults ?? 25))),
    });
    if (options.timeMin !== undefined) params.set('timeMin', options.timeMin);
    if (options.timeMax !== undefined) params.set('timeMax', options.timeMax);

    const result = await this.request(
      `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    );
    if (!result.ok) return result;
    const items = isRecord(result.value) && Array.isArray(result.value.items) ? result.value.items : [];
    return { ok: true, value: items.map(toCalendarEvent).filter((event): event is CalendarEventRecord => event !== null) };
  }

  async getEvent(id: string, calendarId = 'primary'): Promise<GoogleApiResult<CalendarEventRecord>> {
    const result = await this.request(
      `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
    );
    if (!result.ok) return result;
    const event = toCalendarEvent(result.value);
    return event === null
      ? { ok: false, status: null, problem: `Google returned no usable event for id ${id}.`, fix: 'Check the event id.' }
      : { ok: true, value: event };
  }

  async createEvent(input: CreateEventInput): Promise<GoogleApiResult<CalendarEventRecord>> {
    if (input.summary.trim().length === 0) {
      return { ok: false, status: null, problem: 'The event needs a title.', fix: 'Provide a summary for the event.' };
    }
    const calendarId = input.calendarId ?? 'primary';
    const allDay = !input.start.includes('T');
    const body = {
      summary: input.summary,
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.description === undefined ? {} : { description: input.description }),
      start: allDay ? { date: input.start } : { dateTime: input.start },
      end: allDay ? { date: input.end } : { dateTime: input.end },
    };

    const result = await this.request(`${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!result.ok) return result;
    const event = toCalendarEvent(result.value);
    return event === null
      ? { ok: false, status: null, problem: 'Google accepted the event but returned no usable record.', fix: 'Check the calendar directly.' }
      : { ok: true, value: event };
  }
}

function toCalendarEvent(value: unknown): CalendarEventRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (id.length === 0) return null;
  const start = isRecord(value.start) ? value.start : {};
  const end = isRecord(value.end) ? value.end : {};
  const startDate = readString(start.date);
  const startDateTime = readString(start.dateTime);
  return {
    id,
    summary: readString(value.summary, '(no title)'),
    start: startDateTime.length > 0 ? startDateTime : startDate,
    end: readString(end.dateTime) || readString(end.date),
    allDay: startDate.length > 0 && startDateTime.length === 0,
    location: readString(value.location),
    description: readString(value.description),
    htmlLink: readString(value.htmlLink),
  };
}
