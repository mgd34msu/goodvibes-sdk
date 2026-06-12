/**
 * Shared OAuth type definitions.
 *
 * Isolated from oauth-core.ts so that these types can be re-exported from
 * runtime-neutral entry points (auth.ts, react-native.ts, browser.ts, etc.)
 * without pulling in node:crypto.
 */

/**
 * Ephemeral state produced at the start of an OAuth PKCE flow.
 * Pass this object to `completeOAuthFlow()` once the authorisation server
 * redirects back to `redirectUri` with a `code` parameter.
 */
export interface OAuthStartState {
  /** The authorisation server URL to redirect the user to. */
  readonly authorizationUrl: string;
  /** The `state` nonce sent to the authorisation server; verify it matches on callback. */
  readonly state: string;
  /** The PKCE code verifier; kept secret until the token exchange step. */
  readonly verifier: string;
  /** The redirect URI registered with the authorisation server. */
  readonly redirectUri: string;
}

/**
 * Normalised token payload returned after a successful OAuth token exchange.
 * Stored in the configured `GoodVibesTokenStore` and used by `AutoRefreshCoordinator`.
 */
export interface OAuthTokenPayload {
  /** The bearer access token. */
  readonly accessToken: string;
  /** The refresh token, if issued by the provider. */
  readonly refreshToken?: string | undefined;
  /** The token type (typically `'Bearer'`). */
  readonly tokenType: string;
  /** Unix-epoch millisecond timestamp when `accessToken` expires, if known. */
  readonly expiresAt?: number | undefined;
  /** Scopes granted by the token, if returned by the provider. */
  readonly scopes?: readonly string[] | undefined;
}
