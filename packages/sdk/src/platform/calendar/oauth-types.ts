/**
 * oauth-types.ts, the shared type surface for the calendar OAuth + API connector
 * layer (see CHANGELOG 1.0.0, A10). Sits alongside A9's .ics reader/subscription
 * store in the same module: A9 owns file/feed reading; this half owns authenticated
 * provider connectivity (Google Calendar API v3, Microsoft Graph) over OAuth 2.0.
 *
 * Pure data shapes only, no fs, no network, no process globals. The network is an
 * INJECTED boundary (HttpFetch); the loopback redirect capture is an INJECTED
 * boundary (LoopbackWaiter); token persistence is an INJECTED secret store slice.
 * Tests supply fakes for all three, so nothing here ever reaches a real network,
 * a real port, or a real keychain.
 *
 * Honesty contract (see docs/decisions/2026-07-06-calendar-oauth-connector-sdk.md):
 *  - a token whose refresh fails is NEVER silently treated as valid; it surfaces as
 *    `connection-state: 'reconnect-needed'` naming the reason.
 *  - a 403 that names a missing scope surfaces as `insufficient-scope` naming the
 *    exact scope, not a generic failure.
 *  - there is no bundled project client id. The operator registers their own OAuth
 *    app with the provider and sets its client id in config; until they do, a flow
 *    refuses with `client-not-configured` and names the config key to set. No
 *    default is baked in, so the refusal cannot be mistaken for a broken build.
 */

import type { CalendarEvent, EventDateTime } from './types.js';

// A9's calendar module already defines the injected Clock (() => number); reuse it
// so the merged module has one clock type and the index barrel has no name clash.
export type { Clock } from './types.js';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Which authenticated calendar provider a connection speaks to. */
export type CalendarProviderId = 'google' | 'microsoft';

/** The label recorded on every event so a merged view can say where it came from. */
export type CalendarSource = 'google-api' | 'microsoft-graph' | 'ics-feed' | 'local';

/**
 * A provider profile: the fixed OAuth + API endpoints and defaults for one provider.
 * Everything an operator does NOT supply (endpoints, default scopes, the names of
 * the config keys their credentials live under) lives here; what the operator MUST
 * supply, the client id of the OAuth app they registered, and a client secret if
 * they registered a confidential one, arrives as OAuthClientOverrides and is merged
 * in at resolve time.
 */
export interface OAuthProviderProfile {
  readonly provider: CalendarProviderId;
  /** Human label, e.g. 'Google Calendar' / 'Microsoft Outlook'. */
  readonly displayName: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Device-authorization endpoint; both providers support the device-code grant. */
  readonly deviceAuthorizationEndpoint: string;
  /** Token-revocation endpoint, when the provider offers one (Google does; MS does not). */
  readonly revocationEndpoint?: string;
  /** The API base the calendar client talks to after auth. */
  readonly apiBaseUrl: string;
  /** Default scopes when the user does not override them. */
  readonly defaultScopes: readonly string[];
  /**
   * The config key the operator's own client id is read from, e.g.
   * `calendar.google.clientId`.
   *
   * No client id ships with the product. Native-app client ids are not secrets
   * (RFC 8252) and could technically be bundled, but whoever sets up a GoodVibes
   * environment registers their own provider app, so this names WHERE their id
   * goes rather than carrying one. It is data on the profile, not a string built
   * at the call site, so the refusal message, the setup steps and the docs all
   * quote the same key and cannot drift apart.
   */
  readonly clientIdConfigKey: string;
  /**
   * The config key holding a reference to the operator's client secret, e.g.
   * `calendar.google.clientSecretRef`. The secret itself lives in the secret
   * store; config holds only the reference. Only a confidential-client
   * registration needs one, a desktop/public client with PKCE does not.
   */
  readonly clientSecretRefConfigKey: string;
  /** Extra fixed authorization-request params (e.g. Google's access_type=offline). */
  readonly extraAuthParams?: Readonly<Record<string, string>>;
}

