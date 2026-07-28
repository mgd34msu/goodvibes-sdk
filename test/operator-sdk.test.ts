import { describe, expect, test } from 'bun:test';
import { createOperatorSdk } from '../packages/operator-sdk/dist/index.js';
import { HttpStatusError } from '../packages/errors/dist/index.js';

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

describe('operator sdk', () => {
  test('resolves path params and query params from contract methods', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'token-123',
      validateResponses: false,
      fetch: withPreconnect(async (input, init) => {
        calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
        return createJsonResponse({ ok: true });
      }),
    });

    await sdk.invoke('sessions.messages.list', {
      sessionId: 'session-1',
      limit: 25,
      before: 'cursor-1',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected a recorded fetch call');
    const headers = call.init?.headers instanceof Headers ? call.init.headers : new Headers(call.init?.headers);
    expect(call.url).toBe('http://127.0.0.1:3210/api/sessions/session-1/messages?limit=25&before=cursor-1');
    expect(call.init?.method).toBe('GET');
    expect(headers.get('authorization')).toBe('Bearer token-123');
  });

  test('serializes post bodies from contract methods', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      validateResponses: false,
      fetch: withPreconnect(async (input, init) => {
        calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
        return createJsonResponse({ taskId: 'task-1' });
      }),
    });

    await sdk.tasks.create({
      task: 'ship it',
      sessionId: 'session-1',
      routing: { providerId: 'main' },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected a recorded fetch call');
    expect(call.url).toBe('http://127.0.0.1:3210/task');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe(JSON.stringify({
      task: 'ship it',
      sessionId: 'session-1',
      routing: { providerId: 'main' },
    }));
  });

  test('raises structured http transport errors', async () => {
    const sdk = createOperatorSdk({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: withPreconnect(async () => createJsonResponse({
        error: 'Authentication failed',
        hint: 'wrong token',
        category: 'authentication',
        source: 'transport',
        recoverable: false,
      }, 401)),
    });

    await expect(sdk.accounts.snapshot()).rejects.toBeInstanceOf(HttpStatusError);
    await expect(sdk.accounts.snapshot()).rejects.toMatchObject({
      message: 'Authentication failed',
      status: 401,
      hint: 'wrong token',
      category: 'authentication',
    });
  });
});
