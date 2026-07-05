/**
 * gateway-scope-enforcement.ts
 *
 * Per-client scope enforcement for the control-plane event fan-out. Some wire
 * channels declare a read scope (e.g. `session-update` ⇒ `read:sessions`); this
 * module decides whether a given live client may receive such a channel.
 */

/**
 * Wire events whose descriptor declares a read scope. Enforced per-client on the
 * web SSE/WS fan-out so a scoped-down token cannot receive a channel it was not
 * granted. In-process/local/service clients and admin tokens bypass (the
 * single-admin-token model collapses scopes — see method-catalog-events.ts).
 */
export const CHANNEL_REQUIRED_SCOPE: Readonly<Record<string, string>> = {
  'session-update': 'read:sessions',
};

/** The subset of a live client this decision needs. */
export interface ScopedClientView {
  readonly kind: string;
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
}

/**
 * Whether a live client may receive a scope-gated channel. Only web SSE/WS
 * clients (which carry a principal's scopes) are filtered; in-process/local and
 * service ('daemon') clients are trusted and always pass, and an admin token
 * bypasses (single-admin-token model — scopes collapse). A `*` scope is a
 * wildcard grant. A principal-scoped client is filtered only when it carries an
 * explicit scopes array; internal streams with no scopes stay trusted.
 */
export function clientMaySeeScopedChannel(client: ScopedClientView, requiredScope: string): boolean {
  if (client.kind !== 'web') return true;
  if (client.admin) return true;
  if (client.scopes === undefined) return true;
  return client.scopes.includes(requiredScope) || client.scopes.includes('*');
}
