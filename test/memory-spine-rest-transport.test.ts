/**
 * memory-spine-rest-transport.test.ts
 *
 * Unit tests for the hoisted full fifteen-verb REST `MemoryTransport`
 * (createMemorySpineRestTransport). Proves: the wire path/body for each verb,
 * the honest-failure contract (a transport failure REJECTS rather than
 * inventing a placeholder success), and the 404 disambiguation (a genuine
 * record-miss folds to null on nullable verbs; any other 404 — an older
 * daemon that never registered the route — rejects on every verb).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MEMORY_RECORD_NOT_FOUND_CODE } from '@pellux/goodvibes-errors';
import { createMemorySpineRestTransport } from '../packages/sdk/src/platform/runtime/memory-spine/rest-transport.ts';
import type { MemoryBundle, MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.ts';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let originalFetch: typeof fetch;
let requests: CapturedRequest[];

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    let parsed: unknown;
    try { parsed = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { parsed = init?.body; }
    requests.push({ url, method: init?.method ?? 'GET', body: parsed });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function record(id: string): MemoryRecord {
  const now = Date.now();
  return {
    id, scope: 'project', cls: 'fact', summary: id,
    tags: [], provenance: [], reviewState: 'fresh', confidence: 60,
    createdAt: now, updatedAt: now,
  };
}

describe('createMemorySpineRestTransport — CORE verbs', () => {
  test('add POSTs to /api/memory/records with a Bearer token', async () => {
    installFetch(() => new Response(JSON.stringify({ record: record('m1') }), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    const result = await transport.add({ scope: 'project', cls: 'fact', summary: 'x', tags: [] } as never);
    expect(result.id).toBe('m1');
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/memory/records');
    expect(requests[0]?.method).toBe('POST');
  });

  test('get: a genuine record-miss (404 + MEMORY_RECORD_NOT_FOUND) folds to null', async () => {
    installFetch(() => new Response(JSON.stringify({ code: MEMORY_RECORD_NOT_FOUND_CODE, error: 'not found' }), { status: 404 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    expect(await transport.get('missing-id')).toBeNull();
  });

  test('get: any OTHER 404 (an older daemon with no such route) rejects rather than returning null', async () => {
    installFetch(() => new Response('not found', { status: 404 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    await expect(transport.get('x')).rejects.toThrow();
  });

  test('delete returns the honest deleted boolean from the response body', async () => {
    installFetch(() => new Response(JSON.stringify({ id: 'm1', deleted: true }), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    expect(await transport.delete('m1')).toBe(true);
    expect(requests[0]?.method).toBe('DELETE');
  });

  test('a transport failure REJECTS rather than inventing a placeholder success (honest-failure contract)', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    await expect(transport.add({ scope: 'project', cls: 'fact', summary: 'x', tags: [] } as never)).rejects.toThrow();
  });
});

describe('createMemorySpineRestTransport — EXTENDED verbs (1.2.0 full-detach catalog)', () => {
  test('list POSTs to /api/memory/records/list', async () => {
    installFetch(() => new Response(JSON.stringify({ records: [record('m1'), record('m2')] }), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    const results = await transport.list?.({});
    expect(results).toHaveLength(2);
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/memory/records/list');
  });

  test('reviewQueue GETs /api/memory/review-queue with limit/scope query params', async () => {
    installFetch(() => new Response(JSON.stringify({ records: [] }), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    await transport.reviewQueue?.(10, 'team');
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/memory/review-queue?limit=10&scope=team');
  });

  test('vectorStats GETs /api/memory/vector (the verb the agent left unwired; part of the TUI superset)', async () => {
    const stats = { backend: 'sqlite-vec', enabled: true, available: true, path: '/x', dimensions: 384, indexedRecords: 5, embeddingProviderId: 'x', embeddingProviderLabel: 'x' };
    installFetch(() => new Response(JSON.stringify({ vector: stats }), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    const result = await transport.vectorStats?.();
    expect(result).toEqual(stats as never);
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/memory/vector');
  });

  test('doctor GETs /api/memory/doctor and returns the body directly (no wrapper key)', async () => {
    const doctor = { vector: {}, embeddings: {}, checkedAt: 123 };
    installFetch(() => new Response(JSON.stringify(doctor), { status: 200 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    const result = await transport.doctor?.();
    expect(result).toEqual(doctor as never);
  });

  test('link: a record-miss 404 folds to null (nullable verb)', async () => {
    installFetch(() => new Response(JSON.stringify({ code: MEMORY_RECORD_NOT_FOUND_CODE, error: 'record not found' }), { status: 404 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    expect(await transport.link?.('from', 'to', 'relates-to')).toBeNull();
  });

  test('linksFor: a record-miss 404 REJECTS (non-nullable verb has no null to fold to)', async () => {
    installFetch(() => new Response(JSON.stringify({ code: MEMORY_RECORD_NOT_FOUND_CODE, error: 'record not found' }), { status: 404 }));
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    await expect(transport.linksFor?.('missing')).rejects.toThrow();
  });

  test('exportBundle / importBundle round-trip through their wrapper keys', async () => {
    const bundle: MemoryBundle = { schemaVersion: 'v1', exportedAt: 0, scope: 'all', recordCount: 0, linkCount: 0, records: [], links: [] };
    installFetch((url) => {
      if (url.endsWith('/export')) return new Response(JSON.stringify({ bundle }), { status: 200 });
      return new Response(JSON.stringify({ result: { importedRecords: 1, skippedRecords: 0, importedLinks: 0 } }), { status: 200 });
    });
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'tok' });
    expect(await transport.exportBundle?.()).toEqual(bundle);
    const imported = await transport.importBundle?.(bundle);
    expect(imported).toEqual({ importedRecords: 1, skippedRecords: 0, importedLinks: 0 });
  });
});

describe('createMemorySpineRestTransport — auth', () => {
  test('carries the Bearer token on every request', async () => {
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(JSON.stringify({ record: record('m1') }), { status: 200 });
    }) as typeof fetch;
    const transport = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:3421', authToken: 'my-token' });
    await transport.get('m1');
    expect(capturedAuth).toBe('Bearer my-token');
  });
});
