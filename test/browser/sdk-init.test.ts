/**
 * Test: SDK initialises and exposes expected surface in a browser V8 context.
 *
 * This is the most basic smoke test — if the bundle fails to parse, this
 * will be the first thing to break. We import createBrowserGoodVibesSdk and
 * verify that the returned SDK has the expected shape without making any
 * network requests.
 */
import { describe, it, expect } from 'vitest';
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

describe('SDK initialisation (browser)', () => {
  it('auth facade exposes login, getToken, clearToken, current', () => {
    const sdk = createBrowserGoodVibesSdk({
      baseUrl: 'http://localhost:4000',
    });

    expect(typeof sdk.auth.login).toBe('function');
    expect(typeof sdk.auth.getToken).toBe('function');
    // clearToken is the real method — sdk.auth.logout does not exist
    expect(typeof sdk.auth.clearToken).toBe('function');
    expect(typeof sdk.auth.current).toBe('function');
  });

  it('realtime facade exposes viaSse and viaWebSocket', () => {
    const sdk = createBrowserGoodVibesSdk({
      baseUrl: 'http://localhost:4000',
    });

    expect(typeof sdk.realtime.viaSse).toBe('function');
    expect(typeof sdk.realtime.viaWebSocket).toBe('function');
  });

  it.skipIf(typeof window === 'undefined')('uses location.origin as baseUrl when omitted', () => {
    // In a browser context, location.origin is always defined.
    // createBrowserGoodVibesSdk must not throw when baseUrl is omitted.
    expect(() => createBrowserGoodVibesSdk()).not.toThrow();
  });
});