/**
 * The operator's own OAuth app credentials, plus the optional knobs around them.
 *
 * `clientId` is REQUIRED for any flow to run, nothing is bundled to fall back on.
 * It is optional at the type level because this shape is also what a caller passes
 * when it only wants to override scopes or the redirect port, and because the
 * not-configured state has to be representable: `resolveClientConfig` returns a
 * config with `isConfigured: false` and the flow refuses by name rather than the
 * type system making the state unconstructable and the failure a crash.
 */
export interface OAuthClientOverrides {
  /**
   * The client id of the OAuth app the operator registered with the provider,
   * normally read from the profile's `clientIdConfigKey`.
   */
  readonly clientId?: string;
  /**
   * The operator's client secret, for a confidential-client registration. Absent
   * for a desktop/public-client registration (PKCE, no secret). Secret-stored,
   * never echoed.
   */
  readonly clientSecret?: string;
  /** Scope override; when absent the profile's defaultScopes are used. */
  readonly scopes?: readonly string[];
  /** Loopback redirect host/port override for the auth-code flow. */
  readonly redirectHost?: string;
  readonly redirectPort?: number;
}

/** The fully-resolved client config a flow actually runs with. */
export interface ResolvedClientConfig {
  readonly provider: CalendarProviderId;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopes: readonly string[];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly apiBaseUrl: string;
  readonly extraAuthParams?: Readonly<Record<string, string>>;
  readonly redirectHost?: string;
  readonly redirectPort?: number;
  /**
   * True when a real client id was supplied. False means nobody has registered a
   * provider app for this environment yet and `clientId` is the empty string, a
   * flow must refuse with `client-not-configured` in that state rather than
   * attempting a round-trip that can only fail.
   */
  readonly isConfigured: boolean;
  /**
   * The config key the client id is expected in, carried through from the profile
   * so a refusal can name the exact key to set without re-deriving it.
   */
  readonly clientIdConfigKey: string;
  /** The config key a client-secret reference is expected in. */
  readonly clientSecretRefConfigKey: string;
}

// ---------------------------------------------------------------------------
// Injected boundaries (the ONLY ways this layer touches the outside world)
// ---------------------------------------------------------------------------

/** A minimal HTTP response shape the connector reads. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Response header lookup, case-insensitive by the fetch impl's contract. */
  header(name: string): string | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** A single outbound HTTP request the connector issues. */
export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Injected network boundary. Tests supply a fake server behind this. */
export type HttpFetch = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * Injected loopback-redirect capture for the authorization-code flow. The real
 * implementation binds 127.0.0.1 and waits for the browser callback; tests supply a
 * fake that returns a canned code/state without any port.
 */
export interface LoopbackWaiter {
  /** The redirect_uri the listener is bound to (http://127.0.0.1:<port>/<path>). */
  readonly redirectUri: string;
  /** Resolves with the authorization code once the browser hits the redirect. */
  waitForCode(): Promise<{ readonly code: string; readonly state: string }>;
  close(): void;
}

/** Factory for a LoopbackWaiter bound to an expected state. Injected. */
export type LoopbackListenerFactory = (input: {
  readonly expectedState: string;
  readonly host?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
}) => Promise<LoopbackWaiter>;

/**
 * The narrow secret-store slice the token store needs. Matches the SDK
 * SecretsManager surface (`Pick<SecretsManager, 'get' | 'set' | 'delete'>`), so a
 * caller passes the real manager and tests pass a Map-backed fake.
 */
export interface SecretStoreSlice {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A stored token set for one connected account. Persisted via the secret store. */
export interface StoredTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  /**
   * Epoch ms the access token expires. `parseTokenResponse` (oauth-flow.ts) always
   * sets this, coercing a numeric-string `expires_in`, or falling back to a
   * conservative default when the provider omits it or sends something unparsable,
   * so a token set produced by this build's flows never reads as "never expires".
   * Still optional at the type level for token sets constructed directly (e.g. tests,
   * or a caller building one by hand) rather than through `parseTokenResponse`.
   */
  readonly expiresAt?: number;
  /** The scopes actually granted (from the token response), when stated. */
  readonly scopes?: readonly string[];
  /** Epoch ms this set was last written. */
  readonly obtainedAt: number;
}

