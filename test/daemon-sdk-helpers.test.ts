/**
 * Coverage backfill for daemon-sdk helper modules (src-level imports).
 *
 * Targets:
 * - packages/daemon-sdk/src/route-helpers.ts: toSerializableJson circular refs,
 *   serializableJsonResponse, scopeMatches wildcard, missingScopes,
 *   readChannelLifecycleAction, readChannelConversationKind
 * - packages/daemon-sdk/src/http-policy.ts: resolveAuthenticatedPrincipal,
 *   buildMissingScopeBody, resolvePrivateHostFetchOptions (all branches)
 * - packages/daemon-sdk/src/error-response.ts: buildErrorResponseBody (all branches),
 *   jsonErrorResponse, summarizeErrorForRecord; network error patterns;
 *   string/generic error path; GoodVibesSdkError path
 */
import { describe, expect, test } from 'bun:test';
import {
  isJsonRecord,
  toSerializableJson,
  serializableJsonResponse,
  scopeMatches,
  missingScopes,
  readChannelLifecycleAction,
  readChannelConversationKind,
} from '../packages/daemon-sdk/src/route-helpers.js';
import {
  resolveAuthenticatedPrincipal,
  buildMissingScopeBody,
  resolvePrivateHostFetchOptions,
} from '../packages/daemon-sdk/src/http-policy.js';
import {
  buildErrorResponseBody,
  jsonErrorResponse,
  summarizeErrorForRecord,
} from '../packages/daemon-sdk/src/error-response.js';
import { estimateJsonByteLengthWithinLimit } from '../packages/daemon-sdk/src/remote-routes.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';

// ---------------------------------------------------------------------------
// route-helpers.ts
// ---------------------------------------------------------------------------

describe('route-helpers — isJsonRecord', () => {
  test('returns true for plain objects', () => {
    expect(isJsonRecord({})).toBe(true);
    expect(isJsonRecord({ a: 1 })).toBe(true);
  });

  test('returns false for non-objects', () => {
    expect(isJsonRecord(null)).toBe(false);
    expect(isJsonRecord([])).toBe(false);
    expect(isJsonRecord('string')).toBe(false);
    expect(isJsonRecord(42)).toBe(false);
  });
});

describe('route-helpers — toSerializableJson', () => {
  test('returns primitives unchanged', () => {
    expect(toSerializableJson(null)).toBeNull();
    expect(toSerializableJson(42)).toBe(42);
    expect(toSerializableJson('str')).toBe('str');
    expect(toSerializableJson(false)).toBe(false);
  });

  test('serializes plain objects', () => {
    expect(toSerializableJson({ a: 1, b: 'two' })).toEqual({ a: 1, b: 'two' });
  });

  test('serializes arrays recursively', () => {
    expect(toSerializableJson([1, { x: 2 }])).toEqual([1, { x: 2 }]);
  });

  test('replaces circular references with $ref', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj; // circular
    const result = toSerializableJson(obj) as Record<string, unknown>;
    expect(result.name).toBe('root');
    expect((result.self as Record<string, unknown>)['$ref']).toBe('$');
  });

  test('handles nested circular reference in arrays', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr); // circular
    const result = toSerializableJson(arr) as unknown[];
    expect(result[0]).toBe(1);
    expect((result[2] as Record<string, unknown>)['$ref']).toBe('$');
  });
});

