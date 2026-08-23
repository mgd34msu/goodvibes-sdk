/**
 * The aggregate provider auth summary agrees with its own routes.
 *
 * Two defects pinned here, both observed on a live daemon:
 *
 * 1. A provider whose subscription-oauth route was usable and healthy still
 *    reported aggregate `configured: false` with "OPENAI_API_KEY or OPENAI_KEY
 *    not set", because the aggregate only ever looked at the env vars.
 *    `summarizeProviderAuth` folds the routes into the aggregate: any usable
 *    route (or a configured one with a real credential behind it) makes the
 *    provider configured, and the detail names that route.
 *
 * 2. A catalog-derived provider with no declared auth metadata (abacusai)
 *    reported one dead-end 'none' route, so a stored ABACUSAI_API_KEY could
 *    never register anywhere. Such a provider now derives the conventional
 *    env name from its id and exposes real api-key and secret-ref routes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  buildStandardProviderAuthRoutes,
  deriveProviderApiKeyEnvVar,
  summarizeProviderAuth,
} from '../packages/sdk/src/platform/providers/runtime-metadata.ts';
import type { ProviderAuthRouteDescriptor, ProviderRuntimeMetadataDeps } from '../packages/sdk/src/platform/providers/interface.ts';

function emptyDeps(): ProviderRuntimeMetadataDeps {
  return {
    subscriptionManager: { get: () => null, getPending: () => null },
    serviceRegistry: { getAll: () => ({}), inspect: async () => null },
    secretsManager: { get: async () => null, listDetailed: async () => [] },
  } as never;
}

function subscriptionRoute(overrides: Partial<ProviderAuthRouteDescriptor> = {}): ProviderAuthRouteDescriptor {
  return {
    route: 'subscription-oauth',
    label: 'Subscription OAuth',
    configured: true,
    usable: true,
    freshness: 'healthy',
    detail: 'A stored subscription OAuth session is available for this provider.',
    ...overrides,
  };
}

describe('summarizeProviderAuth', () => {
  test('a usable subscription route flips the aggregate and the detail names it', () => {
    const auth = summarizeProviderAuth(
      { configured: false, detail: 'OPENAI_API_KEY or OPENAI_KEY not set' },
      [
        { route: 'api-key', label: 'Ambient API key', configured: false, usable: false, freshness: 'unconfigured' },
        subscriptionRoute(),
      ],
    );
    expect(auth.configured).toBe(true);
    expect(auth.detail).toContain('Subscription OAuth');
    expect(auth.detail).not.toContain('OPENAI_API_KEY');
  });

  test('a built-in adapter with no stored session does not flip the aggregate', () => {
    const base = { configured: false, detail: 'OPENAI_API_KEY or OPENAI_KEY not set' };
    const auth = summarizeProviderAuth(base, [
      subscriptionRoute({
        usable: false,
        freshness: 'unconfigured',
        detail: 'A built-in subscription OAuth adapter is available, but no session is stored yet.',
      }),
    ]);
    expect(auth).toEqual(base);
  });

  test('a configured route with an expired session still counts as configured', () => {
    const auth = summarizeProviderAuth(
      { configured: false, detail: 'API key not set' },
      [subscriptionRoute({ usable: false, freshness: 'expired', detail: 'The provider ended this subscription session; it must be signed in again.' })],
    );
    expect(auth.configured).toBe(true);
    expect(auth.detail).toContain('Subscription OAuth');
  });

  test('a locally configured base passes through unchanged', () => {
    const base = { configured: true, detail: 'OpenAI API key available' };
    expect(summarizeProviderAuth(base, [subscriptionRoute()])).toEqual(base);
  });
});

describe('derived auth routes for routeless catalog providers', () => {
  // The machine running these tests may genuinely hold this key (it is how
  // the live defect was noticed), so every test starts from a clean slate and
  // restores whatever was there.
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env['ABACUSAI_API_KEY'];
    delete process.env['ABACUSAI_API_KEY'];
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env['ABACUSAI_API_KEY'] = savedKey;
    else delete process.env['ABACUSAI_API_KEY'];
  });

  test('deriveProviderApiKeyEnvVar follows the uppercase-underscore convention', () => {
    expect(deriveProviderApiKeyEnvVar('abacusai')).toBe('ABACUSAI_API_KEY');
    expect(deriveProviderApiKeyEnvVar('my-provider.v2')).toBe('MY_PROVIDER_V2_API_KEY');
  });

  test('a provider with no declared auth metadata gets api-key and secret-ref routes under the derived name', async () => {
    const routes = await buildStandardProviderAuthRoutes({ providerId: 'abacusai' }, emptyDeps());
    expect(routes.map((route) => route.route)).toEqual(['api-key', 'secret-ref']);
    const apiKey = routes.find((route) => route.route === 'api-key');
    expect(apiKey?.envVars).toEqual(['ABACUSAI_API_KEY']);
    expect(apiKey?.secretKeys).toEqual(['ABACUSAI_API_KEY']);
    expect(apiKey?.configured).toBe(false);
    const secretRef = routes.find((route) => route.route === 'secret-ref');
    expect(secretRef?.secretKeys).toEqual(['ABACUSAI_API_KEY']);
  });

  test('the derived env var registers when set, making the api-key route usable', async () => {
    process.env['ABACUSAI_API_KEY'] = 'live-key';
    const routes = await buildStandardProviderAuthRoutes({ providerId: 'abacusai' }, emptyDeps());
    const apiKey = routes.find((route) => route.route === 'api-key');
    expect(apiKey?.configured).toBe(true);
    expect(apiKey?.usable).toBe(true);
    expect(apiKey?.freshness).toBe('healthy');
  });

  test('a stored secret under the derived name registers on the api-key route', async () => {
    const deps = {
      ...emptyDeps(),
      secretsManager: {
        get: async () => null,
        listDetailed: async () => [{ key: 'ABACUSAI_API_KEY', source: 'store' }],
      },
    } as never;
    const routes = await buildStandardProviderAuthRoutes({ providerId: 'abacusai' }, deps);
    const apiKey = routes.find((route) => route.route === 'api-key');
    expect(apiKey?.configured).toBe(true);
    expect(apiKey?.detail).toMatch(/secret store/i);
  });

  test('a subscription-only provider keeps its declared surface and gains no derived key route', async () => {
    // openai-codex declares only a subscription route by design; the built-in
    // openai adapter makes that route exist, so the derivation must not fire.
    const routes = await buildStandardProviderAuthRoutes(
      { providerId: 'openai-codex', subscriptionProviderId: 'openai' },
      emptyDeps(),
    );
    expect(routes.some((route) => route.route === 'subscription-oauth')).toBe(true);
    expect(routes.some((route) => route.route === 'api-key')).toBe(false);
    expect(routes.some((route) => route.envVars?.includes('OPENAI_CODEX_API_KEY'))).toBe(false);
  });
});