/** The honest live state of a connection, computed from its stored token set. */
export type ConnectionState =
  /** Access token present and not past expiry (minus leeway). */
  | 'connected'
  /** Access token expired but a refresh token is present, a refresh will be tried. */
  | 'refresh-due'
  /** Refresh was attempted and failed; the user must reconnect. */
  | 'reconnect-needed'
  /** No token stored for this account. */
  | 'disconnected';

// ---------------------------------------------------------------------------
// Flow states
// ---------------------------------------------------------------------------

/** Why a flow could not even start or complete, named honestly. */
export type FlowFailureReason =
  /** No client id is configured: nobody has registered a provider OAuth app for
   *  this environment and set its id in config. */
  | 'client-not-configured'
  /** The provider rejected the token request (bad code, expired device code, etc.). */
  | 'token-request-rejected'
  /** The loopback redirect timed out waiting for the browser. */
  | 'redirect-timeout'
  /** The device-code authorization was declined or expired before approval. */
  | 'device-code-expired'
  /** A network-layer failure reaching the provider. */
  | 'network-error';

/** The outcome of beginning an authorization-code flow. */
export interface AuthCodeFlowStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

/** A device-code flow's user-facing step: show these, then poll. */
export interface DeviceCodeFlowStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Present when the provider returns a pre-filled verification URL. */
  readonly verificationUriComplete?: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

/** A degraded API state, each variant naming exactly what went wrong. */
export type ApiDegradedState =
  | { readonly kind: 'reconnect-needed'; readonly detail: string }
  | { readonly kind: 'insufficient-scope'; readonly missingScope: string; readonly detail: string }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number; readonly detail: string }
  | { readonly kind: 'network-error'; readonly detail: string }
  | { readonly kind: 'provider-error'; readonly status: number; readonly detail: string };

// ---------------------------------------------------------------------------
// Merged calendar model
// ---------------------------------------------------------------------------

/**
 * The one merged event model every source normalizes into. It is A9's CalendarEvent
 * plus provenance: a source label and the provider ids needed to write back or
 * de-duplicate. ICS/local events set source and omit the api-only ids.
 */
export interface MergedCalendarEvent extends CalendarEvent {
  readonly source: CalendarSource;
  /** The provider's own event id (Google eventId / Graph id), when from an API. */
  readonly sourceEventId?: string;
  /** The provider calendar this event belongs to, when from an API. */
  readonly calendarId?: string;
  /** A display label for the owning calendar/account, for source-labeled views. */
  readonly calendarLabel?: string;
  /**
   * True only when the PROVIDER states the owner organized this event,
   * Google's `organizer.self`, Microsoft Graph's `isOrganizer`. Both are
   * read-only and both mean "the organizer corresponds to the calendar this
   * copy appears on".
   *
   * Absent means the provider said nothing, which is read as somebody else's.
   * This is what decides whether the event's text is recorded as untrusted
   * content when a turn reads it (see untrusted-events.ts): an event the owner
   * created himself is not externally sourced; everything else is.
   */
  readonly organizerIsOwner?: boolean;
}

/** One connected calendar as listed from a provider (calendarList / me/calendars). */
export interface ProviderCalendar {
  readonly id: string;
  readonly name: string;
  readonly provider: CalendarProviderId;
  /** True for the account's primary calendar, when the provider marks one. */
  readonly primary?: boolean;
  /** True when the connected scopes allow creating events on this calendar. */
  readonly canWrite: boolean;
}

/** A new event to create through a provider, in the shared shape. */
export interface NewCalendarEvent {
  readonly summary: string;
  readonly start: EventDateTime;
  readonly end?: EventDateTime;
  readonly location?: string;
  readonly description?: string;
}

/** A connected account record (metadata; tokens live in the secret store). */
export interface ConnectedAccount {
  readonly provider: CalendarProviderId;
  /** A stable local id for this account (provider + a discriminator). */
  readonly accountId: string;
  /** A human label (the account email/UPN when known, else the provider name). */
  readonly label: string;
  readonly scopes: readonly string[];
  readonly connectedAt: number;
}
