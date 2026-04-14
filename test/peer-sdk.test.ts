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

describe('peer sdk', () => {
  test('resolves templated peer contract paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'peer-token',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return createJsonResponse({ ok: true });
      },
    });

    await sdk.work.complete('work-1', {
      status: 'completed',
      result: { ok: true },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('http://127.0.0.1:3210/api/remote/work/work-1/complete');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe(JSON.stringify({
      status: 'completed',
      result: { ok: true },
    }));
  });

  test('supports simple pairing requests', async () => {
    const sdk = createPeerSdk({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () => createJsonResponse({ requestId: 'pair-1' }),
    });

    await expect(sdk.pairing.request({
      peerId: 'node-a',
      label: 'runner-a',
    })).resolves.toEqual({ requestId: 'pair-1' });
  });
});
