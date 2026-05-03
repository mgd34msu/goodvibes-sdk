import { describe, expect, test } from 'bun:test';
import { OAuthClient } from '../packages/sdk/src/platform/runtime/auth/oauth-client.js';
import type { OAuthProviderConfig } from '../packages/sdk/src/platform/config/subscriptions.js';

const BASE_CONFIG: OAuthProviderConfig = {
  clientId: 'test-client-id',
  authUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  redirectUri: 'http://localhost:4000/callback',
  scopes: ['openid', 'profile'],
};

describe('OAuthClient', () => {
  describe('beginAuthorization', () => {
    test('returns a valid authorization URL', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization();
      expect(result.authorizationUrl).toMatch(/^https:\/\/auth\.example\.com\/authorize/);
    });

    test('authorization URL contains client_id', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization();
      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
    });

    test('authorization URL contains scopes', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization();
      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get('scope')).toBe('openid profile');
    });

    test('includes PKCE code_challenge by default', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization();
      const url = new URL(result.authorizationUrl);
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    test('returns state and verifier for the callback phase', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization();
      expect(result.state).toHaveLength(32);
      expect(result.verifier).toHaveLength(43);
    });

    test('accepts explicit state and verifier overrides', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const result = await client.beginAuthorization({ state: 'fixed-state', verifier: 'fixed-verifier' });
      expect(result.state).toBe('fixed-state');
      expect(result.verifier).toBe('fixed-verifier');
    });

    test('generates unique state on each call', async () => {
      const client = new OAuthClient(BASE_CONFIG);
      const r1 = await client.beginAuthorization();
      const r2 = await client.beginAuthorization();
      expect(r1.state).not.toBe(r2.state);
    });
  });

  describe('decodeJwtPayload', () => {
    test('decodes a well-formed JWT payload', () => {
      const payload = { sub: '123', name: 'Alice' };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const jwt = `header.${encoded}.sig`;
      const client = new OAuthClient(BASE_CONFIG);
      const decoded = client.decodeJwtPayload(jwt);
      expect(decoded).toMatchObject(payload);
    });

    test('returns null for a non-JWT string', () => {
      const client = new OAuthClient(BASE_CONFIG);
      expect(client.decodeJwtPayload('not-a-jwt')).toBeNull();
    });

    test('returns null for malformed base64 in payload segment', () => {
      const client = new OAuthClient(BASE_CONFIG);
      expect(client.decodeJwtPayload('header.!!!invalid!!!.sig')).toBeNull();
    });
  });

  describe('config accessor', () => {
    test('exposes the config passed at construction', () => {
      const client = new OAuthClient(BASE_CONFIG);
      expect(client.config).toBe(BASE_CONFIG);
    });
  });
});
