/**
 * Keeping a usable Google access token available.
 *
 * Responsibilities, in order of how often they bite:
 *
 *   1. Refresh before use, not after failure. An expired access token that is
 *      only discovered when a call 401s turns every first call of a session
 *      into a retry. Expiry is checked up front with a minute of slack.
 *   2. Never refresh concurrently. Several tool calls arriving at once must
 *      share one refresh, or Google sees a burst of identical grants and the
 *      losers race to overwrite each other's token.
 *   3. Persist the result where it was safe to persist it — the encrypted
 *      secret store. Credentials adopted from another tool's files are
 *      **never written back**; that tool owns them and is still using them.
 *   4. Report a dead refresh token in plain language. A revoked grant is the
 *      one failure a human must act on, and it must not look like a network
 *      blip.
 */

import type { GoogleOAuthCredentials } from './credential-adoption.js';

/** Result of exchanging a refresh token for a new access token. */
export interface GoogleRefreshResult {
  readonly accessToken: string;
  /** Seconds until expiry, as Google returns it. */
  readonly expiresInSeconds: number;
  /** Google may return a narrowed scope set; null when unchanged. */
  readonly scopes: readonly string[] | null;
}

/** Why a refresh failed. Distinguishes "act on this" from "try again". */
export type GoogleRefreshFailure =
  /** The refresh token is revoked, expired or invalid. A human must re-authorize. */
  | 'grant-invalid'
  /** Network or server-side problem. Retrying later is reasonable. */
  | 'transient';

export type GoogleRefreshOutcome =
  | { readonly ok: true; readonly result: GoogleRefreshResult }
  | { readonly ok: false; readonly failure: GoogleRefreshFailure; readonly problem: string; readonly fix: string };

/** Injected token-refresh call. Must never include token values in errors. */
export type GoogleRefreshFn = (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly tokenUri: string;
}) => Promise<GoogleRefreshOutcome>;

/** Persists a refreshed access token. Only ever called for store-owned credentials. */
export type GooglePersistFn = (input: {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}) => Promise<void>;

export interface GoogleTokenManagerDeps {
  readonly refresh: GoogleRefreshFn;
  /** Omitted for adopted credentials, which must not be written back. */
  readonly persist?: GooglePersistFn;
  readonly now?: () => number;
}

/** A token ready to use, plus how it was obtained. */
export interface GoogleAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number | null;
  /** True when this call performed a refresh rather than reusing a cached token. */
  readonly refreshed: boolean;
}

export type GoogleAccessTokenOutcome =
  | { readonly ok: true; readonly token: GoogleAccessToken }
  | { readonly ok: false; readonly failure: GoogleRefreshFailure; readonly problem: string; readonly fix: string };

/** Refresh this far before actual expiry so a call never races the clock. */
const EXPIRY_SKEW_MS = 60_000;

export class GoogleTokenManager {
  private credentials: GoogleOAuthCredentials;
  private readonly deps: GoogleTokenManagerDeps;
  private readonly now: () => number;
  /** In-flight refresh, shared by every caller that arrives during it. */
  private inFlight: Promise<GoogleAccessTokenOutcome> | null = null;
  /**
   * The dead-grant latch.
   *
   * Once Google has answered `invalid_grant` for this refresh token, the answer
   * is final: the token is not going to start working again, and asking a
   * second time cannot produce new information. The observed failure was six
   * identical refresh attempts against a revoked grant, each one a round trip
   * that told the person nothing.
   *
   * So the first `grant-invalid` is remembered and every later call returns it
   * from here without touching the network. This is a latch rather than a
   * counter because the correct number of repeat attempts is zero, not fewer.
   * `clearGrantFailure()` lifts it, and only re-authorization should call that.
   */
  private deadGrant: { readonly problem: string; readonly fix: string } | null = null;

