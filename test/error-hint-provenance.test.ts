/**
 * Inferred hints stay inside their domain.
 *
 * The `bad_request` and `not_found` fallback hints in the error envelope talk
 * about model ids, message format and tool schemas, an LLM request and nothing
 * else. They used to attach to every 400/404 that reached
 * `buildErrorResponseBody`, so a calendar verb refusing a malformed range told
 * the caller to check its model id. These tests pin the boundary: the two
 * model-shaped hints are only inferred for provider-attributed errors, every
 * other error keeps its own message, and explicitly supplied hints always pass
 * through.
 */

import { describe, expect, test } from 'bun:test';

import { buildErrorResponseBody } from '../packages/daemon-sdk/src/error-response.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';

describe('error envelope hint provenance', () => {
  test('a gateway verb refusal with a 400 gets no borrowed LLM hint', () => {
    // The exact shape control-plane refusalBody() feeds in for a calendar 400.
    const body = buildErrorResponseBody({
      message: 'Google returned 400: Invalid timeMin value. Check the request parameters.',
      code: 'CALENDAR_REQUEST_FAILED',
      status: 400,
    });
    expect(body.category).toBe('bad_request');
    expect(body.hint).toBeUndefined();
  });

  test('a non-provider 404 gets no model-id hint', () => {
    const body = buildErrorResponseBody({
      message: 'Unknown knowledge refinement task',
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(body.category).toBe('not_found');
    expect(body.hint).toBeUndefined();
  });

  test('a provider-sourced 400 keeps the request-shape hint', () => {
    const body = buildErrorResponseBody({
      message: 'invalid request: unsupported parameter',
      code: 'PROVIDER_ERROR',
      status: 400,
      source: 'provider',
    });
    expect(body.category).toBe('bad_request');
    expect(body.hint).toMatch(/model id/i);
  });

  test('a 404 carrying a provider name keeps the model-id hint', () => {
    const body = buildErrorResponseBody({
      message: 'unknown model gpt-x',
      code: 'PROVIDER_ERROR',
      status: 404,
      provider: 'openai',
    });
    expect(body.category).toBe('not_found');
    expect(body.hint).toMatch(/model id/i);
  });

  test('an explicit hint passes through untouched on a non-provider error', () => {
    const body = buildErrorResponseBody({
      message: 'calendar range refused',
      code: 'CALENDAR_REQUEST_FAILED',
      status: 400,
      hint: 'Narrow the requested date range.',
    });
    expect(body.hint).toBe('Narrow the requested date range.');
  });

  test('non-model hints are unaffected: a transport network error still gets its hint', () => {
    const err = new GoodVibesSdkError('connection refused', {
      category: 'network',
      source: 'transport',
    });
    const body = buildErrorResponseBody(err);
    expect(body.category).toBe('network');
    expect(body.hint).toMatch(/connectivity|DNS|TLS/i);
  });
});
