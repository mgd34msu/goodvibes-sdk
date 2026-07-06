/**
 * oauth-providers.ts — the fixed provider profiles for Google Calendar and
 * Microsoft Outlook (Graph), plus client-config resolution.
 *
 * Design (see CHANGELOG 1.0.0, A10, per Mike's least-friction rule): the DEFAULT
 * experience uses a bundled project-level client id (rclone/gh pattern). A native-
 * app / public-client id is not a secret (RFC 8252), so paired with PKCE no client
 * secret is needed. Power users MAY override with their own client id (+ secret for
 * a confidential registration) — surfaced only under an "advanced" affordance, never
 * as a required step.
 *
 * The bundledClientId ships as an honest PLACEHOLDER. Mike registers the two project
 * apps once and drops the real ids into config defaults; after that every user's flow
 * is just: connect -> browser opens -> approve -> done. Until then, resolveClientConfig
 * reports isPlaceholder:true and flows refuse with `client-not-configured` rather than
 * faking a success.
 */

import type {
  CalendarProviderId,
  OAuthClientOverrides,
  OAuthProviderProfile,
  ResolvedClientConfig,
} from './oauth-types.js';

/** Honest placeholders — replaced once the project apps are registered. */
export const GOOGLE_PLACEHOLDER_CLIENT_ID =
  'REPLACE_WITH_PROJECT_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
export const MICROSOFT_PLACEHOLDER_CLIENT_ID =
  'REPLACE_WITH_PROJECT_MICROSOFT_CLIENT_ID';

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
  bundledClientId: GOOGLE_PLACEHOLDER_CLIENT_ID,
  placeholderClientId: GOOGLE_PLACEHOLDER_CLIENT_ID,
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
  bundledClientId: MICROSOFT_PLACEHOLDER_CLIENT_ID,
  placeholderClientId: MICROSOFT_PLACEHOLDER_CLIENT_ID,
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
 * Merge a profile with a user's optional overrides into the config a flow runs with.
 * A bundled profile whose id is still the placeholder resolves isPlaceholder:true
 * UNLESS the user supplied their own clientId.
 */
export function resolveClientConfig(
  profile: OAuthProviderProfile,
  overrides?: OAuthClientOverrides,
): ResolvedClientConfig {
  const overrodeClientId = typeof overrides?.clientId === 'string' && overrides.clientId.trim().length > 0;
  const clientId = overrodeClientId ? overrides!.clientId!.trim() : profile.bundledClientId;
  const usingBundledDefault = !overrodeClientId;
  const isPlaceholder = usingBundledDefault && clientId === profile.placeholderClientId;
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
    usingBundledDefault,
    isPlaceholder,
  };
}

/**
 * The exact provider-console steps a user (or Mike, registering the project apps)
 * follows. Surfaced verbatim by the wizard's "advanced" help and copied into the
 * module docs. Kept as data so the wizard and docs never drift.
 */
export const PROVIDER_SETUP_STEPS: Readonly<Record<CalendarProviderId, readonly string[]>> = {
  google: [
    'Open the Google Cloud Console (console.cloud.google.com) and select or create a project.',
    'APIs & Services -> Library -> enable "Google Calendar API".',
    'APIs & Services -> OAuth consent screen -> configure (External is fine for personal use); add your Google account under Test users while the app is unverified.',
    'APIs & Services -> Credentials -> Create Credentials -> OAuth client ID -> Application type "Desktop app".',
    'Copy the generated Client ID. A Desktop-app client needs NO client secret with PKCE; leave the secret field blank unless you deliberately use a Web-app client.',
    'Paste the Client ID into the wizard under "advanced", or (project owner) drop it into the config default calendar.google.clientId.',
  ],
  microsoft: [
    'Open the Azure portal (portal.azure.com) -> Microsoft Entra ID -> App registrations -> New registration.',
    'Name the app; under "Supported account types" pick "Accounts in any organizational directory and personal Microsoft accounts" for the broadest reach.',
    'Under "Redirect URI" add a "Mobile and desktop applications" platform and the entry http://localhost (the loopback flow supplies its own 127.0.0.1 port).',
    'Registration -> Authentication -> enable "Allow public client flows" = Yes (this is the public-client / device-code property; no client secret is needed).',
    'Registration -> API permissions -> Add a permission -> Microsoft Graph -> Delegated -> add Calendars.ReadWrite and offline_access.',
    'Copy the "Application (client) ID". Paste it into the wizard under "advanced", or (project owner) drop it into the config default calendar.microsoft.clientId.',
  ],
};
