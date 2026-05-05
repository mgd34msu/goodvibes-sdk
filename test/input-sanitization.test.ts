import { describe, expect, test } from 'bun:test';
import {
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
  OPERATOR_SESSION_COOKIE_NAME,
} from '../packages/sdk/src/platform/security/index.js';
import {
  buildExpiredOperatorSessionCookie,
  buildOperatorSessionCookie,
} from '../packages/sdk/src/platform/security/http-auth.js';

describe('platform/security — http-auth smoke', () => {
  test('OPERATOR_SESSION_COOKIE_NAME is a non-empty string', () => {
    expect(typeof OPERATOR_SESSION_COOKIE_NAME).toBe('string');
    expect(OPERATOR_SESSION_COOKIE_NAME.length).toBeGreaterThan(0);
  });

  test('extractOperatorAuthToken returns empty string for a request with no auth header', () => {
    const req = new Request('http://localhost/api/test');
    const token = extractOperatorAuthToken(req);
    expect(token).toBe('');
  });

  test('extractOperatorAuthToken returns token from Bearer Authorization header', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { Authorization: 'Bearer my-secret-token' },
    });
    const token = extractOperatorAuthToken(req);
    expect(token).toBe('my-secret-token');
  });

  test('extractOperatorAuthToken gives Authorization precedence over session cookies', () => {
    const req = new Request('http://localhost/api/test', {
      headers: {
        Authorization: 'Basic not-a-bearer-token',
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=session%20token`,
      },
    });
    expect(extractOperatorAuthToken(req)).toBe('Basic not-a-bearer-token');
  });

  test('extractOperatorAuthToken trims bearer values before authentication', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { Authorization: 'Bearer   padded-token   ' },
    });
    expect(extractOperatorAuthToken(req)).toBe('padded-token');
  });

  test('authenticateOperatorToken checks shared tokens in constant-time path and falls through to sessions', () => {
    const userAuth = {
      validateSession: (token: string) => token === 'session-token' ? { username: 'alice' } : null,
      getUser: (username: string) => username === 'alice'
        ? { username: 'alice', roles: ['admin'] as const }
        : null,
    };

    const shared = authenticateOperatorToken('shared-token', {
      sharedToken: 'shared-token',
      userAuth,
    });
    expect(shared).toEqual({ kind: 'shared-token', token: 'shared-token' });
    expect(isOperatorAdmin(shared)).toBe(true);

    const session = authenticateOperatorToken('session-token', {
      sharedToken: 'different-shared-token',
      userAuth,
    });
    expect(session).toEqual({
      kind: 'session',
      token: 'session-token',
      username: 'alice',
      roles: ['admin'],
    });
    expect(isOperatorAdmin(session)).toBe(true);
  });

  test('session cookie builders set security attributes according to request security', () => {
    const secureReq = new Request('https://localhost/api/test');
    const insecureReq = new Request('http://localhost/api/test');
    const expiresAt = Date.now() + 60_000;

    const cookie = buildOperatorSessionCookie('session token', { req: secureReq, expiresAt });
    expect(cookie).toContain(`${OPERATOR_SESSION_COOKIE_NAME}=session%20token`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');

    const expired = buildExpiredOperatorSessionCookie(insecureReq);
    expect(expired).toContain(`${OPERATOR_SESSION_COOKIE_NAME}=`);
    expect(expired).toContain('Max-Age=0');
    expect(expired).not.toContain('Secure');
  });

  test('session cookie builders honor trusted proxy HTTPS headers only when enabled', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const expiresAt = Date.now() + 60_000;

    expect(buildOperatorSessionCookie('token', { req, expiresAt })).not.toContain('Secure');
    expect(buildOperatorSessionCookie('token', { req, expiresAt, trustProxy: true })).toContain('Secure');
    expect(buildExpiredOperatorSessionCookie(req)).not.toContain('Secure');
    expect(buildExpiredOperatorSessionCookie(req, true)).toContain('Secure');
  });
});
