/**
 * oauth-providers.ts — the fixed provider profiles for Google Calendar and
 * Microsoft Outlook (Graph), plus client-config resolution.
 *
 * Bring your own OAuth app. No first-party client id ships with the product: the
 * person setting up a GoodVibes environment registers the provider app themselves
 * and sets its client id in config. A profile therefore carries the ENDPOINTS and
 * the NAMES OF THE CONFIG KEYS the credentials are read from, and no credential of
 * its own.
 *
 * This replaces an earlier design that carried a "bundled project client id"
 * shipping as a literal placeholder string, on the plan that real ids would be
 * dropped into config defaults later. They will not be. A baked default is exactly
 * what an operator cannot audit or rotate, and a placeholder that reaches a provider
 * produces a failure that reads like a broken build rather than an unfinished setup.
 * `resolveClientConfig` reports `isConfigured: false` when no id is set, and flows
 * refuse with `client-not-configured` naming the key to set.
 *
 * A desktop / public-client registration needs no client secret when paired with
 * PKCE (RFC 8252/7636), which is the recommended registration for both providers;
 * an operator who registers a confidential client supplies a secret as well.
 */

import type {
  CalendarProviderId,
  OAuthClientOverrides,
  OAuthProviderProfile,
  ResolvedClientConfig,
} from './oauth-types.js';

/** Google Calendar read scope and read/write events scope. Read-write is the default
 *  so event creation works; a user may narrow to read-only via overrides. */
export const GOOGLE_SCOPES_DEFAULT = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

/** Microsoft Graph read/write calendar scope (+ offline_access for a refresh token). */
export const MICROSOFT_SCOPES_DEFAULT = [
  'offline_access',
  'Calendars.ReadWrite',
] as const;

export const GOOGLE_PROFILE: OAuthProviderProfile = {
  provider: 'google',
  displayName: 'Google Calendar',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  deviceAuthorizationEndpoint: 'https://oauth2.googleapis.com/device/code',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  apiBaseUrl: 'https://www.googleapis.com/calendar/v3',
  defaultScopes: GOOGLE_SCOPES_DEFAULT,
  clientIdConfigKey: 'calendar.google.clientId',
  clientSecretRefConfigKey: 'calendar.google.clientSecretRef',
  // access_type=offline + prompt=consent so Google returns a refresh token on the
  // first authorization and re-issues one on re-consent.
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
};

export const MICROSOFT_PROFILE: OAuthProviderProfile = {
  provider: 'microsoft',
  displayName: 'Microsoft Outlook',
  // 'common' lets both personal and work/school accounts authenticate.
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  deviceAuthorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
  // Microsoft has no OAuth revocation endpoint; disconnect is local token deletion.
  apiBaseUrl: 'https://graph.microsoft.com/v1.0',
  defaultScopes: MICROSOFT_SCOPES_DEFAULT,
  clientIdConfigKey: 'calendar.microsoft.clientId',
  clientSecretRefConfigKey: 'calendar.microsoft.clientSecretRef',
};

const PROFILES: Readonly<Record<CalendarProviderId, OAuthProviderProfile>> = {
  google: GOOGLE_PROFILE,
  microsoft: MICROSOFT_PROFILE,
};

/** Look up a provider profile. */
export function providerProfile(provider: CalendarProviderId): OAuthProviderProfile {
  return PROFILES[provider];
}

/**
 * Merge a profile with the operator's supplied credentials into the config a flow
 * runs with.
 *
 * Resolving is total: it never throws and never invents an id. With no client id
 * supplied the result carries the empty string and `isConfigured: false`, so a
 * caller can ASK about the state — render "not connected, set this key" — without
 * having to catch an exception. Refusing is the flow's job, not the resolver's
 * (see `assertClientConfigured` in oauth-flow.ts).
 */
export function resolveClientConfig(
  profile: OAuthProviderProfile,
  overrides?: OAuthClientOverrides,
): ResolvedClientConfig {
  const clientId = typeof overrides?.clientId === 'string' ? overrides.clientId.trim() : '';
  const isConfigured = clientId.length > 0;
  const scopes = overrides?.scopes && overrides.scopes.length > 0 ? overrides.scopes : profile.defaultScopes;
  return {
    provider: profile.provider,
    clientId,
    ...(overrides?.clientSecret && overrides.clientSecret.length > 0
      ? { clientSecret: overrides.clientSecret }
      : {}),
    scopes,
    authorizationEndpoint: profile.authorizationEndpoint,
    tokenEndpoint: profile.tokenEndpoint,
    deviceAuthorizationEndpoint: profile.deviceAuthorizationEndpoint,
    ...(profile.revocationEndpoint ? { revocationEndpoint: profile.revocationEndpoint } : {}),
    apiBaseUrl: profile.apiBaseUrl,
    ...(profile.extraAuthParams ? { extraAuthParams: profile.extraAuthParams } : {}),
    ...(overrides?.redirectHost ? { redirectHost: overrides.redirectHost } : {}),
    ...(typeof overrides?.redirectPort === 'number' ? { redirectPort: overrides.redirectPort } : {}),
    isConfigured,
    clientIdConfigKey: profile.clientIdConfigKey,
    clientSecretRefConfigKey: profile.clientSecretRefConfigKey,
  };
}

/**
 * The exact provider-console steps whoever is setting up this GoodVibes
 * environment follows to register their own OAuth app.
 *
 * These are not "advanced" steps any more — they are THE setup, because no client
 * id ships with the product. Surfaced verbatim by the connect flow's refusal help
 * and copied into docs/calendar-oauth-setup.md. Kept as data so the surfaces and
 * the docs never drift.
 */
export const PROVIDER_SETUP_STEPS: Readonly<Record<CalendarProviderId, readonly string[]>> = {
  google: [
    'Open the Google Cloud Console (console.cloud.google.com) and select or create a project.',
    'APIs & Services -> Library -> enable "Google Calendar API".',
    'APIs & Services -> OAuth consent screen -> configure (External is fine for personal use); add your Google account under Test users while the app is unverified.',
    'APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> Application type "Desktop app".',
    'Copy the generated Client ID. A Desktop-app client needs NO client secret with PKCE; leave the secret field blank unless you deliberately use a Web-app client.',
    'Set it: `goodvibes config set calendar.google.clientId <CLIENT_ID>`. If you registered a Web-app (confidential) client instead, store its secret and put the reference in calendar.google.clientSecretRef.',
  ],
  microsoft: [
    'Open the Azure portal (portal.azure.com) -> Microsoft Entra ID -> App registrations -> New registration.',
    'Name the app; under "Supported account types" pick "Accounts in any organizational directory and personal Microsoft accounts" for the broadest reach.',
    'Under "Redirect URI" add a "Mobile and desktop applications" platform and the entry http://localhost (the loopback flow supplies its own 127.0.0.1 port).',
    'Registration -> Authentication -> enable "Allow public client flows" = Yes (this is the public-client / device-code property; no client secret is needed).',
    'Registration -> API permissions -> Add a permission -> Microsoft Graph -> Delegated -> add Calendars.ReadWrite and offline_access.',
    'Copy the "Application (client) ID" and set it: `goodvibes config set calendar.microsoft.clientId <CLIENT_ID>`. A confidential registration additionally needs its secret stored and referenced in calendar.microsoft.clientSecretRef.',
  ],
};
