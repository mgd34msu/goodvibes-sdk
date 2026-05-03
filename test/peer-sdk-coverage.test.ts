/**
 * Coverage backfill for packages/peer-sdk/src/client-core.ts and client.ts
 *
 * Targets:
 * - client-core.ts: listOperations, getOperation (including throw for unknown), invoke generic
 * - client.ts: createPeerSdk (covered by existing peer-sdk.test.ts, but adding missing paths)
 */
import { describe, expect, test } from 'bun:test';
import { createPeerSdk } from '../packages/peer-sdk/dist/index.js';
import { createPeerRemoteClient } from '../packages/peer-sdk/src/client-core.js';
import { createHttpTransport } from '../packages/transport-http/dist/index.js';
import { getPeerContract } from '../packages/contracts/dist/index.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTransport(fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createHttpTransport({
    baseUrl: 'http://127.0.0.1:3210',
    fetch,
  });
}

describe('createPeerRemoteClient — listOperations / getOperation', () => {
  test('listOperations returns all endpoints from contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const endpoints = client.listOperations();
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.some((e) => e.id === 'pair.request')).toBe(true);
  });

  test('getOperation returns the matching endpoint contract', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const endpoint = client.getOperation('pair.request');
    expect(endpoint.id).toBe('pair.request');
  });

  test('getOperation throws GoodVibesSdkError for unknown endpoint id', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    expect(() => client.getOperation('does.not.exist')).toThrow(GoodVibesSdkError);
    expect(() => client.getOperation('does.not.exist')).toThrow(/Unknown peer endpoint/);
  });

  test('response validation rejects unsupported peer response shapes', async () => {
    const transport = makeTransport(async () => createJsonResponse({ requestId: 'pair-1' }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    await expect(client.invoke('pair.request', { peerId: 'node-a', label: 'runner' })).rejects.toThrow(/Response validation failed/);
  });

  test('transport and contract are exposed as properties', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    expect(client.transport).toBe(transport);
    expect(client.contract).toBe(contract);
  });
});

describe('createPeerRemoteClient — invoke generic overload', () => {
  test('invoke with a valid endpoint id calls the transport', async () => {
    const calls: string[] = [];
    const transport = makeTransport(async (input, _init) => {
      calls.push(String(input));
      return createJsonResponse({ requestId: 'pair-1' });
    });
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract, { validateResponses: false });
    const result = await client.invoke('pair.request', { peerId: 'node-a', label: 'runner' });
    expect(result).toMatchObject({ requestId: 'pair-1' });
    expect(calls).toHaveLength(1);
  });

  test('invoke throws for unknown endpoint id', () => {
    const transport = makeTransport(async () => createJsonResponse({ ok: true }));
    const contract = getPeerContract();
    const client = createPeerRemoteClient(transport, contract);
    // requireContractRoute throws synchronously when endpoint is not found
    expect(() => client.invoke('unknown.endpoint' as never)).toThrow(GoodVibesSdkError);
  });
});

describe('createPeerRemoteClient — shorthand methods', () => {
  test('pairing.verify calls the verify endpoint', async () => {
    const calls: string[] = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ verified: true });
      },
    });
    const result = await sdk.pairing.verify({ requestId: 'pair-1', code: '123456' });
    expect(calls[0]).toContain('pair');
    expect(result).toBeDefined();
  });

  test('peer.heartbeat calls the heartbeat endpoint', async () => {
    const calls: string[] = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ ok: true });
      },
    });
    const result = await sdk.peer.heartbeat({ peerId: 'node-a' });
    expect(calls[0]).toContain('heartbeat');
    expect(result).toBeDefined();
  });

  test('work.pull calls the pull endpoint', async () => {
    const calls: string[] = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ work: null });
      },
    });
    const result = await sdk.work.pull({ peerId: 'node-a' });
    expect(calls[0]).toContain('work');
    expect(result).toBeDefined();
  });

  test('operator.snapshot calls the operator snapshot endpoint', async () => {
    const calls: string[] = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async (input, _init) => {
        calls.push(String(input));
        return createJsonResponse({ snapshot: {} });
      },
    });
    const result = await sdk.operator.snapshot();
    expect(calls[0]).toContain('remote');
    expect(result).toBeDefined();
  });
});

describe('createPeerSdk — getOperation is accessible', () => {
  test('getOperation returns endpoint contract from PeerSdk', () => {
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: async () => createJsonResponse({ ok: true }),
    });
    const endpoint = sdk.getOperation('pair.request');
    expect(endpoint.id).toBe('pair.request');
  });
});
