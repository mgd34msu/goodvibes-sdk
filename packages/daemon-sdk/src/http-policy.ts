import { jsonErrorResponse } from './error-response.js';
import { missingScopes } from './route-helpers.js';

/** The kind of authenticated principal making a daemon request. */
export type AuthenticatedPrincipalKind = 'user' | 'bot' | 'service' | 'token';

/** Describes an authenticated caller resolved from a daemon request token. */
export interface AuthenticatedPrincipal {
  /** Opaque identifier for this principal. */
  readonly principalId: string;
  /** The category of this principal. */
  readonly principalKind: AuthenticatedPrincipalKind;
  /** Whether this principal has administrative privileges. */
  readonly admin: boolean;
  /** The permission scopes granted to this principal. */
  readonly scopes: readonly string[];
}

/** Strategy object for extracting and resolving a daemon auth token to a principal. */
export interface AuthenticatedPrincipalResolver {
  /** Extract the raw auth token from the incoming request. */
  readonly extractAuthToken: (req: Request) => string;
  /** Resolve a token string to an `AuthenticatedPrincipal`, or `null` if invalid. */
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
}

/** Config context required to evaluate whether private-host fetches are permitted. */
export interface PrivateHostFetchConfig {
  readonly configManager: {
    get(key: string): unknown;
  };
}

/**
 * Extended config for private-host fetch evaluation that also enforces an
 * elevated-access gate on the originating request.
 */
export interface ElevatedPrivateHostFetchConfig extends PrivateHostFetchConfig {
  /** The originating request to check for elevated access. */
  readonly req: Request;
  /** Returns a `Response` to deny access, or `null` to allow. */
  readonly requireElevatedAccess: (req: Request) => Response | null;
}

/**
 * Extract and resolve the auth token from a request to an `AuthenticatedPrincipal`.
 *
 * @param req - The incoming HTTP request.
 * @param resolver - Strategy for extracting the token and resolving it to a principal.
 * @returns The resolved principal, or `null` if no valid token is present.
 */
export function resolveAuthenticatedPrincipal(
  req: Request,
  resolver: AuthenticatedPrincipalResolver,
): AuthenticatedPrincipal | null {
  const token = resolver.extractAuthToken(req);
  return token ? resolver.describeAuthenticatedPrincipal(token) : null;
}

/**
 * Build a structured 403 response body when a principal is missing required scopes.
 *
 * @param target - Human-readable name of the resource or action being checked.
 * @param requiredScopes - Scopes required to perform the action.
 * @param grantedScopes - Scopes held by the caller.
 * @returns An error body object, or `null` if all required scopes are present.
 */
export function buildMissingScopeBody(
  target: string,
  requiredScopes: readonly string[],
  grantedScopes: readonly string[] | undefined,
): {
  readonly error: string;
  readonly requiredScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly missingScopes: readonly string[];
} | null {
  const missing = missingScopes(grantedScopes, requiredScopes);
  if (missing.length === 0) return null;
  return {
    error: `Missing required scope${missing.length === 1 ? '' : 's'} for ${target}: ${missing.join(', ')}`,
    requiredScopes: [...requiredScopes],
    grantedScopes: [...(grantedScopes ?? [])],
    missingScopes: missing,
  };
}

/**
 * Resolve fetch options for a private-host request, enforcing config and access gates.
 *
 * @param requested - The caller-supplied flag; must be `true` to attempt private-host access.
 * @param context - Config context (and optionally an elevated-access gate).
 * @returns Options object to merge into the fetch call, an empty object if not requested,
 *   or a `Response` to short-circuit with a 403 if access is denied.
 */
export function resolvePrivateHostFetchOptions(
  requested: unknown,
  context: PrivateHostFetchConfig | ElevatedPrivateHostFetchConfig,
): { allowPrivateHosts: true; fetchMode: 'allow-private-hosts' } | Record<string, never> | Response {
  if (requested !== true) return {};
  if (!Boolean(context.configManager.get('network.remoteFetch.allowPrivateHosts'))) {
    return jsonErrorResponse({ error: 'Private-host remote fetches are disabled by config.' }, { status: 403 });
  }
  if ('requireElevatedAccess' in context) {
    const denied = context.requireElevatedAccess(context.req);
    if (denied) return denied;
  }
  return { allowPrivateHosts: true, fetchMode: 'allow-private-hosts' };
}