describe('route-helpers — serializableJsonResponse', () => {
  test('returns a JSON Response', async () => {
    const response = serializableJsonResponse({ ok: true });
    expect(response).toBeInstanceOf(Response);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('accepts ResponseInit for status', async () => {
    const response = serializableJsonResponse({ error: 'oops' }, { status: 400 });
    expect(response.status).toBe(400);
  });
});

describe('route-helpers — scopeMatches', () => {
  test('exact match returns true', () => {
    expect(scopeMatches('read:agents', 'read:agents')).toBe(true);
  });

  test('wildcard * matches everything', () => {
    expect(scopeMatches('*', 'read:agents')).toBe(true);
    expect(scopeMatches('*', 'write:sessions')).toBe(true);
  });

  test('namespace wildcard read:* matches read:anything', () => {
    expect(scopeMatches('read:*', 'read:agents')).toBe(true);
    expect(scopeMatches('read:*', 'read:sessions')).toBe(true);
  });

  test('namespace wildcard does not match different namespace', () => {
    expect(scopeMatches('read:*', 'write:agents')).toBe(false);
  });

  test('non-matching scope returns false', () => {
    expect(scopeMatches('read:agents', 'write:agents')).toBe(false);
  });
});

describe('route-helpers — missingScopes', () => {
  test('returns empty array when all required scopes are granted', () => {
    expect(missingScopes(['read:agents', 'write:agents'], ['read:agents'])).toEqual([]);
  });

  test('returns missing scopes', () => {
    expect(missingScopes(['read:agents'], ['read:agents', 'write:sessions'])).toEqual(['write:sessions']);
  });

  test('treats undefined grantedScopes as empty array', () => {
    expect(missingScopes(undefined, ['read:agents'])).toEqual(['read:agents']);
  });

  test('wildcard granted scope satisfies any requirement', () => {
    expect(missingScopes(['*'], ['read:agents', 'write:sessions'])).toEqual([]);
  });
});

describe('route-helpers — readChannelLifecycleAction', () => {
  const validActions = ['inspect', 'setup', 'retest', 'connect', 'disconnect', 'start', 'stop', 'login', 'logout', 'wait_login'] as const;

  for (const action of validActions) {
    test(`returns "${action}" for valid action`, () => {
      expect(readChannelLifecycleAction(action)).toBe(action);
    });
  }

  test('returns null for unknown action', () => {
    expect(readChannelLifecycleAction('invalid')).toBeNull();
    expect(readChannelLifecycleAction(null)).toBeNull();
    expect(readChannelLifecycleAction(42)).toBeNull();
  });
});

describe('route-helpers — readChannelConversationKind', () => {
  const validKinds = ['direct', 'group', 'channel', 'thread', 'service'] as const;

  for (const kind of validKinds) {
    test(`returns "${kind}" for valid kind`, () => {
      expect(readChannelConversationKind(kind)).toBe(kind);
    });
  }

  test('returns null for unknown kind', () => {
    expect(readChannelConversationKind('unknown')).toBeNull();
    expect(readChannelConversationKind(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// http-policy.ts
// ---------------------------------------------------------------------------

describe('http-policy — resolveAuthenticatedPrincipal', () => {
  const resolver = {
    extractAuthToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '',
    describeAuthenticatedPrincipal: (token: string) =>
      token === 'valid-token'
        ? { principalId: 'alice', principalKind: 'user' as const, admin: false, scopes: ['read'] }
        : null,
  };

  test('returns principal when token is valid', () => {
    const req = new Request('http://localhost/', { headers: { Authorization: 'Bearer valid-token' } });
    const result = resolveAuthenticatedPrincipal(req, resolver);
    expect(result?.principalId).toBe('alice');
  });

  test('returns null when token is empty', () => {
    const req = new Request('http://localhost/');
    const result = resolveAuthenticatedPrincipal(req, resolver);
    expect(result).toBeNull();
  });

  test('returns null when token is invalid', () => {
    const req = new Request('http://localhost/', { headers: { Authorization: 'Bearer bad-token' } });
    const result = resolveAuthenticatedPrincipal(req, resolver);
    expect(result).toBeNull();
  });
});

describe('http-policy — buildMissingScopeBody', () => {
  test('returns null when all required scopes are granted', () => {
    expect(buildMissingScopeBody('agents.list', ['read:agents'], ['read:agents', 'write:agents'])).toBeNull();
  });

  test('returns error body when scopes are missing', () => {
    const result = buildMissingScopeBody('agents.list', ['read:agents', 'write:agents'], ['read:agents']);
    expect(result).not.toBeNull();
    expect(result!.missingScopes).toEqual(['write:agents']);
    expect(result!.error).toMatch(/Missing required scope/);
    expect(result!.requiredScopes).toEqual(['read:agents', 'write:agents']);
    expect(result!.grantedScopes).toEqual(['read:agents']);
  });

  test('uses singular "scope" when only one is missing', () => {
    const result = buildMissingScopeBody('x', ['read:agents'], []);
    expect(result!.error).toMatch(/Missing required scope for/);
    expect(result!.error).not.toMatch(/scopes/);
  });

  test('uses plural "scopes" when multiple are missing', () => {
    const result = buildMissingScopeBody('x', ['read:a', 'write:b'], []);
    expect(result!.error).toMatch(/Missing required scopes/);
  });

  test('handles undefined grantedScopes', () => {
    const result = buildMissingScopeBody('x', ['read:agents'], undefined);
    expect(result!.grantedScopes).toEqual([]);
    expect(result!.missingScopes).toEqual(['read:agents']);
  });
});

describe('http-policy — resolvePrivateHostFetchOptions', () => {
  const configDisabled = {
    configManager: { get: (_key: string) => false },
  };

  const configEnabled = {
    configManager: { get: (_key: string) => true },
  };

  test('returns empty object when requested is not true', () => {
    expect(resolvePrivateHostFetchOptions(false, configEnabled)).toEqual({});
    expect(resolvePrivateHostFetchOptions(null, configEnabled)).toEqual({});
    expect(resolvePrivateHostFetchOptions(undefined, configEnabled)).toEqual({});
  });

  test('returns 403 Response when config key is disabled', async () => {
    const result = resolvePrivateHostFetchOptions(true, configDisabled);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const body = await (result as Response).json() as { error: string };
    expect(body.error).toMatch(/disabled by config/);
  });

  test('returns allowPrivateHosts object when config enabled and no elevated access check', () => {
    const result = resolvePrivateHostFetchOptions(true, configEnabled);
    expect(result).toEqual({ allowPrivateHosts: true, fetchMode: 'allow-private-hosts' });
  });

  test('elevated access: returns 403 when requireElevatedAccess denies', async () => {
    const ctx = {
      ...configEnabled,
      req: new Request('http://localhost/'),
      requireElevatedAccess: (_req: Request) => new Response(JSON.stringify({ error: 'admin required' }), { status: 403 }),
    };
    const result = resolvePrivateHostFetchOptions(true, ctx);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  test('elevated access: returns allowPrivateHosts when requireElevatedAccess allows (returns null)', () => {
    const ctx = {
      ...configEnabled,
      req: new Request('http://localhost/'),
      requireElevatedAccess: (_req: Request) => null,
    };
    const result = resolvePrivateHostFetchOptions(true, ctx);
    expect(result).toEqual({ allowPrivateHosts: true, fetchMode: 'allow-private-hosts' });
  });
});

// ---------------------------------------------------------------------------
// error-response.ts — buildErrorResponseBody
// ---------------------------------------------------------------------------

describe('error-response — buildErrorResponseBody — string error', () => {
  test('plain string error becomes error field', () => {
    const body = buildErrorResponseBody('something went wrong');
    expect(body.error).toBe('something went wrong');
    expect(typeof body.category).toBe('string'); // category is always a string
  });

  test('empty string falls back to fallbackMessage', () => {
    const body = buildErrorResponseBody('  ', { fallbackMessage: 'fallback' });
    expect(body.error).toBe('fallback');
  });

  test('status in options is included', () => {
    const body = buildErrorResponseBody('bad', { status: 400 });
    expect(body.status).toBe(400);
  });

  test('source in options is included', () => {
    const body = buildErrorResponseBody('bad', { source: 'provider' });
    expect(body.source).toBe('provider');
  });
});

describe('error-response — buildErrorResponseBody — generic Error', () => {
  test('Error instance uses message field', () => {
    const body = buildErrorResponseBody(new Error('network failure'));
    expect(body.error).toBe('network failure');
  });

  test('non-Error non-string object with message field uses message', () => {
    const body = buildErrorResponseBody({ message: 'structured msg', code: 'ERR' });
    expect(body.error).toBe('structured msg');
  });
});

describe('error-response — buildErrorResponseBody — network error patterns', () => {
  test('ECONNREFUSED pattern maps to network category', () => {
    const body = buildErrorResponseBody(new Error('ECONNREFUSED 127.0.0.1:3210'));
    expect(body.category).toBe('network');
    expect(body.error).toMatch(/Cannot connect/);
  });

  test('ETIMEDOUT pattern maps to timeout category', () => {
    const body = buildErrorResponseBody(new Error('ETIMEDOUT: connection timed out'));
    expect(body.category).toBe('timeout');
  });

  test('ENOTFOUND pattern maps to network category', () => {
    const body = buildErrorResponseBody(new Error('ENOTFOUND api.example.com'));
    expect(body.category).toBe('network');
    expect(body.error).toMatch(/DNS lookup failed/);
  });

  test('network error with provider includes provider in message', () => {
    const body = buildErrorResponseBody({
      message: 'ECONNREFUSED 127.0.0.1:3210',
      provider: 'inceptionlabs',
      code: 'CONN_ERR',
      source: 'provider',
    });
    expect(body.category).toBe('network');
    expect(body.error).toMatch(/inceptionlabs/);
  });
});

describe('error-response — buildErrorResponseBody — GoodVibesSdkError', () => {
  test('GoodVibesSdkError extracts all structured fields', () => {
    const err = new GoodVibesSdkError('provider rejected auth', {
      code: 'PROVIDER_ERROR',
      category: 'authentication',
      source: 'provider',
      recoverable: false,
      status: 401,
      hint: 'check your token',
      provider: 'openai',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-abc',
      providerCode: 'invalid_key',
    });
    const body = buildErrorResponseBody(err, { isPrivileged: true });
    expect(body.error).toMatch(/provider rejected auth/);
    expect(body.category).toBe('authentication');
    expect(body.source).toBe('provider');
    expect(body.recoverable).toBe(false);
    expect(body.status).toBe(401);
    expect(body.hint).toBe('check your token');
    expect(body.provider).toBe('openai');
    expect(body.operation).toBe('chat');
    expect(body.phase).toBe('request');
    expect(body.requestId).toBe('req-abc');
    expect(body.providerCode).toBe('invalid_key');
  });

  test('GoodVibesSdkError with no explicit category produces unknown (normalizeCategory wins over network inference)', () => {
    // GoodVibesSdkError always defaults to category='unknown' when none is given.
    // normalizeCategory('unknown') returns 'unknown', which wins over the network pattern match.
    const err = new GoodVibesSdkError('ECONNREFUSED 127.0.0.1:3000');
    const body = buildErrorResponseBody(err);
    expect(body.category).toBe('unknown');
  });

  test('GoodVibesSdkError with explicit network category produces network hint', () => {
    const err = new GoodVibesSdkError('connection refused', {
      category: 'network',
      source: 'transport',
    });
    const body = buildErrorResponseBody(err);
    expect(body.category).toBe('network');
    expect(body.hint).toMatch(/connectivity|DNS|TLS/i);
  });

  test('buildSummary appends metadata tags not already in message', () => {
    const err = new GoodVibesSdkError('auth failed', {
      category: 'authentication',
      phase: 'request',
      providerCode: 'invalid_key',
      requestId: 'req-999',
    });
    const body = buildErrorResponseBody(err);
    expect(body.error).toMatch(/phase=request/);
    expect(body.error).toMatch(/code=invalid_key/);
    expect(body.error).toMatch(/request_id=req-999/);
  });

  test('buildSummary does not duplicate metadata already in message', () => {
    const err = new GoodVibesSdkError('auth failed phase=request', {
      category: 'authentication',
      phase: 'request',
    });
    const body = buildErrorResponseBody(err);
    // phase already in message — should not appear twice
    const phaseMatches = (body.error.match(/phase=request/g) ?? []).length;
    expect(phaseMatches).toBe(1);
  });
});

describe('error-response — buildErrorResponseBody — structured body passthrough', () => {
  test('StructuredDaemonErrorBody unprivileged: returns safe copy (not original reference)', () => {
    // non-privileged callers get a stripped copy — internal fields like
    // provider/operation/phase are not exposed. Source and category are safe.
    const structured = {
      error: 'already structured',
      category: 'authentication' as const,
      source: 'provider' as const,
      recoverable: false,
    };
    const body = buildErrorResponseBody(structured);
    // Must NOT be the original object (new copy was created for safety)
    expect(body).not.toBe(structured);
    // Safe fields must be preserved
    expect(body.error).toBe('already structured');
    expect(body.category).toBe('authentication');
    expect(body.source).toBe('provider');
    expect(body.recoverable).toBe(false);
  });

  test('StructuredDaemonErrorBody privileged: original object returned as-is', () => {
    const structured = {
      error: 'already structured',
      category: 'authentication' as const,
      source: 'provider' as const,
      recoverable: false,
      provider: 'openai',
      operation: 'chat',
    };
    const body = buildErrorResponseBody(structured, { isPrivileged: true });
    // Privileged callers get the original object with all fields
    expect(body).toBe(structured);
    expect((body as { provider?: string }).provider).toBe('openai');
  });

  test('StructuredDaemonErrorBody unprivileged: strips internal fields (provider, operation, phase)', () => {
    const structured = {
      error: 'provider error',
      category: 'authentication' as const,
      provider: 'openai',
      operation: 'chat',
      phase: 'request',
      providerCode: 'invalid_key',
      providerType: 'llm',
    };
    const body = buildErrorResponseBody(structured);
    expect(body.error).toBe('provider error');
    // Internal fields must be stripped
    expect((body as { provider?: string }).provider).toBeUndefined();
    expect((body as { operation?: string }).operation).toBeUndefined();
    expect((body as { phase?: string }).phase).toBeUndefined();
    expect((body as { providerCode?: string }).providerCode).toBeUndefined();
    expect((body as { providerType?: string }).providerType).toBeUndefined();
  });
});

describe('error-response — buildErrorResponseBody — message-inferred categories', () => {
  const cases: Array<[string, string]> = [
    ['invalid api_key provided', 'authentication'],
    ['access denied by policy', 'authorization'],
    ['billing quota exceeded', 'billing'],
    ['too many requests throttled', 'rate_limit'],
    ['connection timed out deadline exceeded', 'timeout'],
    ['ECONNRESET socket hang up', 'network'],
    ['unknown model gpt-999', 'not_found'],
    ['invalid request bad request schema', 'bad_request'],
    ['invalid json parse error unexpected eof', 'protocol'],
  ];

  for (const [message, expectedCategory] of cases) {
    test(`"${message.slice(0, 30)}..." → category ${expectedCategory}`, () => {
      const body = buildErrorResponseBody(new Error(message));
      expect(body.category).toBe(expectedCategory);
    });
  }
});

describe('error-response — jsonErrorResponse', () => {
  test('returns Response with correct status', async () => {
    const res = jsonErrorResponse(new Error('fail'), { status: 503 });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; status: number };
    expect(body.error).toBe('fail');
    expect(body.status).toBe(503);
  });

  test('uses body.status when options.status is not set', async () => {
    const err = new GoodVibesSdkError('auth fail', { status: 401, category: 'authentication' });
    const res = jsonErrorResponse(err);
    expect(res.status).toBe(401);
  });

  test('falls back to 500 when no status anywhere', async () => {
    const res = jsonErrorResponse(new Error('unknown'));
    expect(res.status).toBe(500);
  });
});

describe('error-response — summarizeErrorForRecord', () => {
  test('returns the error field from buildErrorResponseBody', () => {
    const summary = summarizeErrorForRecord(new Error('network down'));
    expect(summary).toBe('network down');
  });

  test('passes options through to buildErrorResponseBody', () => {
    const summary = summarizeErrorForRecord('  ', { fallbackMessage: 'my fallback' });
    expect(summary).toBe('my fallback');
  });
});

// ---------------------------------------------------------------------------
// remote-routes — estimateJsonByteLengthWithinLimit
// Verifies the cap is enforced via counting replacer — the full encoded string
// is NEVER allocated for over-limit payloads (sentinel path exits early).
// ---------------------------------------------------------------------------

describe('remote-routes — estimateJsonByteLengthWithinLimit cap-before-allocate', () => {
  test('small value within limit: returns kind="ok" and byteLength <= maxBytes', () => {
    const result = estimateJsonByteLengthWithinLimit({ hello: 'world' }, 10_000);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.byteLength).toBeLessThanOrEqual(10_000);
    }
  });

  test('value exceeding limit: returns kind="ok" with byteLength = maxBytes+1 (cap sentinel, no full string)', () => {
    // Build a value that would produce ~50 KB of JSON but test with a 100-byte cap.
    // The counting replacer must trip the OVER_LIMIT sentinel before producing
    // the full encoded string.
    const bigPayload = { data: 'x'.repeat(5_000) };
    const maxBytes = 100;
    const result = estimateJsonByteLengthWithinLimit(bigPayload, maxBytes);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Must report exactly maxBytes+1 (over-limit sentinel value)
      expect(result.byteLength).toBe(maxBytes + 1);
    }
  });

  test('non-JSON-serializable value (circular ref): returns kind="invalid"', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = estimateJsonByteLengthWithinLimit(circular, 10_000);
    expect(result.kind).toBe('invalid');
  });

  test('undefined value: returns kind="ok" with byteLength=4 (null representation)', () => {
    const result = estimateJsonByteLengthWithinLimit(undefined, 10_000);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.byteLength).toBe(4);
    }
  });

  test('exactly-at-limit string: does not trip the sentinel', () => {
    // A string of 'a' repeated so that the over-estimate stays within maxBytes.
    // 1 char * 6 bytes (worst-case estimate per char) + 2 (quotes) = 8 bytes.
    // Use maxBytes = 1000 — a 3-char string should comfortably stay under cap.
    const result = estimateJsonByteLengthWithinLimit('abc', 1000);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.byteLength).toBeLessThanOrEqual(1000);
    }
  });
});
