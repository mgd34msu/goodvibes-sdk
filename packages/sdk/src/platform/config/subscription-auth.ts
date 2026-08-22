import { getBuiltinSubscriptionProvider } from './subscription-providers.js';
import type { SubscriptionManager } from './subscriptions.js';
import { refreshOpenAICodexToken } from './openai-codex-auth.js';
import { OAuthTokenExchangeError } from '../runtime/auth/oauth-core.js';
import { logger } from '../utils/logger.js';

/**
 * The stored access token for a provider, or null when no subscription is
 * recorded. Deliberately does NOT refresh a near-expiry OpenAI token any
 * more: the provider's own 401 path owns refresh uniformly (see
 * {@link refreshOpenAISubscriptionAfterRejection}), so an expired token costs
 * one rejected request and then recovers through the same code that handles
 * a mid-lifetime revocation. Two refresh paths was how the expiry path came
 * to throw a raw token-exchange error that the surfaces then captioned as an
 * API-key problem.
 */
export async function resolveSubscriptionAccessToken(
  provider: string,
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>,
): Promise<string | null> {
  if (provider === 'openai') {
    return manager.get('openai')?.accessToken ?? null;
  }
  const builtin = getBuiltinSubscriptionProvider(provider);
  if (!builtin) return null;
  return manager.resolveAccessToken(provider, builtin.oauth);
}

/**
 * What one recovery attempt concluded. `refreshed` carries the token to retry
 * with (possibly minted by a concurrent caller rather than this one).
 * `session-dead` means the authorization server refused the grant: the
 * session is over and only a new sign-in helps. `unavailable` means the
 * refresh could not be judged (transport failure, a 5xx from the token
 * endpoint, a malformed answer): the session's true state is unknown and the
 * caller must NOT tell the user to sign in again.
 */
export type SubscriptionRefreshOutcome =
  | { readonly kind: 'refreshed'; readonly accessToken: string }
  | { readonly kind: 'session-dead' }
  | { readonly kind: 'unavailable'; readonly error: unknown };

/**
 * OpenAI's refresh tokens rotate (the exchange must return a new one, see
 * openai-codex-auth.ts), so a spent refresh token is gone. When a token is
 * revoked, every in-flight call 401s at once, and N concurrent recoveries
 * would each present the same refresh token: one wins, the rest fail and
 * would falsely report a session the winner just healed as dead. One shared
 * in-flight attempt per process closes the in-process race.
 */
let inFlightOpenAIRefresh: Promise<SubscriptionRefreshOutcome> | null = null;

/**
 * One recovery attempt for a stored OpenAI subscription whose access token
 * the backend has rejected. `rejectedAccessToken` is the token the backend
 * refused: when the store already holds a DIFFERENT token, another caller
 * (or another process) refreshed while this one was in flight, and the
 * stored token is returned without spending anything.
 *
 * The exchange is time-bounded (oauth-core) but deliberately not wired to
 * any one turn's abort signal: the attempt is shared by every concurrent
 * caller, and one caller cancelling its turn must not abort the recovery
 * the others are awaiting.
 */
export async function refreshOpenAISubscriptionAfterRejection(
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription'>,
  rejectedAccessToken: string,
): Promise<SubscriptionRefreshOutcome> {
  const existing = manager.get('openai');
  if (!existing) return { kind: 'session-dead' };
  if (existing.accessToken !== rejectedAccessToken) {
    return { kind: 'refreshed', accessToken: existing.accessToken };
  }
  // A session already stamped dead is not retried: hammering the token
  // endpoint with a refresh token the server already refused cannot help,
  // and only a new sign-in replaces the record.
  if (existing.revokedAt !== undefined) return { kind: 'session-dead' };
  if (!existing.refreshToken) return { kind: 'session-dead' };
  return runSharedOpenAIRefresh(manager, existing);
}

/**
 * Interaction-free freshness maintenance, called before a send: a token at
 * or near its expiry is refreshed silently with the rotating refresh token,
 * so the ordinary expiry case never even produces a rejected request, let
 * alone a user-visible error. `unavailable` falls back to the stored token —
 * the send may still work, and the rejection path backstops it if not.
 */
export async function resolveFreshOpenAIAccessToken(
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription'>,
): Promise<SubscriptionRefreshOutcome | { kind: 'unconfigured' }> {
  const existing = manager.get('openai');
  if (!existing) return { kind: 'unconfigured' };
  if (existing.revokedAt !== undefined) return { kind: 'session-dead' };
  const nearExpiry = typeof existing.expiresAt === 'number' && Date.now() + 60_000 >= existing.expiresAt;
  if (!nearExpiry || !existing.refreshToken) {
    return { kind: 'refreshed', accessToken: existing.accessToken };
  }
  const outcome = await runSharedOpenAIRefresh(manager, existing);
  if (outcome.kind === 'unavailable') {
    return { kind: 'refreshed', accessToken: existing.accessToken };
  }
  return outcome;
}

function runSharedOpenAIRefresh(
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription'>,
  existing: NonNullable<ReturnType<SubscriptionManager['get']>>,
): Promise<SubscriptionRefreshOutcome> {
  if (inFlightOpenAIRefresh) return inFlightOpenAIRefresh;
  const attempt = (async (): Promise<SubscriptionRefreshOutcome> => {
    let refreshed;
    try {
      refreshed = await refreshOpenAICodexToken(existing.refreshToken!);
    } catch (error) {
      // Only an answered 4xx is the authorization server refusing the grant.
      // Anything else (transport, 5xx, malformed 200) leaves the session's
      // state unknown.
      if (error instanceof OAuthTokenExchangeError && error.status >= 400 && error.status < 500) {
        try {
          manager.saveSubscription({ ...existing, revokedAt: Date.now(), updatedAt: Date.now() });
        } catch (saveError) {
          logger.warn('[subscription-auth] could not record the revoked OpenAI session', {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }
        return { kind: 'session-dead' };
      }
      return { kind: 'unavailable', error };
    }
    try {
      const { revokedAt: _cleared, ...rest } = existing;
      manager.saveSubscription({
        ...rest,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenType: refreshed.tokenType,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scopes ? { scopes: refreshed.scopes } : existing.scopes ? { scopes: existing.scopes } : {}),
        updatedAt: Date.now(),
      });
    } catch (error) {
      // The refresh already succeeded over the wire and the old refresh token
      // is rotated away server-side; discarding the result over a disk error
      // would cost the user a healthy session. The turn proceeds; the store
      // heals on the next successful save.
      logger.warn('[subscription-auth] refreshed OpenAI subscription could not be persisted; continuing with the in-memory token', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { kind: 'refreshed', accessToken: refreshed.accessToken };
  })();
  inFlightOpenAIRefresh = attempt;
  return attempt.finally(() => {
    inFlightOpenAIRefresh = null;
  });
}
