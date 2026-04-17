/**
 * @pellux/goodvibes-sdk/oauth
 *
 * Node.js-only subpath export for OAuth 2.0 / PKCE flows.
 *
 * This entrypoint imports oauth-core.ts which depends on node:crypto.
 * It is intentionally excluded from the RN/browser bundle graph.
 * React Native and browser consumers should perform OAuth flows on a
 * server-side proxy and exchange tokens via the standard auth flow instead.
 *
 * @example
 * import { OAuthClient } from '@pellux/goodvibes-sdk/oauth';
 *
 * const client = new OAuthClient({
 *   clientId: process.env.OAUTH_CLIENT_ID!,
 *   authUrl: 'https://auth.example.com/authorize',
 *   tokenUrl: 'https://auth.example.com/token',
 *   redirectUri: 'http://localhost:4000/callback',
 *   scopes: ['openid', 'profile'],
 * });
 *
 * const { authorizationUrl, state, verifier } = client.beginAuthorization();
 */

export { OAuthClient } from './_internal/platform/auth/oauth-client.js';
export type { OAuthStartState, OAuthTokenPayload } from './_internal/platform/auth/oauth-types.js';
