/**
 * calendar-api-shared.ts — the bearer-auth HTTP helper and honest degraded-state
 * mapping shared by the Google Calendar and Microsoft Graph clients. Every failed
 * response is turned into a NAMED ApiDegradedState (never a generic throw): a 401 is
 * `reconnect-needed`, a 403 that names a missing scope is `insufficient-scope` naming
 * that scope, a 429 is `rate-limited` carrying the honored Retry-After, everything
 * else is `provider-error` with the status.
 */

import type { ApiDegradedState, CalendarProviderId, HttpFetch, HttpResponse } from './oauth-types.js';

/** A named, honest API failure. */
export class CalendarApiError extends Error {
  readonly degraded: ApiDegradedState;
  constructor(degraded: ApiDegradedState) {
    super(degraded.detail);
    this.name = 'CalendarApiError';
    this.degraded = degraded;
  }
}

function retryAfterMs(res: HttpResponse): number {
  const header = res.header('retry-after');
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 1000;
}

/**
 * Best-effort extraction of the scope a 403 says is missing. Google returns it in
 * the error message / details; Graph names it in the error message. When we cannot
 * pin the exact scope, we say so honestly rather than invent one.
 */
function missingScopeFrom(bodyText: string, provider: CalendarProviderId): string {
  const scopeMatch = /scope[s]?['"\s:=]+([A-Za-z0-9_.:/-]+)/i.exec(bodyText);
  if (scopeMatch) return scopeMatch[1]!;
  const graphPerm = /(Calendars\.[A-Za-z]+)/.exec(bodyText);
  if (graphPerm) return graphPerm[1]!;
  return provider === 'google'
    ? 'a Google Calendar scope not granted to this connection'
    : 'a Microsoft Graph Calendars permission not granted to this connection';
}

/** Map a non-OK response to a CalendarApiError with a named degraded state. */
export async function errorFromResponse(res: HttpResponse, provider: CalendarProviderId): Promise<CalendarApiError> {
  const bodyText = await res.text().catch(() => '');
  if (res.status === 401) {
    return new CalendarApiError({
      kind: 'reconnect-needed',
      detail: `${provider} rejected the access token (401). Reconnect the account.`,
    });
  }
  if (res.status === 403) {
    return new CalendarApiError({
      kind: 'insufficient-scope',
      missingScope: missingScopeFrom(bodyText, provider),
      detail: `${provider} refused the request for lack of a granted scope (403).`,
    });
  }
  if (res.status === 429) {
    return new CalendarApiError({
      kind: 'rate-limited',
      retryAfterMs: retryAfterMs(res),
      detail: `${provider} rate-limited the request (429).`,
    });
  }
  return new CalendarApiError({
    kind: 'provider-error',
    status: res.status,
    detail: `${provider} returned ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}.`,
  });
}

/** Issue a bearer-authorized request, throwing a CalendarApiError on failure. */
export async function authedRequest(
  fetchImpl: HttpFetch,
  provider: CalendarProviderId,
  input: {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly token: string;
    readonly body?: unknown;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/json',
    ...input.extraHeaders,
  };
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: HttpResponse;
  try {
    res = await fetchImpl({
      url: input.url,
      method: input.method,
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new CalendarApiError({
      kind: 'network-error',
      detail: `Reaching ${provider} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!res.ok) throw await errorFromResponse(res, provider);
  return res.json();
}
