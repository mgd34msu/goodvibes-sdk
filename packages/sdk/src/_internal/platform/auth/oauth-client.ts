/**
 * OAuthClient — Focused responsibility: OAuth 2.0 / PKCE flows.
 *
 * Wraps the pure functions in `oauth-core.ts` behind a class boundary so
 * callers can inject config once and call methods, rather than threading
 * `OAuthProviderConfig` through every call.
 */

import type { OAuthProviderConfig } from '../config/subscriptions.js';
import {
  buildOAuthAuthorizationStart,
  decodeJwtPayload,
  exchangeOAuthAuthorizationCode,
  refreshOAuthAccessToken,
} from '../runtime/auth/oauth-core.js';
export type { OAuthStartState, OAuthTokenPayload } from './oauth-types.js';
import type { OAuthStartState, OAuthTokenPayload } from './oauth-types.js';

export class OAuthClient {
  readonly #config: OAuthProviderConfig;

  constructor(config: OAuthProviderConfig) {
    this.#config = config;
  }

  /**
   * Build the authorization URL and PKCE state needed to start an OAuth flow.
   * Redirect the user's browser to `result.authorizationUrl`.
   */
  async beginAuthorization(input?: {
    readonly state?: string;
    readonly verifier?: string;
    readonly redirectUri?: string;
  }): Promise<OAuthStartState> {
    return buildOAuthAuthorizationStart(this.#config, input);
  }

  /**
   * Exchange an authorization code (returned via the redirect) for tokens.
   * Use the `state` and `verifier` from the matching `beginAuthorization` call.
   */
  async exchangeCode(input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly state?: string;
  }): Promise<OAuthTokenPayload> {
    return exchangeOAuthAuthorizationCode(this.#config, input);
  }

  /**
   * Use a refresh token to obtain a new access token without user interaction.
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokenPayload> {
    return refreshOAuthAccessToken(this.#config, refreshToken);
  }

  /**
   * Decode a JWT access token's payload without verification.
   * Returns null when the token is malformed.
   */
  decodeJwtPayload(token: string): Record<string, unknown> | null {
    return decodeJwtPayload(token);
  }

  /** Expose the provider config this client was built from. */
  get config(): OAuthProviderConfig {
    return this.#config;
  }
}
