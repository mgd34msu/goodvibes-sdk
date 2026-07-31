/**
 * session-spine-rest-transport.test.ts
 *
 * Unit tests for the hoisted version-tolerant REST `SpineTransport`
 * (postSessionSpineRegister/Close, createSessionSpineRestTransport, the
 * reachability probe, and the receipt consumer), plus a fold-through-the-real-
 * client proof (register/close result-kind -> SessionSpineClient's queue vs.
 * reject behavior) exercising the SAME divergence ruling the agent's own
 * pre-hoist test suite pinned: a durable refusal (auth/route-unavailable)
 * must fold to 'rejected' (no retry-forever), while a transient network
 * failure must fold to 'offline' (queued for replay).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createSessionSpineReceiptConsumer,
  createSessionSpineRestProbe,
  createSessionSpineRestTransport,
  postSessionSpineClose,
  postSessionSpineRegister,
  type SessionSpineRestConnection,
} from '../packages/sdk/src/platform/runtime/session-spine/rest-transport.ts';
import { AGENT_SPINE_PARTICIPANT, SessionSpineClient } from '../packages/sdk/src/platform/runtime/session-spine/client.ts';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const CONNECTION: SessionSpineRestConnection = {
  baseUrl: 'http://127.0.0.1:3421',
  token: 'spine-token',
  tokenPath: '/tmp/operator-tokens.json',
};

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
    requests.push({ url, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: parsed });
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

describe('postSessionSpineRegister', () => {
  test('POSTs to /api/sessions/register with a Bearer token and returns the parsed session/reopened', async () => {
    installFetch(() => new Response(JSON.stringify({ session: { id: 'user-1', kind: 'agent', status: 'active' }, reopened: false }), { status: 200 }));

    const result = await postSessionSpineRegister(CONNECTION, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${CONNECTION.baseUrl}/api/sessions/register`);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${CONNECTION.token}`);
    expect(result.ok && result.reopened).toBe(false);
    expect(result.ok && result.session?.id).toBe('user-1');
  });

  test('no token -> auth_required without a network call', async () => {
    installFetch(() => new Response('{}', { status: 200 }));
    const result = await postSessionSpineRegister({ ...CONNECTION, token: null }, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('auth_required');
    expect(requests).toHaveLength(0);
  });

  test('401 -> auth_required', async () => {
    installFetch(() => new Response(JSON.stringify({ error: 'no token' }), { status: 401 }));
    const result = await postSessionSpineRegister(CONNECTION, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('auth_required');
  });

  test('404 -> connected_host_route_unavailable (a pre-spine daemon)', async () => {
    installFetch(() => new Response('not found', { status: 404 }));
    const result = await postSessionSpineRegister(CONNECTION, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('connected_host_route_unavailable');
  });

  test('network failure -> connected_host_unavailable', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const result = await postSessionSpineRegister(CONNECTION, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('connected_host_unavailable');
  });

  test('reopen conflict (still-closed heartbeat) is surfaced honestly', async () => {
    installFetch(() => new Response(JSON.stringify({ session: { id: 'user-1', kind: 'agent', status: 'closed' }, reopened: false, conflict: { status: 'closed' } }), { status: 200 }));
    const result = await postSessionSpineRegister(CONNECTION, {
      sessionId: 'user-1',
      participant: { surfaceKind: 'agent', surfaceId: 'service', lastSeenAt: 1 },
    });
    expect(result.ok && result.conflict?.status).toBe('closed');
  });
});

describe('postSessionSpineClose', () => {
  test('POSTs to /api/sessions/{id}/close', async () => {
    installFetch(() => new Response(JSON.stringify({ session: { id: 'user-1', kind: 'agent', status: 'closed' } }), { status: 200 }));
    const result = await postSessionSpineClose(CONNECTION, 'user-1');
    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe(`${CONNECTION.baseUrl}/api/sessions/user-1/close`);
  });

  test('URL-encodes the session id', async () => {
    installFetch(() => new Response('{}', { status: 200 }));
    await postSessionSpineClose(CONNECTION, 'a session/with slash');
    expect(requests[0]?.url).toContain(encodeURIComponent('a session/with slash'));
  });
});

describe('createSessionSpineRestTransport', () => {
  test('register/close fold ok/offline correctly', async () => {
    installFetch(() => new Response(JSON.stringify({ session: { id: 'x', kind: 'agent', status: 'active' }, reopened: false }), { status: 200 }));
    const transport = createSessionSpineRestTransport({ resolveConnection: () => CONNECTION });
    expect(await transport.register({ sessionId: 'x', participant: { surfaceKind: 'agent', surfaceId: 's', lastSeenAt: 1 } })).toEqual({ outcome: 'ok' });
    expect(await transport.close('x')).toEqual({ outcome: 'ok' });
  });

  test('a durable rejection (401/404) folds to rejected, not offline', async () => {
    installFetch(() => new Response('nope', { status: 401 }));
    const transport = createSessionSpineRestTransport({ resolveConnection: () => CONNECTION });
    const result = await transport.register({ sessionId: 'x', participant: { surfaceKind: 'agent', surfaceId: 's', lastSeenAt: 1 } });
    expect(result.outcome).toBe('rejected');
  });

  test('a network failure folds to offline, not rejected', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const transport = createSessionSpineRestTransport({ resolveConnection: () => CONNECTION });
    const result = await transport.register({ sessionId: 'x', participant: { surfaceKind: 'agent', surfaceId: 's', lastSeenAt: 1 } });
    expect(result.outcome).toBe('offline');
  });
});

describe('SessionSpineClient result-kind fold through the real hoisted transport', () => {
  test('a network failure folds to offline: queued for replay', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const client = new SessionSpineClient({
      participant: AGENT_SPINE_PARTICIPANT,
      transport: createSessionSpineRestTransport({ resolveConnection: () => CONNECTION }),
      log: { debug: () => {}, info: () => {} },
    });
    client.register({ sessionId: 'fold-1', project: '/p' });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBe(1);
    client.dispose();
  });

  test('an auth_required (401) response folds to rejected: no queue, no retry-forever', async () => {
    installFetch(() => new Response(JSON.stringify({ error: 'no token' }), { status: 401 }));
    const client = new SessionSpineClient({
      participant: AGENT_SPINE_PARTICIPANT,
      transport: createSessionSpineRestTransport({ resolveConnection: () => CONNECTION }),
      log: { debug: () => {}, info: () => {} },
    });
    client.register({ sessionId: 'fold-2', project: '/p' });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(client.pendingOps).toBe(0);
    client.dispose();
  });
});

describe('createSessionSpineRestProbe', () => {
  test('flips offline -> online against a live-vs-dead mock host, and captures the daemon client-floor header', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    let capturedFloor: string | undefined;
    const probe = createSessionSpineRestProbe({ resolveConnection: () => CONNECTION, onDaemonFloor: (floor) => { capturedFloor = floor; } });
    expect(await probe()).toBe(false);

    installFetch(() => new Response('{}', { status: 200, headers: { 'X-Goodvibes-Client-Floor': '2.0.0' } }));
    expect(await probe()).toBe(true);
    expect(capturedFloor).toBe('2.0.0');
  });

  test('a 401 still counts as reachable (auth is a register/close concern, not a probe concern)', async () => {
    installFetch(() => new Response('{}', { status: 401 }));
    const probe = createSessionSpineRestProbe({ resolveConnection: () => CONNECTION });
    expect(await probe()).toBe(true);
  });
});

describe('createSessionSpineReceiptConsumer', () => {
  test('parses the receipts array from a ?receipts=consume read', async () => {
    installFetch((url) => {
      expect(url).toContain('receipts=consume');
      return new Response(JSON.stringify({ receipts: [{ id: 'r1', text: 'updated from 1.0 to 2.0', at: 123 }] }), { status: 200 });
    });
    const consume = createSessionSpineReceiptConsumer({ resolveConnection: () => CONNECTION });
    const receipts = await consume();
    expect(receipts).toEqual([{ id: 'r1', text: 'updated from 1.0 to 2.0', at: 123 }]);
  });

  test('returns [] on a non-2xx or malformed body rather than throwing', async () => {
    installFetch(() => new Response('not json', { status: 200 }));
    const consume = createSessionSpineReceiptConsumer({ resolveConnection: () => CONNECTION });
    expect(await consume()).toEqual([]);
  });

  test('returns [] on a network failure', async () => {
    installFetch(() => { throw new Error('ECONNREFUSED'); });
    const consume = createSessionSpineReceiptConsumer({ resolveConnection: () => CONNECTION });
    expect(await consume()).toEqual([]);
  });
});
