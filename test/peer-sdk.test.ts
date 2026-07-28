import { describe, expect, test } from 'bun:test';
import { createPeerSdk } from '../packages/peer-sdk/dist/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Bun's `typeof fetch` includes a `preconnect` static method that plain mock
 * functions don't have. Attach a no-op stub so test doubles satisfy the type
 * without pretending to implement real preconnect behavior.
 */
function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, {
    preconnect: (_url: string | URL, _options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }) => {},
  });
}

describe('peer sdk', () => {
  test('resolves templated peer contract paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'peer-token',
      validateResponses: false,
      fetch: withPreconnect(async (input, init) => {
        calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
        return createJsonResponse({ ok: true });
      }),
    });

    await sdk.work.complete('work-1', {
      status: 'completed',
      result: { ok: true },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected a recorded fetch call');
    expect(call.url).toBe('http://127.0.0.1:3210/api/remote/work/work-1/complete');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe(JSON.stringify({
      status: 'completed',
      result: { ok: true },
    }));
  });

  test('supports simple pairing requests', async () => {
    // Real shape of the `pair.request` contract response: `{ request, challenge }`,
    // not a bare `{ requestId }` — see packages/contracts/src/generated/peer-contract.ts.
    const mockResponse = {
      request: {
        id: 'req-1',
        peerKind: 'node' as const,
        requestedId: 'node-a',
        label: 'runner-a',
        capabilities: [] as string[],
        commands: [] as string[],
        requestedBy: 'remote' as const,
        status: 'pending' as const,
        challengePreview: 'chal-preview',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
        metadata: {} as Record<string, never>,
      },
      challenge: 'test-challenge',
    };
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: withPreconnect(async () => createJsonResponse(mockResponse)),
    });

    await expect(sdk.pairing.request({
      peerKind: 'node',
      requestedId: 'node-a',
      label: 'runner-a',
    })).resolves.toEqual(mockResponse);
  });
});