  constructor(credentials: GoogleOAuthCredentials, deps: GoogleTokenManagerDeps) {
    this.credentials = credentials;
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * True when the grant is known dead and no further refresh will be attempted.
   * Callers use this to explain rather than to retry.
   */
  grantIsDead(): boolean {
    return this.deadGrant !== null;
  }

  /**
   * Forget a recorded dead grant so refreshes are attempted again.
   *
   * Only meaningful after the credential itself has been replaced — a fresh
   * consent produces a different refresh token, and holding the old verdict
   * against it would make a successful re-authorization look like a failure.
   */
  clearGrantFailure(): void {
    this.deadGrant = null;
  }

  /** The recorded verdict, so a caller can restate it without re-asking Google. */
  private deadGrantOutcome(): GoogleAccessTokenOutcome {
    const recorded = this.deadGrant;
    return recorded === null
      ? { ok: false, failure: 'transient', problem: 'No refresh has been attempted.', fix: 'Try again.' }
      : { ok: false, failure: 'grant-invalid', problem: recorded.problem, fix: recorded.fix };
  }

  /** Scopes the current credential was granted. Safe to display. */
  scopes(): readonly string[] {
    return this.credentials.scopes;
  }

  /** True when the cached access token can still be used. */
  private cachedTokenUsable(): boolean {
    if (this.credentials.accessToken === null) return false;
    // An unknown expiry is treated as unusable: refreshing unnecessarily costs
    // one request, whereas using a dead token costs a failed user-visible call.
    if (this.credentials.expiresAtMs === null) return false;
    return this.credentials.expiresAtMs - EXPIRY_SKEW_MS > this.now();
  }

  /**
   * Get a usable access token, refreshing if needed.
   * Concurrent callers share a single refresh.
   */
  async accessToken(): Promise<GoogleAccessTokenOutcome> {
    // A dead grant is answered from memory. Checked before the cache so the
    // verdict is not hidden by a token that happens to still be within its
    // expiry window.
    if (this.deadGrant !== null) return this.deadGrantOutcome();

    if (this.cachedTokenUsable()) {
      const accessToken = this.credentials.accessToken;
      if (accessToken !== null) {
        return {
          ok: true,
          token: { accessToken, expiresAtMs: this.credentials.expiresAtMs, refreshed: false },
        };
      }
    }

    const existing = this.inFlight;
    if (existing !== null) return existing;

    const attempt = this.performRefresh();
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Force a refresh regardless of cached expiry. Used by the boot-time check,
   * which is specifically proving the refresh token still works.
   */
  async forceRefresh(): Promise<GoogleAccessTokenOutcome> {
    // "Force" overrides the expiry cache, not the dead-grant verdict. Nothing
    // is gained by re-asking Google about a token it has already rejected.
    if (this.deadGrant !== null) return this.deadGrantOutcome();

    const existing = this.inFlight;
    if (existing !== null) return existing;
    const attempt = this.performRefresh();
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = null;
    }
  }

  private async performRefresh(): Promise<GoogleAccessTokenOutcome> {
    const outcome = await this.deps.refresh({
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
      refreshToken: this.credentials.refreshToken,
      tokenUri: this.credentials.tokenUri,
    });

    if (!outcome.ok) {
      // Record a dead grant so this exact request is never sent again. A
      // transient failure is deliberately NOT latched — retrying a network
      // blip is reasonable, retrying a revoked token is not.
      if (outcome.failure === 'grant-invalid') {
        this.deadGrant = { problem: outcome.problem, fix: outcome.fix };
      }
      return { ok: false, failure: outcome.failure, problem: outcome.problem, fix: outcome.fix };
    }

    const expiresAtMs = this.now() + outcome.result.expiresInSeconds * 1000;
    this.credentials = {
      ...this.credentials,
      accessToken: outcome.result.accessToken,
      expiresAtMs,
      ...(outcome.result.scopes === null ? {} : { scopes: outcome.result.scopes }),
    };

    // Adopted credentials belong to another tool that is still running against
    // them. Reading them is fine; writing them back is not.
    if (this.deps.persist !== undefined && this.credentials.origin === 'secret-store') {
      await this.deps.persist({ accessToken: outcome.result.accessToken, expiresAtMs });
    }

    return {
      ok: true,
      token: { accessToken: outcome.result.accessToken, expiresAtMs, refreshed: true },
    };
  }
}

/**
 * The boot-time check.
 *
 * Proves at startup whether Google actually works, by exchanging the refresh
 * token for an access token — a request that reads nothing, sends nothing and
 * changes nothing on the account. A session then knows its real posture
 * instead of inferring it from an empty registry, which is precisely the
 * mistake that led to a user being told email was unconfigured while working
 * credentials sat on disk.
 *
 * Never throws, never logs a token, and is safe to run on every start.
 */
export interface GoogleBootCheckResult {
  readonly usable: boolean;
  /** Plain-language posture line, safe for a status panel or transcript. */
  readonly detail: string;
  readonly needsReauthorization: boolean;
  readonly scopes: readonly string[];
}

export async function checkGoogleCredentialsAtBoot(
  manager: GoogleTokenManager | null,
): Promise<GoogleBootCheckResult> {
  if (manager === null) {
    return {
      usable: false,
      detail: 'Google is not connected. Say the word and I will connect an account.',
      needsReauthorization: false,
      scopes: [],
    };
  }

  const outcome = await manager.forceRefresh();
  if (outcome.ok) {
    return {
      usable: true,
      detail: 'Google is connected and the credential refreshed successfully.',
      needsReauthorization: false,
      scopes: manager.scopes(),
    };
  }

  return {
    usable: false,
    detail:
      outcome.failure === 'grant-invalid'
        ? `Google credentials are no longer valid: ${outcome.problem}`
        : `Google could not be reached to check credentials: ${outcome.problem}`,
    needsReauthorization: outcome.failure === 'grant-invalid',
    scopes: manager.scopes(),
  };
}
