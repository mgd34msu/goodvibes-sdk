import { describe, expect, test } from 'bun:test';
import {
  createBrowserTokenStore,
  createGoodVibesSdk,
  createMemoryTokenStore,
} from '../packages/sdk/dist/index.js';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('sdk auth helpers', () => {
  test('persists login tokens into a writable token store', async () => {
    const seenAuth: string[] = [];
    const tokenStore = createMemoryTokenStore();
    const sdk = createGoodVibesSdk({
      baseUrl: 'http://127.0.0.1:3210',
      tokenStore,
      fetch: async (_input, init) => {
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        seenAuth.push(headers.get('authorization') ?? '');
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (body.username === 'alice' && body.password === 'secret') {
          return createJsonResponse({
            authenticated: true,
            token: 'token-login',
            username: 'alice',
            expiresAt: Date.now() + 60_000,
          });
        }
        // Return a minimal valid accounts.snapshot response so Zod validation passes.
        return createJsonResponse({ capturedAt: Date.now(), providers: [], configuredCount: 0, issueCount: 0 });
      },
    });

    const login = await sdk.auth.login({ username: 'alice', password: 'secret' });
    expect(login.token).toBe('token-login');
    expect(await sdk.auth.getToken()).toBe('token-login');

    await sdk.operator.accounts.snapshot();
    expect(seenAuth.at(-1)).toBe('Bearer token-login');
  });

  test('browser token stores round-trip through storage adapters', async () => {
    const storage = new Map<string, string>();
    const store = createBrowserTokenStore({
      key: 'goodvibes.test.token',
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
    });

    await store.setToken('token-123');
    expect(await store.getToken()).toBe('token-123');
    await store.clearToken();
    expect(await store.getToken()).toBeNull();
  });
});
