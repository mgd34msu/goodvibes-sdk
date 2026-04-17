/**
 * Shared OAuth type definitions.
 *
 * Isolated from oauth-core.ts so that these types can be re-exported from
 * runtime-neutral entry points (auth.ts, react-native.ts, browser.ts, etc.)
 * without pulling in node:crypto.
 */

export interface OAuthStartState {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface OAuthTokenPayload {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
}
