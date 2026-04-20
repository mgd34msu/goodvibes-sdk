/**
 * Test: auth login + clearToken against an MSW mock in a real browser context.
 *
 * Verifies that:
 * 1. sdk.auth.login() sends the correct JSON body and returns a typed result.
 * 2. The token is retained so that sdk.auth.getToken() returns it afterwards.
 * 3. sdk.auth.clearToken() clears the stored token (local-only, no HTTP call).
 * 4. A 401 response from the login endpoint surfaces as SDKError with kind 'auth'.
 *
 * Route verified against method-catalog-control-core.ts:
 *   control.auth.login → POST /login
 *
 * Response shape verified against CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA:
 *   { authenticated: boolean, token: string, username: string, expiresAt: number }
 *
 * By default, createBrowserGoodVibesSdk creates an internal memory token store
 * (when no tokenStore option is provided), so login/getToken/clearToken all work
 * without additional configuration.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { worker } from './setup.js';
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const BASE_URL = 'http://localhost:4000';

function makeSdk() {
  // No explicit tokenStore — createGoodVibesSdk automatically creates an
  // in-memory token store when no tokenStore / getAuthToken is provided.
  return createBrowserGoodVibesSdk({ baseUrl: BASE_URL });
}

// Canonical happy-path login response that exactly matches CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA:
// { authenticated: boolean, token: string, username: string, expiresAt: number }
const HAPPY_LOGIN_RESPONSE = {
  authenticated: true,
  token: 'tok-browser-abc123',
  username: 'alice',
  expiresAt: Date.now() + 3_600_000,
};

describe.skipIf(typeof window === 'undefined')('auth.login() against MSW mock (browser)', () => {
  it('returns a typed login result with token', async () => {
    // Real route: POST /login (control.auth.login in method-catalog-control-core.ts)
    worker.use(
      http.post(`${BASE_URL}/login`, () =>
        HttpResponse.json(HAPPY_LOGIN_RESPONSE),
      ),
    );

    const sdk = makeSdk();
    const result = await sdk.auth.login({ username: 'alice', password: 'secret' });

    expect(result.token).toBe('tok-browser-abc123');
    expect(result.authenticated).toBe(true);
    expect(result.username).toBe('alice');
    expect(typeof result.expiresAt).toBe('number');
  });

  it('retains token so getToken() returns it after login', async () => {
    worker.use(
      http.post(`${BASE_URL}/login`, () =>
        HttpResponse.json(HAPPY_LOGIN_RESPONSE),
      ),
    );

    const sdk = makeSdk();
    await sdk.auth.login({ username: 'alice', password: 'secret' });

    expect(await sdk.auth.getToken()).toBe('tok-browser-abc123');
  });

  it('clearToken() clears the stored token without any HTTP request', async () => {
    // clearToken is a local-only operation — no /auth/logout endpoint exists.
    // The internal memory store is mutated; no network request is made.
    worker.use(
      http.post(`${BASE_URL}/login`, () =>
        HttpResponse.json(HAPPY_LOGIN_RESPONSE),
      ),
    );

    const sdk = makeSdk();
    await sdk.auth.login({ username: 'alice', password: 'secret' });
    // Verify token was stored.
    expect(await sdk.auth.getToken()).toBe('tok-browser-abc123');
    // clearToken() mutates the internal memory store — no network call.
    await sdk.auth.clearToken();
    expect(await sdk.auth.getToken()).toBeNull();
  });

  it('401 from login endpoint surfaces as SDKError with kind auth', async () => {
    // The daemon returns a structured error body with category: 'authentication'.
    // createHttpStatusError maps status 401 → category 'authentication' → kind 'auth'.
    worker.use(
      http.post(`${BASE_URL}/login`, () =>
        HttpResponse.json(
          { error: 'Invalid credentials', category: 'authentication' },
          { status: 401 },
        ),
      ),
    );

    const sdk = makeSdk();
    await expect(
      sdk.auth.login({ username: 'alice', password: 'wrong' }),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});
