/**
 * OAuthClient — OAuth flows for **daemon authentication**.
 *
 * Wraps the pure PKCE/OAuth 2.0 functions in `oauth-core.ts` behind a class
 * boundary so callers can inject config once and call methods, rather than
 * threading `OAuthProviderConfig` through every call.
 *
 * This client handles authentication between the SDK and the goodvibes daemon.
 * For OAuth flows that subscribe to external AI providers (OpenAI, Anthropic,
 * etc.), see {@link SubscriptionManager} in
 * `../config/subscriptions.ts`.
 *
 * @see SubscriptionManager — OAuth flows for provider subscriptions.
 */

import type { OAuthProviderConfig } from '../../config/subscriptions.js';
import {
  buildOAuthAuthorizationStart,
  decodeJwtPayload,
  exchangeOAuthAuthorizationCode,
  refreshOAuthAccessToken,
} from './oauth-core.js';
export type { OAuthStartState, OAuthTokenPayload } from '../../../client-auth/oauth-types.js';
import type { OAuthStartState, OAuthTokenPayload } from '../../../client-auth/oauth-types.js';

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
