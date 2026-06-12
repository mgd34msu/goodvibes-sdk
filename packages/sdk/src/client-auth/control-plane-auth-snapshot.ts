/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Authentication mode reported by the daemon control plane.
 *
 * - `'anonymous'` — no credentials were supplied.
 * - `'invalid'` — credentials were supplied but are not recognised.
 * - `'session'` — authenticated via a session cookie.
 * - `'shared-token'` — authenticated via a shared bearer token.
 */
export type ControlPlaneAuthMode = 'anonymous' | 'invalid' | 'session' | 'shared-token';

/**
 * Point-in-time snapshot of the daemon control-plane auth state for the
 * current request principal. Returned by `sdk.auth.current()` and used
 * internally by `PermissionResolver`.
 */
export interface ControlPlaneAuthSnapshot {
  /** `true` when the principal is authenticated (mode is `'session'` or `'shared-token'`). */
  readonly authenticated: boolean;
  /** The authentication mode active for this request. */
  readonly authMode: ControlPlaneAuthMode;
  /** `true` when any token value was present on the request (regardless of validity). */
  readonly tokenPresent: boolean;
  /** `true` when an `Authorization` header was present on the request. */
  readonly authorizationHeaderPresent: boolean;
  /** `true` when the session cookie was present on the request. */
  readonly sessionCookiePresent: boolean;
  /** The principal identifier (user id, bot id, etc.), or `null` for anonymous/invalid. */
  readonly principalId: string | null;
  /** The category of the authenticated principal, or `null` when not authenticated. */
  readonly principalKind: 'user' | 'bot' | 'service' | 'token' | null;
  /** `true` when the principal holds daemon admin privileges. */
  readonly admin: boolean;
  /** OAuth / permission scopes granted to the principal. */
  readonly scopes: readonly string[];
  /** Role identifiers assigned to the principal. */
  readonly roles: readonly string[];
}
