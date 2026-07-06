/**
 * Tests for SDKErrorCode typed union and related helpers.
 *
 * Covers:
 * - SDKErrorCode union membership via SDKErrorCodes const
 * - isErrorCode() type guard
 * - isKnownErrorCode() runtime check
 * - Automatic code inference from HTTP status codes
 * - Automatic code inference from ErrorCategory
 * - Body-supplied code precedence over status inference in createHttpStatusError
 * - Backward compatibility: arbitrary string codes still accepted
 * - Code is always present on GoodVibesSdkError (never undefined)
 * - ConfigurationError, ContractError, HttpStatusError default codes
 * - 409 CONFLICT code inference from status
 * - All inference paths exercised
 */
import { describe, it, expect, test } from 'bun:test';
import {
  GoodVibesSdkError,
  ConfigurationError,
  ContractError,
  HttpStatusError,
  createHttpStatusError,
  isErrorCode,
  isKnownErrorCode,
  SDKErrorCodes,
  type SDKErrorCode,
} from '../packages/errors/src/index.js';

// ---------------------------------------------------------------------------
// SDKErrorCodes const object
// ---------------------------------------------------------------------------

describe('SDKErrorCodes const object', () => {
  test('is a record with string values', () => {
    for (const [key, value] of Object.entries(SDKErrorCodes)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
      expect(key).toBe(value);
    }
  });

  test('contains all expected canonical codes', () => {
    const expected: SDKErrorCode[] = [
      'AUTH_REQUIRED',
      'TOKEN_EXPIRED',
      'PERMISSION_DENIED',
      'PAYMENT_REQUIRED',
      'RATE_LIMITED',
      'NETWORK_UNREACHABLE',
      'TIMEOUT',
      'CANCELLED',
      'NOT_FOUND',
      'CONFLICT',
      'SESSION_CLOSED',
      'NOT_INVOKABLE',
      'VALIDATION_FAILED',
      'AGENT_TIMEOUT',
      'AGENT_FAILED',
      'TOOL_EXEC_FAILED',
      'SERVICE_UNAVAILABLE',
      'CONTRACT_MISMATCH',
      'PROTOCOL_ERROR',
      'INTERNAL_ERROR',
      'SDK_CONFIGURATION_ERROR',
      'SDK_CONTRACT_ERROR',
      'SDK_HTTP_STATUS_ERROR',
      'UNKNOWN',
    ];
    for (const code of expected) {
      expect(SDKErrorCodes[code]).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// isKnownErrorCode()
// ---------------------------------------------------------------------------

describe('isKnownErrorCode()', () => {
  test('returns true for every SDKErrorCode value', () => {
    for (const code of Object.values(SDKErrorCodes)) {
      expect(isKnownErrorCode(code)).toBe(true);
    }
  });

  test('returns false for arbitrary strings', () => {
    expect(isKnownErrorCode('SOME_CUSTOM_CODE')).toBe(false);
    expect(isKnownErrorCode('')).toBe(false);
    expect(isKnownErrorCode('rate_limited')).toBe(false); // lowercase
  });
});

// ---------------------------------------------------------------------------
// isErrorCode() type guard
// ---------------------------------------------------------------------------

describe('isErrorCode() type guard', () => {
  test('returns true when err.code matches the given SDKErrorCode', () => {
    const err = new GoodVibesSdkError('test', { category: 'rate_limit' });
    expect(isErrorCode(err, SDKErrorCodes.RATE_LIMITED)).toBe(true);
  });

  test('returns false when err.code does not match', () => {
    const err = new GoodVibesSdkError('test', { category: 'rate_limit' });
    expect(isErrorCode(err, SDKErrorCodes.NOT_FOUND)).toBe(false);
  });

  test('works with explicit custom string code', () => {
    const err = new GoodVibesSdkError('test', { code: 'MY_CUSTOM_CODE' });
    // Cannot use isErrorCode with a non-SDKErrorCode literal, but we can test
    // that it correctly returns false for known codes.
    expect(isErrorCode(err, SDKErrorCodes.UNKNOWN)).toBe(false);
    // The custom code is still accessible.
    expect(err.code).toBe('MY_CUSTOM_CODE');
  });

  test('works with plain objects (not just GoodVibesSdkError)', () => {
    const obj = { code: 'RATE_LIMITED' as const };
    expect(isErrorCode(obj, SDKErrorCodes.RATE_LIMITED)).toBe(true);
    expect(isErrorCode(obj, SDKErrorCodes.NOT_FOUND)).toBe(false);
  });

  test('returns false when code is undefined', () => {
    const obj: { code?: string } = {};
    expect(isErrorCode(obj, SDKErrorCodes.RATE_LIMITED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Automatic code inference from HTTP status
// ---------------------------------------------------------------------------

describe('HTTP status code inference', () => {
  const cases: Array<[number, SDKErrorCode]> = [
    [400, 'VALIDATION_FAILED'],
    [401, 'AUTH_REQUIRED'],
    [402, 'PAYMENT_REQUIRED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [408, 'TIMEOUT'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVICE_UNAVAILABLE'],
    [502, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'SERVICE_UNAVAILABLE'],
  ];

  for (const [status, expectedCode] of cases) {
    test(`status ${status} -> code ${expectedCode}`, () => {
      const err = new GoodVibesSdkError(`error ${status}`, { status });
      expect(err.code).toBe(expectedCode);
    });
  }

  test('unknown status produces UNKNOWN code', () => {
    const err = new GoodVibesSdkError('custom', { status: 418 });
    expect(err.code).toBe('UNKNOWN');
  });

  test('no status + no category produces UNKNOWN code', () => {
    const err = new GoodVibesSdkError('bare error');
    expect(err.code).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Automatic code inference from ErrorCategory
// ---------------------------------------------------------------------------

describe('ErrorCategory code inference', () => {
  const cases: Array<[import('../packages/errors/src/index.js').ErrorCategory, SDKErrorCode]> = [
    ['authentication', 'AUTH_REQUIRED'],
    ['authorization', 'PERMISSION_DENIED'],
    ['billing', 'PAYMENT_REQUIRED'],
    ['permission', 'PERMISSION_DENIED'],
    ['config', 'SDK_CONFIGURATION_ERROR'],
    ['contract', 'CONTRACT_MISMATCH'],
    ['network', 'NETWORK_UNREACHABLE'],
    ['timeout', 'TIMEOUT'],
    ['not_found', 'NOT_FOUND'],
    ['rate_limit', 'RATE_LIMITED'],
    ['protocol', 'PROTOCOL_ERROR'],
    ['internal', 'INTERNAL_ERROR'],
    ['service', 'SERVICE_UNAVAILABLE'],
    ['bad_request', 'VALIDATION_FAILED'],
    ['tool', 'TOOL_EXEC_FAILED'],
    ['unknown', 'UNKNOWN'],
  ];

  for (const [category, expectedCode] of cases) {
    test(`category '${category}' -> code '${expectedCode}'`, () => {
      // Use a status that has no inference (e.g. 200 range never triggered here)
      // to force category-based inference.
      const err = new GoodVibesSdkError('test', { category });
      expect(err.code).toBe(expectedCode);
    });
  }
});

// ---------------------------------------------------------------------------
// Status inference WINS over category when both are present
// (status is more specific; category is a fallback path)
// ---------------------------------------------------------------------------

describe('status-vs-category precedence', () => {
  test('status inference precedes category inference', () => {
    // 404 -> NOT_FOUND wins over category: unknown
    const err = new GoodVibesSdkError('test', { status: 404, category: 'unknown' });
    expect(err.code).toBe('NOT_FOUND');
  });

  test('explicit code always wins over both status and category', () => {
    const err = new GoodVibesSdkError('test', {
      code: 'TOKEN_EXPIRED',
      status: 401,
      category: 'authentication',
    });
    expect(err.code).toBe('TOKEN_EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// createHttpStatusError code inference
// ---------------------------------------------------------------------------

describe('createHttpStatusError code inference', () => {
  test('structured body without code -> status inferred code', () => {
    const err = createHttpStatusError(429, 'http://x.com', 'GET', { error: 'Too many requests' });
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.category).toBe('rate_limit');
  });

  test('structured body with explicit code -> body code wins', () => {
    const err = createHttpStatusError(429, 'http://x.com', 'GET', {
      error: 'Rate limited — token quota',
      code: 'TOKEN_EXPIRED',
    });
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  test('structured body category overrides status category', () => {
    const err = createHttpStatusError(500, 'http://x.com', 'GET', {
      error: 'rate limited by provider',
      category: 'rate_limit',
    });
    expect(err.category).toBe('rate_limit');
    expect(err.code).toBe('RATE_LIMITED');
  });

  test('unstructured body -> status inferred code', () => {
    const err = createHttpStatusError(404, 'http://x.com', 'GET', 'Not Found');
    expect(err.code).toBe('NOT_FOUND');
  });

  test('unstructured body null -> status inferred code', () => {
    const err = createHttpStatusError(503, 'http://x.com', 'POST', null);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
  });

  test('401 -> AUTH_REQUIRED with structured body', () => {
    const err = createHttpStatusError(401, 'http://x.com', 'GET', { error: 'Unauthorized' });
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(isErrorCode(err, SDKErrorCodes.AUTH_REQUIRED)).toBe(true);
  });

  test('403 -> PERMISSION_DENIED with structured body', () => {
    const err = createHttpStatusError(403, 'http://x.com', 'GET', { error: 'Forbidden' });
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(isErrorCode(err, SDKErrorCodes.PERMISSION_DENIED)).toBe(true);
  });

  test('409 -> CONFLICT', () => {
    const err = createHttpStatusError(409, 'http://x.com', 'POST', { error: 'Conflict' });
    expect(err.code).toBe('CONFLICT');
    expect(isErrorCode(err, SDKErrorCodes.CONFLICT)).toBe(true);
  });

  test('retryAfterMs propagates from structured body', () => {
    const err = createHttpStatusError(429, 'http://x.com', 'GET', {
      error: 'Rate limited',
      retryAfterMs: 5000,
    });
    expect(err.retryAfterMs).toBe(5000);
    expect(err.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// Default codes on subclasses
// ---------------------------------------------------------------------------

describe('subclass default codes', () => {
  test('ConfigurationError.code is SDK_CONFIGURATION_ERROR', () => {
    const err = new ConfigurationError('bad config');
    expect(err.code).toBe('SDK_CONFIGURATION_ERROR');
    expect(isErrorCode(err, SDKErrorCodes.SDK_CONFIGURATION_ERROR)).toBe(true);
  });

  test('ConfigurationError accepts custom code override', () => {
    const err = new ConfigurationError('bad config', { code: 'MY_CONFIG_ERR' });
    expect(err.code).toBe('MY_CONFIG_ERR');
  });

  test('ContractError.code is SDK_CONTRACT_ERROR', () => {
    const err = new ContractError('bad contract');
    expect(err.code).toBe('SDK_CONTRACT_ERROR');
    expect(isErrorCode(err, SDKErrorCodes.SDK_CONTRACT_ERROR)).toBe(true);
  });

  test('ContractError accepts custom code override', () => {
    const err = new ContractError('bad contract', { code: 'MY_CONTRACT_ERR' });
    expect(err.code).toBe('MY_CONTRACT_ERR');
  });

  test('HttpStatusError.code defaults to SDK_HTTP_STATUS_ERROR when no status', () => {
    const err = new HttpStatusError('raw error');
    expect(err.code).toBe('SDK_HTTP_STATUS_ERROR');
  });

  test('HttpStatusError constructor default wins over status inference', () => {
    // HttpStatusError constructor explicitly sets code: 'SDK_HTTP_STATUS_ERROR'
    // so the final code is always SDK_HTTP_STATUS_ERROR (constructor overrides).
    // For status-specific codes, use createHttpStatusError instead.
    const err = new HttpStatusError('x', { status: 429 });
    expect(err.code).toBe('SDK_HTTP_STATUS_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: arbitrary string codes
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  test('arbitrary string code still type-checks and is stored', () => {
    // This must not produce a TypeScript error — the open string & {} union allows it.
    const err = new GoodVibesSdkError('x', { code: 'LEGACY_APP_ERROR' });
    expect(err.code).toBe('LEGACY_APP_ERROR');
  });

  test('code field is always present (never undefined) on GoodVibesSdkError', () => {
    const err = new GoodVibesSdkError('x');
    expect(err.code).toBeDefined();
    expect(typeof err.code).toBe('string');
  });

  test('toJSON() includes code field', () => {
    const err = new GoodVibesSdkError('x', { category: 'rate_limit' });
    const json = err.toJSON();
    expect(json.code).toBe('RATE_LIMITED');
  });

  test('existing error-kind tests still pass: 401 kind is auth', () => {
    const err = createHttpStatusError(401, 'http://x.com', 'GET', { error: 'Unauthorized' });
    expect(err.kind).toBe('auth');
    // Code is now also inferred
    expect(err.code).toBe('AUTH_REQUIRED');
  });

  test('cause-based category inference still works', () => {
    const cause = { category: 'rate_limit' };
    const err = new GoodVibesSdkError('derived from cause', { cause });
    expect(err.category).toBe('rate_limit');
    expect(err.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// Agent-specific and domain-specific codes accessible via SDKErrorCodes
// ---------------------------------------------------------------------------

describe('agent and domain-specific codes', () => {
  test('AGENT_TIMEOUT is in SDKErrorCodes', () => {
    expect(SDKErrorCodes.AGENT_TIMEOUT).toBe('AGENT_TIMEOUT');
    expect(isKnownErrorCode('AGENT_TIMEOUT')).toBe(true);
  });

  test('AGENT_FAILED is in SDKErrorCodes', () => {
    expect(SDKErrorCodes.AGENT_FAILED).toBe('AGENT_FAILED');
    expect(isKnownErrorCode('AGENT_FAILED')).toBe(true);
  });

  test('TOKEN_EXPIRED is in SDKErrorCodes', () => {
    expect(SDKErrorCodes.TOKEN_EXPIRED).toBe('TOKEN_EXPIRED');
    expect(isKnownErrorCode('TOKEN_EXPIRED')).toBe(true);
  });

  test('CANCELLED is in SDKErrorCodes', () => {
    expect(SDKErrorCodes.CANCELLED).toBe('CANCELLED');
    expect(isKnownErrorCode('CANCELLED')).toBe(true);
  });

  test('explicit AGENT_TIMEOUT code survives round-trip through toJSON', () => {
    const err = new GoodVibesSdkError('agent timed out', {
      code: SDKErrorCodes.AGENT_TIMEOUT,
      category: 'timeout',
    });
    const json = err.toJSON();
    expect(json.code).toBe('AGENT_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// switch exhaustiveness pattern (compile + runtime)
// ---------------------------------------------------------------------------

describe('switch exhaustiveness', () => {
  test('switch on code covers all SDKErrorCode values at runtime', () => {
    const allCodes = Object.values(SDKErrorCodes) as SDKErrorCode[];
    const handled: SDKErrorCode[] = [];

    for (const code of allCodes) {
      const err: { code: SDKErrorCode | (string & {}) } = { code };
      if (!isKnownErrorCode(err.code)) continue;
      const knownCode: SDKErrorCode = err.code;
      switch (knownCode) {
        case 'AUTH_REQUIRED':
        case 'TOKEN_EXPIRED':
        case 'PERMISSION_DENIED':
        case 'PAYMENT_REQUIRED':
        case 'RATE_LIMITED':
        case 'NETWORK_UNREACHABLE':
        case 'TIMEOUT':
        case 'CANCELLED':
        case 'NOT_FOUND':
        case 'CONFLICT':
        case 'SESSION_CLOSED':
        case 'NOT_INVOKABLE':
        case 'VALIDATION_FAILED':
        case 'AGENT_TIMEOUT':
        case 'AGENT_FAILED':
        case 'TOOL_EXEC_FAILED':
        case 'SERVICE_UNAVAILABLE':
        case 'CONTRACT_MISMATCH':
        case 'PROTOCOL_ERROR':
        case 'INTERNAL_ERROR':
        case 'SDK_CONFIGURATION_ERROR':
        case 'SDK_CONTRACT_ERROR':
        case 'SDK_HTTP_STATUS_ERROR':
        case 'UNKNOWN':
          handled.push(knownCode);
          break;
      }
    }

    expect(handled.length).toBe(allCodes.length);
    expect(handled).toEqual(expect.arrayContaining(allCodes));
  });
});
