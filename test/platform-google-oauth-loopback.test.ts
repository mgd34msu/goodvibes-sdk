/**
 * Tests for the OAuth loopback flow (google-oauth-loopback.ts).
 *
 * The listener tests stand up a REAL HTTP server on a real ephemeral port and
 * drive it with a real `fetch` call — this is the part that actually has to
 * work end to end (redirect capture, state-mismatch rejection, the
 * `?error=` path). Token exchange is proven against an injected fetch fake,
 * since it talks to Google's real token endpoint in production.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkcePair,
  redactSecretsFromMessage,
  refreshAccessToken,
  type GoogleFetchPort,
} from '../packages/sdk/src/platform/google/oauth-loopback.ts';
import { startLoopbackListener } from '../packages/sdk/src/platform/google/node.ts';

describe('generatePkcePair', () => {
  test('produces a code challenge that is the base64url SHA-256 digest of the verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(codeChallenge).toBe(expected);
  });

  test('produces a URL-safe verifier within the RFC 7636 length range', () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_-]+$/.test(codeVerifier)).toBe(true);
  });

  test('generates a different pair on every call', () => {
    const first = generatePkcePair();
    const second = generatePkcePair();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
  });
});

describe('buildAuthorizationUrl', () => {
  test('always includes access_type=offline and prompt=consent so a refresh token is issued', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:5555/',
        scopes: ['scope-a', 'scope-b'],
        codeChallenge: 'challenge-abc',
        state: 'state-xyz',
      }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  test('carries every field the authorization request needs', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'http://127.0.0.1:5555/',
        scopes: ['scope-a', 'scope-b'],
        codeChallenge: 'challenge-abc',
        state: 'state-xyz',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('scope-a scope-b');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-xyz');
  });
});

describe('startLoopbackListener', () => {
  test('captures the authorization code from a real redirect on a real ephemeral port', async () => {
    const listener = startLoopbackListener({ expectedState: 'the-state' });
    try {
      const waiting = listener.waitForCode(5_000);
      const response = await fetch(`${listener.redirectUri}?code=abc123&state=the-state`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('You can close this tab');
      const result = await waiting;
      expect(result.code).toBe('abc123');
      expect(result.state).toBe('the-state');
    } finally {
      listener.close();
    }
  });

  test('rejects waitForCode and serves an error page when the redirect state does not match', async () => {
    const listener = startLoopbackListener({ expectedState: 'expected-state' });
    try {
      const waiting = listener.waitForCode(5_000);
      const response = await fetch(`${listener.redirectUri}?code=abc123&state=wrong-state`);
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('Could not connect');
      await expect(waiting).rejects.toThrow(/state/i);
    } finally {
      listener.close();
    }
  });

  test('rejects waitForCode and serves an error page when Google redirects with ?error=access_denied', async () => {
    const listener = startLoopbackListener({ expectedState: 'the-state' });
    try {
      const waiting = listener.waitForCode(5_000);
      const response = await fetch(`${listener.redirectUri}?error=access_denied&state=the-state`);
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('access_denied');
      await expect(waiting).rejects.toThrow(/access_denied/);
    } finally {
      listener.close();
    }
  });

  test('rejects waitForCode when Google redirects with no authorization code at all', async () => {
    const listener = startLoopbackListener({ expectedState: 'the-state' });
    try {
      const waiting = listener.waitForCode(5_000);
      const response = await fetch(`${listener.redirectUri}?state=the-state`);
      expect(response.status).toBe(400);
      await expect(waiting).rejects.toThrow(/no authorization code/i);
    } finally {
      listener.close();
    }
  });

  test('waitForCode times out when no redirect ever arrives', async () => {
    const listener = startLoopbackListener({ expectedState: 'the-state' });
    try {
      await expect(listener.waitForCode(50)).rejects.toThrow(/timed out/i);
    } finally {
      listener.close();
    }
  });

  test('binds only to 127.0.0.1 and exposes a working redirectUri', async () => {
    const listener = startLoopbackListener({ expectedState: 'the-state' });
    try {
      expect(listener.redirectUri.startsWith('http://127.0.0.1:')).toBe(true);
      expect(listener.redirectUri.endsWith('/')).toBe(true);
    } finally {
      listener.close();
    }
  });
});

describe('exchangeCodeForTokens', () => {
  test('returns typed tokens on a successful exchange', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch(url, init) {
        expect(url).toBe('https://oauth2.googleapis.com/token');
        expect(init.method).toBe('POST');
        const body = String(init.body);
        expect(body).toContain('grant_type=authorization_code');
        return new Response(
          JSON.stringify({
            access_token: 'access-token-value',
            refresh_token: 'refresh-token-value',
            expires_in: 3599,
            scope: 'a b',
            token_type: 'Bearer',
          }),
          { status: 200 },
        );
      },
    };
    const result = await exchangeCodeForTokens(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:1234/',
      },
      fetchPort,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessToken).toBe('access-token-value');
      expect(result.refreshToken).toBe('refresh-token-value');
      expect(result.expiresInSeconds).toBe(3599);
      expect(result.scope).toBe('a b');
    }
  });

  test('returns a problem statement, never the client secret, when Google rejects the code', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch() {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), {
          status: 400,
        });
      },
    };
    const result = await exchangeCodeForTokens(
      {
        clientId: 'client-id',
        clientSecret: 'super-secret-value',
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:1234/',
      },
      fetchPort,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('invalid_grant');
      expect(result.problem).not.toContain('super-secret-value');
    }
  });

  test('redacts the client secret out of a raw network-error message', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch() {
        throw new Error('connect failed for request containing super-secret-value in the log');
      },
    };
    const result = await exchangeCodeForTokens(
      {
        clientId: 'client-id',
        clientSecret: 'super-secret-value',
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:1234/',
      },
      fetchPort,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).not.toContain('super-secret-value');
      expect(result.problem).toContain('[redacted]');
    }
  });

  test('reports a clear problem when the token response is not parseable JSON', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch() {
        return new Response('not json', { status: 200 });
      },
    };
    const result = await exchangeCodeForTokens(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:1234/',
      },
      fetchPort,
    );
    expect(result.ok).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  test('returns a fresh access token on success', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch(_url, init) {
        const body = String(init.body);
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=refresh-token-value');
        return new Response(JSON.stringify({ access_token: 'new-access-token', expires_in: 3600 }), {
          status: 200,
        });
      },
    };
    const result = await refreshAccessToken(
      { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token-value' },
      fetchPort,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe('new-access-token');
  });

  test('redacts the refresh token out of a raw network-error message', async () => {
    const fetchPort: GoogleFetchPort = {
      async fetch() {
        throw new Error('request failed while sending refresh-token-value over the wire');
      },
    };
    const result = await refreshAccessToken(
      { clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token-value' },
      fetchPort,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).not.toContain('refresh-token-value');
  });
});

describe('redactSecretsFromMessage', () => {
  test('replaces every occurrence of a secret with [redacted]', () => {
    const message = 'token=abc123secret was sent twice: abc123secret';
    const redacted = redactSecretsFromMessage(message, ['abc123secret']);
    expect(redacted).not.toContain('abc123secret');
    expect(redacted).toBe('token=[redacted] was sent twice: [redacted]');
  });

  test('ignores undefined and very short candidate values so it never over-redacts', () => {
    const message = 'error code 12';
    const redacted = redactSecretsFromMessage(message, [undefined, '1', '']);
    expect(redacted).toBe(message);
  });
});
