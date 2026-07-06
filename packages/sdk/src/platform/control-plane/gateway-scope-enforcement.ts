/**
 * gateway-scope-enforcement.ts
 *
 * Per-client delivery enforcement for the control-plane event fan-out. Two
 * orthogonal, AND-ed filters live here:
 *   1. Scope: some wire channels declare a read scope (e.g. `session-update` ⇒
 *      `read:sessions`); a scoped-down token cannot receive a channel it was not
 *      granted.
 *   2. Domain: a broadcast event (published via `ControlPlaneGateway.publishEvent`,
 *      i.e. NOT flowing through a runtime-bus `onDomain` subscription) carries a
 *      `RuntimeEventDomain` tag; a client that opted into a narrower set of
 *      domains only receives events whose domain is in that set.
 */

import type { RuntimeEventDomain } from '../runtime/events/index.js';

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

/**
 * Maps a manually-broadcast wire event (published via
 * `ControlPlaneGateway.publishEvent`) to the `RuntimeEventDomain` a client must
 * have subscribed to in order to receive it. These events do NOT flow through a
 * runtime-bus `onDomain` subscription — that path is already domain-scoped by the
 * subscription itself — so without this map the fan-out ignored the subscriber's
 * declared domains and over-delivered (e.g. `session-update` reached the webui,
 * which declares no `session` domain and dropped it as inert).
 *
 * An event ABSENT from this map carries no domain tag and is delivered to every
 * scope-permitted client regardless of its subscribed domains (deliver-all). That
 * keeps domain scoping strictly opt-in narrowing: a newly-added broadcast event
 * cannot be silently dropped just because it is not yet tagged here. New verbs
 * (later waves) should register their broadcast events in this map.
 */
export const EVENT_DOMAIN: Readonly<Record<string, RuntimeEventDomain>> = {
  'session-update': 'session',
  'approval-update': 'permissions',
  // W3-S3: sessions.detach's `session-detached` is TODAY a payload discriminant
  // inside the `session-update` channel (session-broker.ts publishUpdate wraps
  // it), so it is already domain-scoped by the entry above. This tag is
  // defense-in-depth: if the discriminant is ever promoted to a top-level
  // broadcast, it stays in the session domain instead of silently deliver-all.
  'session-detached': 'session',
  // W5-S1: sessions.delete's `session-deleted` is likewise a payload discriminant
  // inside `session-update` today (already domain-scoped by the entry above); this
  // tag is the same defense-in-depth as `session-detached` if it is ever promoted
  // to a top-level broadcast.
  'session-deleted': 'session',
};

/**
 * Whether a live client that subscribed to `clientDomains` should receive
 * `event` under the domain filter.
 *
 * `clientDomains === null` means the client did NOT opt into domain narrowing
 * (it connected with no `?domains=` param) and receives everything it is
 * scope-permitted to see — today's behavior, preserved. This null=deliver-all
 * default is the only migration-safe choice: an empty-set-means-nothing default
 * would silently black out every consumer that did not opt in.
 *
 * An event with no `EVENT_DOMAIN` tag is always delivered (untagged ⇒ inert to
 * the domain filter), so narrowing can only ever remove events we can positively
 * attribute to a domain the client did not subscribe to.
 */
export function clientMayReceiveEventDomain(
  clientDomains: ReadonlySet<RuntimeEventDomain> | null,
  event: string,
): boolean {
  if (clientDomains === null) return true;
  const domain = EVENT_DOMAIN[event];
  if (domain === undefined) return true;
  return clientDomains.has(domain);
}
