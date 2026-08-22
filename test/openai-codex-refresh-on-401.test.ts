import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAICodexProvider } from '../packages/sdk/src/platform/providers/openai-codex.js';
import type { ProviderSubscription, SubscriptionManager } from '../packages/sdk/src/platform/config/subscriptions.js';

/**
 * A revoked-but-unexpired subscription token: the backend answers 401 while
 * the local expiry timestamp still calls the token live, so the
 * timestamp-gated refresh in resolveSubscriptionAccessToken never fires.
 * The provider must spend the stored refresh token on ONE recovery attempt,
 * retry the request once on success, and on refresh failure surface an error
 * that names the subscription session — never the words "API key".
 */

function fakeJwt(header: string): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const TOKEN_A = fakeJwt('hdrA');
const TOKEN_B = fakeJwt('hdrB');

function makeManager(record: ProviderSubscription): {
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>;
  saved: ProviderSubscription[];
} {
  let current = record;
  const saved: ProviderSubscription[] = [];
  return {
    saved,
    manager: {
      get: (provider: string) => (provider === 'openai' ? current : null),
      saveSubscription: (next: ProviderSubscription) => {
        current = next;
        saved.push(next);
        return next;
      },
      resolveAccessToken: async () => current.accessToken,
    } as Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>,
  };
}

