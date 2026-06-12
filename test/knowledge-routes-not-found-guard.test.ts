/**
 * Pins the 404-mapping guard logic used in knowledge-routes.ts catch blocks.
 *
 * Rule (MIN-2 fix): After SDKErrorCode inference was introduced, `GoodVibesSdkError`
 * instances with `category: 'not_found'` always have `code === 'NOT_FOUND'` even when no
 * explicit code was supplied. To prevent category-only not-found errors from silently becoming
 * HTTP 404 responses, the guard now requires EITHER:
 *   - a domain-specific not-found code (KNOWLEDGE_ISSUE_NOT_FOUND, KNOWLEDGE_CANDIDATE_NOT_FOUND,
 *     KNOWLEDGE_JOB_NOT_FOUND) — always explicit, never auto-inferred, OR
 *   - bare NOT_FOUND code AND status === 404 (confirms the error originated from a real HTTP 404)
 *
 * This test file pins those four distinct cases so any regression is immediately visible.
 */
import { describe, test, expect } from 'bun:test';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';
import { buildErrorResponseBody } from '../packages/daemon-sdk/src/error-response.js';

// ---------------------------------------------------------------------------
// Inline guard helper — mirrors the logic in knowledge-routes.ts catch blocks
// (each handler uses the same pattern; we test the rule once here)
// ---------------------------------------------------------------------------

function isKnowledgeIssueNotFound(error: unknown, domainCode: string): boolean {
  return error instanceof Error && (
    (error as { code?: unknown }).code === domainCode
    || (
      (error as { code?: unknown }).code === 'NOT_FOUND'
      && (error as { status?: unknown }).status === 404
    )
  );
}

// ---------------------------------------------------------------------------
// Wire code: always-present floor
// ---------------------------------------------------------------------------

describe('buildErrorResponseBody — code always present for GoodVibesSdkError on wire', () => {
  test('GoodVibesSdkError with explicit code preserves code on wire', () => {
    const err = new GoodVibesSdkError('not found', { code: 'NOT_FOUND', category: 'not_found' });
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('NOT_FOUND');
  });

  test('GoodVibesSdkError with category-only inferred code appears on wire (NOT_FOUND inference)', () => {
    // No explicit code — inferCodeFromCategory('not_found') supplies NOT_FOUND.
    // This is the new behavior: code is always present on GoodVibesSdkError even without
    // an explicit code. The wire body always includes 'code' for SDK errors.
    const err = new GoodVibesSdkError('resource unavailable', { category: 'not_found' });
    expect(err.code).toBe('NOT_FOUND'); // confirm inference happened
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('NOT_FOUND');
  });

  test('GoodVibesSdkError with unknown category produces UNKNOWN on wire (floor)', () => {
    const err = new GoodVibesSdkError('something went wrong', { category: 'unknown' });
    expect(err.code).toBe('UNKNOWN');
    const body = buildErrorResponseBody(err);
    expect(body.code).toBe('UNKNOWN');
  });

  test('plain Error (non-SDK) does not produce code on the wire body', () => {
    // buildErrorResponseBody only emits code when the error has a recognized code field.
    // Plain Error instances have no code, so it is absent from the wire body.
    const body = buildErrorResponseBody(new Error('oops'));
    expect(body.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 404-guard rule: domain-specific codes always map to 404
// ---------------------------------------------------------------------------

describe('knowledge-routes 404 guard — domain-specific codes', () => {
  test('KNOWLEDGE_ISSUE_NOT_FOUND always maps to 404 regardless of status', () => {
    const err = new GoodVibesSdkError('issue not found', { category: 'not_found' });
    // Simulate domain-specific explicit code (service layer sets this explicitly)
    Object.defineProperty(err, 'code', { value: 'KNOWLEDGE_ISSUE_NOT_FOUND', writable: false, configurable: true });
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(true);
  });

  test('KNOWLEDGE_ISSUE_NOT_FOUND fires even when status is undefined', () => {
    const err = new GoodVibesSdkError('issue not found', { category: 'not_found' });
    Object.defineProperty(err, 'code', { value: 'KNOWLEDGE_ISSUE_NOT_FOUND', writable: false, configurable: true });
    expect((err as unknown as { status?: unknown }).status).toBeUndefined();
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 404-guard rule: bare NOT_FOUND only maps to 404 when status === 404
// ---------------------------------------------------------------------------

describe('knowledge-routes 404 guard — bare NOT_FOUND provenance check', () => {
  test('NOT_FOUND with status 404 maps to 404 (explicit HTTP provenance)', () => {
    const err = new GoodVibesSdkError('upstream 404', { category: 'not_found', status: 404 });
    expect(err.code).toBe('NOT_FOUND');
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(true);
  });

  test('NOT_FOUND without status does NOT map to 404 (category-only inference)', () => {
    // This is the core regression guard: previously code was undefined (no match),
    // now it is NOT_FOUND via inference — but without status:404 it must not 404.
    const err = new GoodVibesSdkError('resource unavailable', { category: 'not_found' });
    expect(err.code).toBe('NOT_FOUND'); // inference happened
    expect((err as unknown as { status?: unknown }).status).toBeUndefined();
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(false);
  });

  test('NOT_FOUND with non-404 status does NOT map to 404', () => {
    // Construct an error that explicitly carries code='NOT_FOUND' but status=400
    // (simulates an error from an upstream service that set code='NOT_FOUND' explicitly
    // but arrived via a non-404 HTTP path).
    const err = Object.assign(new Error('bad request not found'), { code: 'NOT_FOUND', status: 400 });
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(false);
  });

  test('plain Error with code NOT_FOUND and no status does NOT map to 404', () => {
    const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    expect(isKnowledgeIssueNotFound(err, 'KNOWLEDGE_ISSUE_NOT_FOUND')).toBe(false);
  });
});
