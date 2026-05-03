/**
 * Test: Error paths — service and network failures produce SDKError of the correct kind.
 *
 * Verifies that when the server returns:
 * 1. A 500 response with a non-JSON body — the SDK throws an SDKError with kind 'service'.
 * 2. A network-level failure (MSW emits a network error) — SDKError kind is exactly 'network'.
 * 3. A 401 response from the login endpoint — SDKError kind is exactly 'auth'.
 *
 * Routes verified against method catalogs:
 *   accounts.snapshot → GET /api/accounts  (method-catalog-runtime.ts)
 *   control.auth.login → POST /login        (method-catalog-control-core.ts)
 *
 * SDKErrorKind values verified against packages/errors/src/index.ts:
 *   'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'protocol' | 'rate-limit' | 'service' | 'internal' | 'tool' | 'validation' | 'unknown'
 *
 * Error kind derivation:
 *   fetch() throws → createNetworkTransportError(category: 'network') → kind: 'network'
 *   status 500 → inferCategory(500) → 'service' → inferKind('service') → 'service'
 *   status 401 → inferCategory(401) → 'authentication' → inferKind('authentication') → 'auth'
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { worker } from './setup.js';
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const BASE_URL = 'http://localhost:4000';

function makeSdk() {
  return createBrowserGoodVibesSdk({ baseUrl: BASE_URL });
}

describe.skipIf(typeof window === 'undefined')('Error paths (browser)', () => {
  it('500 response with non-JSON body surfaces as SDKError with kind service', async () => {
    // readJsonBody returns the text string when JSON.parse fails (no throw on parse).
    // However, the 500 status triggers the !response.ok branch in requestJson(),
    // which calls createTransportError(500, ...) → createHttpStatusError →
    // inferCategory(500) = 'service' → inferKind('service') = 'service'.
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        new HttpResponse('Internal Server Error (plain text)', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );

    const sdk = makeSdk();
    await expect(sdk.operator.accounts.snapshot()).rejects.toMatchObject({
      kind: 'service',
    });
  });

  it('network-level failure (MSW network error) surfaces as SDKError with kind network', async () => {
    // HttpResponse.error() simulates a network-level failure before a response is received.
    // The transport layer catches the thrown TypeError and calls createNetworkTransportError
    // with category: 'network' → kind: 'network'.
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () => {
        return HttpResponse.error();
      }),
    );

    const sdk = makeSdk();
    const error = await sdk.operator.accounts.snapshot().catch((e: unknown) => e);

    expect(error).toBeDefined();
    expect((error as Record<string, unknown>).kind).toBe('network');
  });

  it('401 response from login endpoint surfaces as SDKError with kind auth', async () => {
    // Real route: POST /login (control.auth.login in method-catalog-control-core.ts)
    // inferCategory(401) = 'authentication' → inferKind = 'auth'
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
      sdk.auth.login({ username: 'bob', password: 'wrong' }),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});