function liveRecord(): ProviderSubscription {
  return {
    provider: 'openai',
    accessToken: TOKEN_A,
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3_600_000,
    authMode: 'oauth',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
  } as ProviderSubscription;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FetchLogEntry { url: string; bearer: string | null }

function stubFetch(handlers: {
  responses: (bearer: string | null) => Response;
  tokenExchange: () => Response;
}): FetchLogEntry[] {
  const log: FetchLogEntry[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    log.push({ url, bearer });
    if (url.includes('/codex/responses')) return handlers.responses(bearer);
    if (url.includes('auth.openai.com/oauth/token')) return handlers.tokenExchange();
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return log;
}

function revoked401(): Response {
  return new Response('token_revoked: Encountered invalidated oauth token for user', { status: 401 });
}

function sseSuccess(): Response {
  const body = [
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const CHAT_PARAMS = {
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 16,
};

describe('OpenAICodexProvider refresh-on-401', () => {
  test('a dead session surfaces as a subscription-session error, never an API-key one', async () => {
    const { manager, saved } = makeManager(liveRecord());
    const log = stubFetch({
      responses: () => revoked401(),
      tokenExchange: () => new Response('{"error":{"message":"Your session has ended."}}', { status: 401 }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const failure = await provider.chat(CHAT_PARAMS as never).then(
      () => null,
      (err: Error) => err,
    );

    expect(failure).not.toBeNull();
    expect(String(failure!.message)).toMatch(/subscription session has ended/i);
    expect(String(failure!.message)).not.toMatch(/api key/i);
    // One send with the dead token, one refresh attempt, no blind resend.
    expect(log.filter((e) => e.url.includes('/codex/responses'))).toHaveLength(1);
    expect(log.filter((e) => e.url.includes('oauth/token'))).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  test('a revoked access token with a live refresh token recovers in one retry', async () => {
    const { manager, saved } = makeManager(liveRecord());
    const log = stubFetch({
      responses: (bearer) => (bearer === TOKEN_B ? sseSuccess() : revoked401()),
      tokenExchange: () => new Response(JSON.stringify({
        access_token: TOKEN_B,
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const response = await provider.chat(CHAT_PARAMS as never);

    expect(response.content).toContain('ok');
    const sends = log.filter((e) => e.url.includes('/codex/responses'));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.bearer).toBe(TOKEN_A);
    expect(sends[1]!.bearer).toBe(TOKEN_B);
    // The refreshed session is persisted so the NEXT turn starts healthy.
    expect(saved).toHaveLength(1);
    expect(saved[0]!.accessToken).toBe(TOKEN_B);
    expect(saved[0]!.refreshToken).toBe('refresh-2');
  });

  test('a second 401 after a successful refresh names the subscription and does not loop', async () => {
    const { manager } = makeManager(liveRecord());
    const log = stubFetch({
      responses: () => revoked401(),
      tokenExchange: () => new Response(JSON.stringify({
        access_token: TOKEN_B,
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const failure = await provider.chat(CHAT_PARAMS as never).then(
      () => null,
      (err: Error) => err,
    );

    expect(failure).not.toBeNull();
    // The entitlement is gone (plan lapsed, suspension): still a subscription
    // problem, never an API-key one.
    expect(String(failure!.message)).toMatch(/subscription session has ended/i);
    expect(String(failure!.message)).not.toMatch(/api key/i);
    // Exactly two sends and one refresh: the retry is once, not a loop.
    expect(log.filter((e) => e.url.includes('/codex/responses'))).toHaveLength(2);
    expect(log.filter((e) => e.url.includes('oauth/token'))).toHaveLength(1);
  });

  test('an unreachable token endpoint surfaces the original rejection, not a sign-in demand', async () => {
    const { manager, saved } = makeManager(liveRecord());
    stubFetch({
      responses: () => revoked401(),
      tokenExchange: () => new Response('bad gateway', { status: 502 }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const failure = await provider.chat(CHAT_PARAMS as never).then(
      () => null,
      (err: Error) => err,
    );

    // The session's true state is unknown; telling the user to sign in again
    // over a transient token-endpoint outage would be a lie.
    expect(failure).not.toBeNull();
    expect(String(failure!.message)).not.toMatch(/subscription session has ended/i);
    expect(String(failure!.message)).toMatch(/401/);
    expect(saved).toHaveLength(0);
  });

  test('concurrent 401s share one refresh instead of stampeding the rotating token', async () => {
    const { manager, saved } = makeManager(liveRecord());
    const log = stubFetch({
      responses: (bearer) => (bearer === TOKEN_B ? sseSuccess() : revoked401()),
      tokenExchange: () => new Response(JSON.stringify({
        access_token: TOKEN_B,
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const [first, second, third] = await Promise.all([
      provider.chat(CHAT_PARAMS as never),
      provider.chat(CHAT_PARAMS as never),
      provider.chat(CHAT_PARAMS as never),
    ]);

    expect(first.content).toContain('ok');
    expect(second.content).toContain('ok');
    expect(third.content).toContain('ok');
    // One refresh serves all three callers; refresh-1 is spent exactly once.
    expect(log.filter((e) => e.url.includes('oauth/token'))).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  test('a store another caller already advanced is used without spending anything', async () => {
    const { manager, saved } = makeManager(liveRecord());
    const log = stubFetch({
      responses: (bearer) => (bearer === TOKEN_B ? sseSuccess() : revoked401()),
      tokenExchange: () => { throw new Error('the refresh token must not be spent in this scenario'); },
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const pending = provider.chat(CHAT_PARAMS as never);
    // Simulate a concurrent process refreshing between this call's rejection
    // and its recovery: by the time the recovery re-reads the store, the
    // record already holds a different, working token.
    (manager as unknown as { get: () => unknown }).get = () => ({ ...liveRecord(), accessToken: TOKEN_B, refreshToken: 'refresh-2' });

    const response = await pending;
    expect(response.content).toContain('ok');
    expect(log.filter((e) => e.url.includes('oauth/token'))).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  test('a failed persist does not throw away a successful refresh', async () => {
    const base = makeManager(liveRecord());
    const manager = {
      ...base.manager,
      saveSubscription: () => { throw new Error('ENOSPC: no space left on device'); },
    } as unknown;
    const log = stubFetch({
      responses: (bearer) => (bearer === TOKEN_B ? sseSuccess() : revoked401()),
      tokenExchange: () => new Response(JSON.stringify({
        access_token: TOKEN_B,
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const provider = new OpenAICodexProvider(manager as SubscriptionManager);
    const response = await provider.chat(CHAT_PARAMS as never);

    // The refresh succeeded over the wire and refresh-1 is already rotated
    // away server-side; a full disk must not cost the user the session.
    expect(response.content).toContain('ok');
    expect(log.filter((e) => e.url.includes('/codex/responses'))).toHaveLength(2);
  });
});
