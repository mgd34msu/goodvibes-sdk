/**
 * Tests for SDKError.kind tagged-union field.
 *
 * Verifies that:
 * - Each error class sets the correct `kind` tag
 * - `instanceof` checks still work (backward compat)
 * - `kind` is correctly inferred from HTTP status codes
 * - All SDKErrorKind values are exercised
 */
import { describe, expect, test } from 'bun:test';
import {
  ConfigurationError,
  ContractError,
  GoodVibesSdkError,
  HttpStatusError,
  createHttpStatusError,
} from '../packages/errors/dist/index.js';
import type { SDKErrorKind } from '../packages/errors/dist/index.js';

describe('error-kind: packages/errors', () => {
  describe('GoodVibesSdkError base class', () => {
    test('has kind field', () => {
      const err = new GoodVibesSdkError('base');
      expect(err.kind).toBeDefined();
      expect(typeof err.kind).toBe('string');
    });

    test('kind defaults to unknown when no category or status', () => {
      const err = new GoodVibesSdkError('test');
      expect(err.kind).toBe('unknown');
    });

    test('kind is config when category is config', () => {
      const err = new GoodVibesSdkError('test', { category: 'config' });
      expect(err.kind).toBe('config');
    });

    test('kind is contract when category is contract', () => {
      const err = new GoodVibesSdkError('test', { category: 'contract' });
      expect(err.kind).toBe('contract');
    });

    test('kind is auth when category is authentication', () => {
      const err = new GoodVibesSdkError('test', { category: 'authentication' });
      expect(err.kind).toBe('auth');
    });

    test('kind is auth when category is authorization', () => {
      const err = new GoodVibesSdkError('test', { category: 'authorization' });
      expect(err.kind).toBe('auth');
    });

    test('kind is auth when category is billing', () => {
      const err = new GoodVibesSdkError('test', { category: 'billing' });
      expect(err.kind).toBe('auth');
    });

    test('kind is auth when category is permission', () => {
      const err = new GoodVibesSdkError('test', { category: 'permission' });
      expect(err.kind).toBe('auth');
    });

    test('kind is network when category is network', () => {
      const err = new GoodVibesSdkError('test', { category: 'network' });
      expect(err.kind).toBe('network');
    });

    test('kind is network when category is timeout', () => {
      const err = new GoodVibesSdkError('test', { category: 'timeout' });
      expect(err.kind).toBe('network');
    });

    test('kind is not-found when category is not_found', () => {
      const err = new GoodVibesSdkError('test', { category: 'not_found' });
      expect(err.kind).toBe('not-found');
    });

    test('kind is rate-limit when category is rate_limit', () => {
      const err = new GoodVibesSdkError('test', { category: 'rate_limit' });
      expect(err.kind).toBe('rate-limit');
    });

    test('kind is server when category is service', () => {
      const err = new GoodVibesSdkError('test', { category: 'service' });
      expect(err.kind).toBe('server');
    });

    test('kind is server when category is protocol', () => {
      const err = new GoodVibesSdkError('test', { category: 'protocol' });
      expect(err.kind).toBe('server');
    });

    test('kind is server when category is internal', () => {
      const err = new GoodVibesSdkError('test', { category: 'internal' });
      expect(err.kind).toBe('server');
    });

    test('kind is validation when category is bad_request', () => {
      const err = new GoodVibesSdkError('test', { category: 'bad_request' });
      expect(err.kind).toBe('validation');
    });

    test('kind is unknown when category is tool', () => {
      const err = new GoodVibesSdkError('test', { category: 'tool' });
      expect(err.kind).toBe('unknown');
    });
  });

  describe('ConfigurationError', () => {
    test('has kind config', () => {
      const err = new ConfigurationError('bad config');
      expect(err.kind).toBe('config' satisfies SDKErrorKind);
    });

    test('is instanceof GoodVibesSdkError', () => {
      expect(new ConfigurationError('x')).toBeInstanceOf(GoodVibesSdkError);
    });

    test('is instanceof ConfigurationError', () => {
      expect(new ConfigurationError('x')).toBeInstanceOf(ConfigurationError);
    });
  });

  describe('ContractError', () => {
    test('has kind contract', () => {
      const err = new ContractError('bad contract');
      expect(err.kind).toBe('contract' satisfies SDKErrorKind);
    });

    test('is instanceof GoodVibesSdkError', () => {
      expect(new ContractError('x')).toBeInstanceOf(GoodVibesSdkError);
    });

    test('is instanceof ContractError', () => {
      expect(new ContractError('x')).toBeInstanceOf(ContractError);
    });
  });

  describe('HttpStatusError', () => {
    test('is instanceof GoodVibesSdkError', () => {
      expect(new HttpStatusError('x')).toBeInstanceOf(GoodVibesSdkError);
    });

    test('is instanceof HttpStatusError', () => {
      expect(new HttpStatusError('x')).toBeInstanceOf(HttpStatusError);
    });

    test('401 produces kind auth', () => {
      const err = createHttpStatusError(401, 'http://example.com', 'GET', { error: 'Unauthorized' });
      expect(err.kind).toBe('auth' satisfies SDKErrorKind);
      expect(err).toBeInstanceOf(HttpStatusError);
    });

    test('402 produces kind auth', () => {
      const err = createHttpStatusError(402, 'http://example.com', 'GET', { error: 'Payment Required' });
      expect(err.kind).toBe('auth' satisfies SDKErrorKind);
    });

    test('403 produces kind auth', () => {
      const err = createHttpStatusError(403, 'http://example.com', 'GET', { error: 'Forbidden' });
      expect(err.kind).toBe('auth' satisfies SDKErrorKind);
    });

    test('404 produces kind not-found', () => {
      const err = createHttpStatusError(404, 'http://example.com', 'GET', { error: 'Not Found' });
      expect(err.kind).toBe('not-found' satisfies SDKErrorKind);
    });

    test('408 produces kind network (timeout)', () => {
      const err = createHttpStatusError(408, 'http://example.com', 'GET', { error: 'Timeout' });
      expect(err.kind).toBe('network' satisfies SDKErrorKind);
    });

    test('429 produces kind rate-limit', () => {
      const err = createHttpStatusError(429, 'http://example.com', 'GET', { error: 'Rate Limited' });
      expect(err.kind).toBe('rate-limit' satisfies SDKErrorKind);
    });

    test('500 produces kind server', () => {
      const err = createHttpStatusError(500, 'http://example.com', 'GET', { error: 'Internal Server Error' });
      expect(err.kind).toBe('server' satisfies SDKErrorKind);
    });

    test('503 produces kind server', () => {
      const err = createHttpStatusError(503, 'http://example.com', 'GET', { error: 'Service Unavailable' });
      expect(err.kind).toBe('server' satisfies SDKErrorKind);
    });

    test('category in body overrides status inference', () => {
      const err = createHttpStatusError(500, 'http://example.com', 'GET', {
        error: 'rate limited on server',
        category: 'rate_limit',
      });
      // category from body takes precedence
      expect(err.kind).toBe('rate-limit' satisfies SDKErrorKind);
      expect(err.category).toBe('rate_limit');
    });

    test('network error with category network produces kind network', () => {
      const err = new HttpStatusError('fetch failed', {
        category: 'network',
        source: 'transport',
        recoverable: true,
      });
      expect(err.kind).toBe('network' satisfies SDKErrorKind);
    });
  });

  describe('kind as tagged union discriminant', () => {
    test('switch on kind covers all values without runtime errors', () => {
      const errors = [
        new ConfigurationError('c'),
        new ContractError('c'),
        createHttpStatusError(401, 'http://x.com', 'GET', { error: 'x' }),
        createHttpStatusError(404, 'http://x.com', 'GET', { error: 'x' }),
        createHttpStatusError(429, 'http://x.com', 'GET', { error: 'x' }),
        createHttpStatusError(500, 'http://x.com', 'GET', { error: 'x' }),
        new HttpStatusError('x', { category: 'network' }),
        new HttpStatusError('x', { category: 'bad_request' }),
        new GoodVibesSdkError('x'),
      ];

      const kinds: SDKErrorKind[] = [];
      for (const err of errors) {
        switch (err.kind) {
          case 'auth': kinds.push('auth'); break;
          case 'config': kinds.push('config'); break;
          case 'contract': kinds.push('contract'); break;
          case 'network': kinds.push('network'); break;
          case 'not-found': kinds.push('not-found'); break;
          case 'rate-limit': kinds.push('rate-limit'); break;
          case 'server': kinds.push('server'); break;
          case 'validation': kinds.push('validation'); break;
          case 'unknown': kinds.push('unknown'); break;
        }
      }

      expect(kinds).toEqual([
        'config',
        'contract',
        'auth',
        'not-found',
        'rate-limit',
        'server',
        'network',
        'validation',
        'unknown',
      ]);
    });
  });
});

