/**
 * memory-wire-verb-availability.test.ts
 *
 * The memory-spine wire discriminator: given a caught wire error, decide whether a
 * 404 means "no such record" (fold to null) or "this daemon does not serve this
 * verb" (reject honestly). Exercises the ACTUAL error shapes the three transports
 * throw — an SDK HttpStatusError (TUI transport, via createTransportError) and an
 * agent-style plain Error with an attached status/code — not a contrived stand-in.
 */

import { describe, expect, test } from 'bun:test';
import { createTransportError } from '../packages/transport-http/src/http-core.ts';
import {
  classifyMemoryWireError,
  foldMemoryWireExtendedError,
  memoryVerbUnavailableError,
} from '../packages/sdk/src/platform/runtime/memory-spine/index.ts';

const URL_UPDATE = 'http://daemon.test/api/memory/records/mem_x/update';

/** The record-missing 404 body a current daemon returns from a memory route. */
const recordMissingBody = { error: 'Unknown memory record', code: 'MEMORY_RECORD_NOT_FOUND', category: 'not_found', status: 404 };
/** The route-not-found 404 body the daemon's terminal fallthrough returns (older daemon shape). */
const routeNotFoundBody = { error: 'Route not found: /api/memory/records/mem_x/update', code: 'NOT_FOUND', category: 'not_found', status: 404 };
/** A pre-error-unification daemon: a bare 404 with no structured code at all. */
const legacyBareBody = 'Not found';

/** Mirrors how the agent's wireFetch stamps the caught response onto its thrown error. */
function agentStyleError(status: number, code: string | undefined, path = '/api/memory/records/mem_x/update'): Error {
  const err = new Error(`memory spine: HTTP ${status} on ${path}`) as Error & { status: number; code?: string };
  err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

describe('classifyMemoryWireError — the runtime signal, not the transport shape', () => {
  test('HttpStatusError from a record-missing 404 → record-missing', () => {
    const err = createTransportError(404, URL_UPDATE, 'POST', recordMissingBody);
    expect(classifyMemoryWireError(err)).toBe('record-missing');
  });

  test('HttpStatusError from a route-not-found 404 (older daemon) → method-unavailable', () => {
    const err = createTransportError(404, URL_UPDATE, 'POST', routeNotFoundBody);
    expect(classifyMemoryWireError(err)).toBe('method-unavailable');
  });

  test('a bare legacy 404 with NO code → method-unavailable (never silently record-missing)', () => {
    const err = createTransportError(404, URL_UPDATE, 'POST', legacyBareBody);
    expect(classifyMemoryWireError(err)).toBe('method-unavailable');
  });

  test('agent-style error carrying the record-missing code → record-missing', () => {
    expect(classifyMemoryWireError(agentStyleError(404, 'MEMORY_RECORD_NOT_FOUND'))).toBe('record-missing');
  });

  test('agent-style error with only "HTTP 404" in the message, no code → method-unavailable', () => {
    expect(classifyMemoryWireError(agentStyleError(404, undefined))).toBe('method-unavailable');
  });

  test('a non-404 error (500, network) → other, so the caller propagates it unchanged', () => {
    expect(classifyMemoryWireError(createTransportError(500, URL_UPDATE, 'POST', { error: 'boom' }))).toBe('other');
    expect(classifyMemoryWireError(new Error('fetch failed'))).toBe('other');
    expect(classifyMemoryWireError(agentStyleError(503, undefined))).toBe('other');
  });
});

describe('foldMemoryWireExtendedError — the transport catch-block fold', () => {
  test('method-unavailable throws the canonical unavailable-verb error', () => {
    const err = createTransportError(404, URL_UPDATE, 'POST', routeNotFoundBody);
    expect(() => foldMemoryWireExtendedError('update', err)).toThrow(/does not support the 'update' memory verb/);
  });

  test('record-missing does NOT throw — the caller resolves it (e.g. to null)', () => {
    const err = createTransportError(404, URL_UPDATE, 'POST', recordMissingBody);
    expect(() => foldMemoryWireExtendedError('update', err)).not.toThrow();
  });

  test('any other error is rethrown unchanged', () => {
    const original = createTransportError(500, URL_UPDATE, 'POST', { error: 'boom' });
    expect(() => foldMemoryWireExtendedError('update', original)).toThrow(original);
  });
});

describe('memoryVerbUnavailableError — one canonical message for every consumer', () => {
  test('names the verb and states the single-writer reason', () => {
    const err = memoryVerbUnavailableError('list');
    expect(err.message).toMatch(/'list' memory verb over the wire/);
    expect(err.message).toMatch(/single-writer invariant/);
  });
});
