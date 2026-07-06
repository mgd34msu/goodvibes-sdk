/**
 * oauth-token-store.ts — token persistence + honest lifecycle over the injected
 * secret store. Tokens (access + refresh) live ONLY in the secret store, never in
 * plain config and never echoed. The store computes an honest connection state from
 * the stored set + the clock, auto-refreshes when the access token is due, and — when
 * a refresh fails — records a durable `reconnect-needed` marker so every later read is
 * honest about the account being broken until the user reconnects.
 */

import { OAuthFlowError, refreshAccessToken, revokeToken } from './oauth-flow.js';
import type {
  CalendarProviderId,
  Clock,
  ConnectedAccount,
  ConnectionState,
  HttpFetch,
  ResolvedClientConfig,
  SecretStoreSlice,
  StoredTokenSet,
} from './oauth-types.js';

const DEFAULT_REFRESH_LEEWAY_MS = 60_000;

function tokenKey(provider: CalendarProviderId): string {
  return `GOODVIBES_CALENDAR_${provider.toUpperCase()}_TOKENS`;
}
function accountKey(provider: CalendarProviderId): string {
  return `GOODVIBES_CALENDAR_${provider.toUpperCase()}_ACCOUNT`;
}
function statusKey(provider: CalendarProviderId): string {
  return `GOODVIBES_CALENDAR_${provider.toUpperCase()}_STATUS`;
}

const ALL_PROVIDERS: readonly CalendarProviderId[] = ['google', 'microsoft'];

export interface CalendarTokenStoreOptions {
  readonly secrets: SecretStoreSlice;
  readonly clock?: Clock;
  /** How long before expiry a token counts as due for refresh. */
  readonly refreshLeewayMs?: number;
}

/** A refresh failure the caller turns into a "reconnect needed" surface. */
export class TokenRefreshError extends Error {
  readonly provider: CalendarProviderId;
  constructor(provider: CalendarProviderId, message: string) {
    super(message);
    this.name = 'TokenRefreshError';
    this.provider = provider;
  }
}

export class CalendarTokenStore {
  private readonly secrets: SecretStoreSlice;
  private readonly clock: Clock;
  private readonly leewayMs: number;

  constructor(options: CalendarTokenStoreOptions) {
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => Date.now());
    this.leewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;
  }

  /** Persist a fresh token set + account metadata; clears any reconnect marker. */
  async save(provider: CalendarProviderId, tokens: StoredTokenSet, account: ConnectedAccount): Promise<void> {
    await this.secrets.set(tokenKey(provider), JSON.stringify(tokens));
    await this.secrets.set(accountKey(provider), JSON.stringify(account));
    await this.secrets.delete(statusKey(provider));
  }

  /** Read the stored token set for a provider, or null when disconnected. */
  async load(provider: CalendarProviderId): Promise<StoredTokenSet | null> {
    const raw = await this.secrets.get(tokenKey(provider));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokenSet;
    } catch {
      return null;
    }
  }

  /** Read the account metadata for a provider, or null. */
  async loadAccount(provider: CalendarProviderId): Promise<ConnectedAccount | null> {
    const raw = await this.secrets.get(accountKey(provider));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConnectedAccount;
    } catch {
      return null;
    }
  }

  /** List every connected account across providers. */
  async listAccounts(): Promise<ConnectedAccount[]> {
    const out: ConnectedAccount[] = [];
    for (const provider of ALL_PROVIDERS) {
      const account = await this.loadAccount(provider);
      if (account) out.push(account);
    }
    return out;
  }

  /** The honest connection state, from the marker + stored set + clock. */
  async connectionState(provider: CalendarProviderId): Promise<ConnectionState> {
    if (await this.secrets.get(statusKey(provider))) return 'reconnect-needed';
    const tokens = await this.load(provider);
    if (!tokens) return 'disconnected';
    if (typeof tokens.expiresAt !== 'number') return 'connected';
    if (this.clock() < tokens.expiresAt - this.leewayMs) return 'connected';
    return tokens.refreshToken ? 'refresh-due' : 'reconnect-needed';
  }

  /**
   * Return a usable access token, refreshing first when it is due. On a refresh
   * failure this records a durable reconnect-needed marker and throws
   * TokenRefreshError — never returns a stale/invalid token as if it were good.
   */
  async getFreshAccessToken(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
  ): Promise<string> {
    const tokens = await this.load(provider);
    if (!tokens) throw new TokenRefreshError(provider, `No ${provider} account is connected.`);
    const due = typeof tokens.expiresAt === 'number' && this.clock() >= tokens.expiresAt - this.leewayMs;
    if (!due) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await this.markReconnectNeeded(provider);
      throw new TokenRefreshError(provider, `The ${provider} access token expired and no refresh token is stored.`);
    }
    let refreshed: StoredTokenSet;
    try {
      refreshed = await refreshAccessToken(config, fetchImpl, tokens.refreshToken, this.clock());
    } catch (error) {
      await this.markReconnectNeeded(provider);
      const detail = error instanceof OAuthFlowError ? error.message : String(error);
      throw new TokenRefreshError(provider, `Refreshing the ${provider} token failed: ${detail}`);
    }
    const account = (await this.loadAccount(provider)) ?? this.syntheticAccount(provider, refreshed);
    await this.save(provider, refreshed, account);
    return refreshed.accessToken;
  }

  /**
   * Disconnect a provider: revoke the token at the provider when possible, then
   * delete every stored key. Returns whether the provider-side revocation succeeded
   * (false for providers without a revocation endpoint — disconnect is still local).
   */
  async disconnect(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
  ): Promise<{ readonly revokedRemotely: boolean }> {
    const tokens = await this.load(provider);
    let revokedRemotely = false;
    if (tokens) {
      revokedRemotely = await revokeToken(config, fetchImpl, tokens.refreshToken ?? tokens.accessToken);
    }
    await this.secrets.delete(tokenKey(provider));
    await this.secrets.delete(accountKey(provider));
    await this.secrets.delete(statusKey(provider));
    return { revokedRemotely };
  }

  private async markReconnectNeeded(provider: CalendarProviderId): Promise<void> {
    await this.secrets.set(statusKey(provider), 'reconnect-needed');
  }

  private syntheticAccount(provider: CalendarProviderId, tokens: StoredTokenSet): ConnectedAccount {
    return {
      provider,
      accountId: provider,
      label: provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook',
      scopes: tokens.scopes ?? [],
      connectedAt: tokens.obtainedAt,
    };
  }
}
