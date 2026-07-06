/**
 * @pellux/goodvibes-sdk/platform/calendar
 *
 * External-calendar READ connectivity — the SDK machinery behind the agent's
 * `/calendar import`, `/calendar subscribe`, and the connect wizard (see
 * CHANGELOG 1.0.0, A9). Two pieces, both honest by construction:
 *
 *  - A vendored iCalendar (RFC 5545) reader: `parseIcs` turns .ics text (a file body
 *    or a fetched feed) into typed events, and `expandEvent` expands the honest RRULE
 *    subset into concrete occurrences. A recurrence outside the subset is NEVER
 *    fabricated — the event keeps its seed and carries an explicit
 *    `recurrence.expansion: 'unsupported'` marker naming the part we declined.
 *  - `SubscriptionStore`: named external-calendar feed subscriptions with per-feed
 *    honest status (ok / stale-with-age / unreachable / parse-error), etag/
 *    last-modified conditional refresh, and a paste-URL-and-done `add()` that
 *    validates by fetching and auto-derives the name from X-WR-CALNAME.
 *
 * Network and clock are INJECTED (FeedFetcher / Clock) — this module never reaches
 * the network or reads wall-clock on its own, so consumers (and tests, with fake
 * feeds) own the IO boundary entirely. Persistence is the caller's job.
 *
 * The daemon `calendar.*` operator methods stay `invokable: false` — they are
 * CalDAV-backed contracts with no live route, a separate concern from this
 * read-focused file/feed machinery. See
 * docs/decisions/2026-07-05-calendar-connectivity-sdk-extraction.md.
 */

export { parseIcs } from './ics-parser.js';
export { describeRecurrence, expandEvent } from './rrule.js';
export {
  SubscriptionStore,
  maskFeedUrl,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  type SubscriptionStoreOptions,
  type AddSubscriptionInput,
  type AddResult,
  type ValidationResult,
} from './subscription-store.js';

export type {
  CalendarEvent,
  EventDateTime,
  EventZone,
  RecurrenceInfo,
  RecurrenceExpansion,
  ParsedCalendar,
  ParseDiagnostic,
  EventOccurrence,
  DateWindow,
  CalendarSubscription,
  SubscriptionHealth,
  SubscriptionSnapshot,
  RefreshReport,
  FeedFetcher,
  FeedFetchRequest,
  FeedFetchResult,
  Clock,
} from './types.js';

// ---------------------------------------------------------------------------
// Authenticated provider connectivity — Google Calendar API v3 + Microsoft Graph
// over OAuth 2.0 (see CHANGELOG 1.0.0, A10). This half connects to real accounts;
// A9's half above reads .ics files and feeds. Both normalize into ONE merged event
// model (see MergedCalendarEvent) that a unified /calendar view renders source-
// labeled (google-api / microsoft-graph / ics-feed / local).
//
// The network is an injected HttpFetch, the loopback redirect an injected
// LoopbackWaiter, token persistence an injected secret-store slice — so the full
// OAuth + API flow runs against fake servers with no real network, port, or keychain.
// See docs/decisions/2026-07-06-calendar-oauth-connector-sdk.md.

export {
  GOOGLE_PROFILE,
  MICROSOFT_PROFILE,
  GOOGLE_PLACEHOLDER_CLIENT_ID,
  MICROSOFT_PLACEHOLDER_CLIENT_ID,
  GOOGLE_SCOPES_DEFAULT,
  MICROSOFT_SCOPES_DEFAULT,
  PROVIDER_SETUP_STEPS,
  providerProfile,
  resolveClientConfig,
} from './oauth-providers.js';

export {
  OAuthFlowError,
  createPkcePair,
  parseTokenResponse,
  beginAuthCodeFlow,
  completeAuthCodeFlow,
  beginDeviceCodeFlow,
  pollDeviceCodeFlow,
  refreshAccessToken,
  revokeToken,
  type PkcePair,
  type Sleep,
} from './oauth-flow.js';

export {
  CalendarTokenStore,
  TokenRefreshError,
  type CalendarTokenStoreOptions,
} from './oauth-token-store.js';

export {
  normalizeGoogleEvent,
  normalizeGraphEvent,
  normalizeOffsetDateTime,
  eventDateTimeEpochMs,
  compareEventDateTime,
  compareMergedCalendarEventsByStart,
} from './merged-calendar-model.js';

export {
  CalendarApiError,
  authedRequest,
  errorFromResponse,
} from './calendar-api-shared.js';

export {
  listGoogleCalendars,
  listGoogleEvents,
  createGoogleEvent,
  type GoogleEventsQuery,
} from './google-calendar-api.js';

export {
  listGraphCalendars,
  listGraphEvents,
  createGraphEvent,
  type GraphEventsQuery,
} from './microsoft-graph-api.js';

export {
  CalendarConnector,
  type CalendarConnectorOptions,
  type EventWindow,
} from './calendar-connector.js';

export { fetchAdapter } from './http-fetch-adapter.js';

export type {
  CalendarProviderId,
  CalendarSource,
  OAuthProviderProfile,
  OAuthClientOverrides,
  ResolvedClientConfig,
  HttpFetch,
  HttpRequest,
  HttpResponse,
  LoopbackWaiter,
  LoopbackListenerFactory,
  SecretStoreSlice,
  StoredTokenSet,
  ConnectionState,
  FlowFailureReason,
  AuthCodeFlowStart,
  DeviceCodeFlowStart,
  ApiDegradedState,
  MergedCalendarEvent,
  ProviderCalendar,
  NewCalendarEvent,
  ConnectedAccount,
} from './oauth-types.js';
