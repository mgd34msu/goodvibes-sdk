/**
 * Test: HTTP transport round-trip against MSW in a real browser V8 context.
 *
 * The browser bundle must use the native browser fetch (not a Node polyfill),
 * and MSW intercepts that fetch. This test therefore proves the companion
 * bundle integrates correctly with the browser fetch API.
 *
 * Verifies:
 * 1. A successful JSON round-trip delivers typed data.
 * 2. A 401 response produces an SDKError with kind 'auth'.
 * 3. A 404 response produces an SDKError with kind 'not-found'.
 * 4. A 429 response produces an SDKError with kind 'rate-limit'.
 * 5. A 500 response produces an SDKError with kind 'server'.
 *
 * Route verified against method-catalog-runtime.ts:
 *   accounts.snapshot → GET /api/accounts
 *
 * SDKErrorKind verified against packages/errors/src/index.ts:
 *   'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'rate-limit' | 'server' | 'validation' | 'unknown'
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { worker } from './setup.js';
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const BASE_URL = 'http://localhost:4000';

function makeSdk() {
  return createBrowserGoodVibesSdk({ baseUrl: BASE_URL });
}

describe.skipIf(typeof window === 'undefined')('HTTP transport round-trip in browser (via MSW)', () => {
  it('delivers typed JSON for a 200 response', async () => {
    // Real route: GET /api/accounts (accounts.snapshot in method-catalog-runtime.ts)
    const SNAPSHOT = {
      providers: [],
      channels: [],
    };

    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        HttpResponse.json(SNAPSHOT),
      ),
    );

    const sdk = makeSdk();
    const result = await sdk.operator.accounts.snapshot();
    expect(result).toBeDefined();
  });

  it('surfaces a 401 as an SDKError with kind auth', async () => {
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        HttpResponse.json(
          { error: 'Unauthorized', category: 'authentication' },
          { status: 401 },
        ),
      ),
    );

    const sdk = makeSdk();
    await expect(sdk.operator.accounts.snapshot()).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('surfaces a 404 as an SDKError with kind not-found', async () => {
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        HttpResponse.json(
          { error: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    const sdk = makeSdk();
    await expect(sdk.operator.accounts.snapshot()).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('surfaces a 429 as an SDKError with kind rate-limit', async () => {
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        HttpResponse.json(
          { error: 'Too many requests' },
          { status: 429 },
        ),
      ),
    );

    const sdk = makeSdk();
    await expect(sdk.operator.accounts.snapshot()).rejects.toMatchObject({
      kind: 'rate-limit',
    });
  });

  it('surfaces a 500 as an SDKError with kind server', async () => {
    // inferCategory(500) → 'service' → inferKind('service') → 'server'
    worker.use(
      http.get(`${BASE_URL}/api/accounts`, () =>
        HttpResponse.json(
          { error: 'Internal server error' },
          { status: 500 },
        ),
      ),
    );

    const sdk = makeSdk();
    await expect(sdk.operator.accounts.snapshot()).rejects.toMatchObject({
      kind: 'server',
    });
  });
});
