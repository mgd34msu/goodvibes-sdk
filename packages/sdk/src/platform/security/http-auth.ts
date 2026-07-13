import { createHash, timingSafeEqual } from 'node:crypto';
import type { UserAuthManager } from './user-auth.js';

export const OPERATOR_SESSION_COOKIE_NAME = 'goodvibes_session';

export type AuthenticatedOperatorRequest =
  | {
      readonly kind: 'shared-token';
      readonly token: string;
    }
  | {
      readonly kind: 'pairing-token';
      readonly token: string;
      /** The per-pairing token's id (for `pairing:<id>` principal derivation). */
      readonly tokenId: string;
      /** The user-visible device name for this token. */
      readonly name: string;
    }
  | {
      readonly kind: 'session';
      readonly token: string;
      readonly username: string;
      readonly roles: readonly string[];
    };

/**
 * The synchronous per-pairing token authenticator the operator-auth path
 * consults BEFORE the legacy shared token. A revoked token misses here, so
 * revocation is honored on the very next request. Absent ⇒ no per-pairing
 * tokens are configured (only the shared token / user sessions authenticate).
 */
export interface PairingTokenAuthenticator {
  authenticate(token: string): { readonly id: string; readonly name: string } | null;
  /** Whether the legacy single shared token has been revoked. */
  isLegacyRevoked(): boolean;
}

interface SessionCookieOptions {
  readonly req: Request;
  readonly expiresAt: number;
  readonly trustProxy?: boolean | undefined;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const segment of header.split(';')) {
    const [rawName, ...rawValueParts] = segment.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    const rawValue = rawValueParts.join('=').trim();
    if (!rawValue) continue;
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

function isSecureRequest(req: Request, trustProxy = false): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === 'https:') return true;
  } catch {
    // Ignore malformed URLs; Bun always provides a valid request URL.
  }
  if (!trustProxy) return false;
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? '';
  return forwardedProto
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .some((value) => value === 'https');
}

export function extractOperatorAuthToken(
  req: Request,
): string {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const sessionCookie = parseCookies(req.headers.get('cookie')).get(OPERATOR_SESSION_COOKIE_NAME)?.trim();
  if (sessionCookie) return sessionCookie;

  return '';
}

/**
 * Compare two tokens in constant time without leaking length via early-exit.
 * Hash both sides with SHA-256 so the Buffers are always 32 bytes before
 * calling timingSafeEqual, eliminating the length-based side-channel that a
 * plain Buffer.from(token).length check or early-return on length mismatch
 * would have exposed.
 */
function matchesSharedToken(token: string, sharedToken: string): boolean {
  const aHash = createHash('sha256').update(token).digest();
  const bHash = createHash('sha256').update(sharedToken).digest();
  return timingSafeEqual(aHash, bHash);
}

export function authenticateOperatorToken(
  token: string,
  context: {
    readonly sharedToken?: string | null | undefined;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
    readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  },
): AuthenticatedOperatorRequest | null {
  const normalized = token.trim();
  if (!normalized) return null;

  // Try per-pairing tokens first. A named, individually-revocable device token
  // matches here; a revoked one misses (revocation honored on the next request).
  const pairing = context.pairingTokens?.authenticate(normalized);
  if (pairing) {
    return { kind: 'pairing-token', token: normalized, tokenId: pairing.id, name: pairing.name };
  }

  // Then the legacy shared token — unless it has been revoked. A non-match must
  // still be checked as a user session so session cookies remain valid when
  // operator tooling also uses a bearer token.
  if (
    context.sharedToken &&
    context.pairingTokens?.isLegacyRevoked() !== true &&
    matchesSharedToken(normalized, context.sharedToken)
  ) {
    return { kind: 'shared-token', token: normalized };
  }

  const session = context.userAuth.validateSession(normalized);
  if (!session) return null;
  const user = context.userAuth.getUser(session.username);
  if (!user) return null;
  return {
    kind: 'session',
    token: normalized,
    username: user.username,
    roles: user.roles,
  };
}

export function authenticateOperatorRequest(
  req: Request,
  context: {
    readonly sharedToken?: string | null | undefined;
    readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'getUser'>;
    readonly pairingTokens?: PairingTokenAuthenticator | undefined;
  },
): AuthenticatedOperatorRequest | null {
  return authenticateOperatorToken(extractOperatorAuthToken(req), context);
}

export function isOperatorAdmin(authenticated: AuthenticatedOperatorRequest | null): boolean {
  if (!authenticated) return false;
  // A paired device holds the same operator authority as the shared token.
  if (authenticated.kind === 'shared-token' || authenticated.kind === 'pairing-token') return true;
  return authenticated.roles.includes('admin');
}

export function buildOperatorSessionCookie(token: string, options: SessionCookieOptions): string {
  const maxAgeSeconds = Math.max(0, Math.floor((options.expiresAt - Date.now()) / 1_000));
  const secure = isSecureRequest(options.req, options.trustProxy);
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(options.expiresAt).toUTCString()}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildExpiredOperatorSessionCookie(req: Request, trustProxy = false): string {
  const parts = [
    `${OPERATOR_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (isSecureRequest(req, trustProxy)) parts.push('Secure');
  return parts.join('; ');
}