describe('error-kind: sdk mirror (packages/sdk/src/_internal/errors)', () => {
  test('GoodVibesSdkError from SDK mirror has kind field', async () => {
    const { GoodVibesSdkError: SdkMirrorBase } = await import('../packages/sdk/src/_internal/errors/index.js');
    const err = new SdkMirrorBase('test', { category: 'rate_limit' });
    expect(err.kind).toBe('rate-limit');
  });

  test('ConfigurationError from SDK mirror has kind config', async () => {
    const { ConfigurationError: SdkConfigError } = await import('../packages/sdk/src/_internal/errors/index.js');
    const err = new SdkConfigError('bad config');
    expect(err.kind).toBe('config');
  });

  test('ContractError from SDK mirror has kind contract', async () => {
    const { ContractError: SdkContractError } = await import('../packages/sdk/src/_internal/errors/index.js');
    const err = new SdkContractError('bad contract');
    expect(err.kind).toBe('contract');
  });

  test('HttpStatusError from SDK mirror instanceof works', async () => {
    const { HttpStatusError: SdkHttpError, GoodVibesSdkError: SdkBase } = await import('../packages/sdk/src/_internal/errors/index.js');
    const err = new SdkHttpError('test', { category: 'service' });
    expect(err).toBeInstanceOf(SdkBase);
    expect(err).toBeInstanceOf(SdkHttpError);
    expect(err.kind).toBe('server');
  });
});
