/**
 * Live model discovery for AmazonBedrockProvider, AnthropicVertexProvider,
 * and GitHubCopilotProvider — the same model-list-currency requirement
 * already proven for Anthropic/OpenAI/Gemini in
 * provider-live-model-discovery.test.ts, extended to the three providers
 * whose static lists previously had no live-refresh path at all.
 *
 * AnthropicVertexProvider's live fetch needs a resolved Google `AuthClient`,
 * which normally comes from ADC/metadata-server discovery — unavailable in
 * this environment (and, more importantly, unsafe to race against: many
 * other test files transitively import `anthropic-vertex.ts` via
 * `registry.ts` -> `builtin-registry.ts`, so a `google-auth-library` module
 * mock registered here would lose the race against whichever file's static
 * import graph happens to load the real module first when tests run
 * combined). Its constructor's second parameter is a first-class injection
 * seam mirroring `AnthropicVertexClientOptions.authClient` (the same
 * override the runtime chat client already accepts) — tests pass a fake
 * `AuthClient` directly, bypassing GoogleAuth discovery entirely, with no
 * module-mock timing dependency. Bedrock's SigV4 signing needs no such seam:
 * `getAuthHeaders` (reused directly from
 * `@anthropic-ai/bedrock-sdk/core/auth.js`) is a pure local computation once
 * static AWS keys are supplied, so it runs unmocked against fake test keys.
 * global `fetch` is swapped per test the same way the existing
 * Anthropic/OpenAI/Gemini live-discovery tests do it; GitHubCopilotProvider
 * instead injects its own `fetchFn` (its existing DI seam) so its token
 * exchange and models call can be scripted per test.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AmazonBedrockProvider, BEDROCK_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/amazon-bedrock.js';
import { AnthropicVertexProvider, VERTEX_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/anthropic-vertex.js';
import { GitHubCopilotProvider, COPILOT_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/github-copilot.js';

const FAKE_VERTEX_AUTH_CLIENT = {
  getRequestHeaders: async () => new Headers({ Authorization: 'Bearer fake-vertex-token' }),
};

async function withEnvVars<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withMockedFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const original = globalThis.fetch;
  // @ts-expect-error — test double, narrower than the full fetch overload set
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-bedrock-vertex-copilot-discovery-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) return null;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

describe('AmazonBedrockProvider.refreshModels', () => {
  test('with no AWS credentials configured, falls back to the dated-static list synchronously at construction', () =>
    withEnvVars(
      { AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_PROFILE: undefined },
      () => {
        const provider = new AmazonBedrockProvider();
        expect(provider.models).toEqual([...BEDROCK_DATED_STATIC_MODELS]);
        expect(provider.modelSource).toEqual({ kind: 'live-discovery' });
      },
    ));

  test('with no credentials, refreshModels() reports the dated-static source honestly', () =>
    withEnvVars(
      { AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_PROFILE: undefined },
      async () => {
        const provider = new AmazonBedrockProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(provider.models).toEqual([...BEDROCK_DATED_STATIC_MODELS]);
      },
    ));

  test('with static AWS keys configured, a mocked ListFoundationModels response replaces the model list, filtering to active Anthropic text/streaming models', () =>
    withEnvVars(
      {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
        AWS_SECRET_ACCESS_KEY: 'fakefakefakefakefakefakefakefakefakefake',
        AWS_PROFILE: undefined,
        AWS_REGION: 'us-east-1',
      },
      () =>
        withTempDir(async (dir) => {
          let seenAuth: string | null = null;
          await withMockedFetch(
            (url, init) => {
              expect(url).toBe('https://bedrock.us-east-1.amazonaws.com/foundation-models');
              seenAuth = headerValue(init, 'authorization');
              return new Response(
                JSON.stringify({
                  modelSummaries: [
                    {
                      modelId: 'anthropic.claude-sonnet-4-6-20260501-v1:0',
                      providerName: 'Anthropic',
                      outputModalities: ['TEXT'],
                      responseStreamingSupported: true,
                      modelLifecycle: { status: 'ACTIVE' },
                    },
                    {
                      modelId: 'anthropic.claude-brand-new-20260601-v1:0',
                      providerName: 'Anthropic',
                      outputModalities: ['TEXT'],
                      responseStreamingSupported: true,
                      modelLifecycle: { status: 'ACTIVE' },
                    },
                    {
                      modelId: 'anthropic.claude-legacy-v1',
                      providerName: 'Anthropic',
                      outputModalities: ['TEXT'],
                      responseStreamingSupported: true,
                      modelLifecycle: { status: 'LEGACY' },
                    },
                    {
                      modelId: 'amazon.titan-text-v1',
                      providerName: 'Amazon',
                      outputModalities: ['TEXT'],
                      responseStreamingSupported: true,
                      modelLifecycle: { status: 'ACTIVE' },
                    },
                    {
                      modelId: 'anthropic.claude-embed-v1',
                      providerName: 'Anthropic',
                      outputModalities: ['EMBEDDING'],
                      responseStreamingSupported: false,
                      modelLifecycle: { status: 'ACTIVE' },
                    },
                  ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            },
            async () => {
              const provider = new AmazonBedrockProvider(join(dir, 'amazon-bedrock.json'));
              const result = await provider.refreshModels();
              expect(result.source).toBe('live');
              expect(provider.models).toEqual([
                'anthropic.claude-sonnet-4-6-20260501-v1:0',
                'anthropic.claude-brand-new-20260601-v1:0',
              ]);
              expect(result.added).toContain('anthropic.claude-brand-new-20260601-v1:0');
              expect(provider.models).not.toContain('anthropic.claude-legacy-v1');
              expect(provider.models).not.toContain('amazon.titan-text-v1');
              expect(provider.models).not.toContain('anthropic.claude-embed-v1');
            },
          );
          expect(seenAuth).toContain('AWS4-HMAC-SHA256');
          expect(seenAuth).toContain('/us-east-1/bedrock/aws4_request');
        }),
    ));

  test('with the bearer token set, the request uses a Bearer Authorization header instead of SigV4', () =>
    withEnvVars(
      { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-abc', AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_PROFILE: undefined },
      () =>
        withTempDir(async (dir) => {
          let seenAuth: string | null = null;
          await withMockedFetch(
            (_url, init) => {
              seenAuth = headerValue(init, 'authorization');
              return new Response(
                JSON.stringify({
                  modelSummaries: [
                    {
                      modelId: 'anthropic.claude-sonnet-4-6-v1:0',
                      providerName: 'Anthropic',
                      outputModalities: ['TEXT'],
                      responseStreamingSupported: true,
                      modelLifecycle: { status: 'ACTIVE' },
                    },
                  ],
                }),
                { status: 200 },
              );
            },
            async () => {
              const provider = new AmazonBedrockProvider(join(dir, 'amazon-bedrock.json'));
              await provider.refreshModels();
            },
          );
          expect(seenAuth).toBe('Bearer bedrock-bearer-abc');
        }),
    ));

  test('a live fetch failure with no cache falls back to the dated-static list and surfaces the honest reason, never throwing', () =>
    withEnvVars(
      {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
        AWS_SECRET_ACCESS_KEY: 'fakefakefakefakefakefakefakefakefakefake',
        AWS_PROFILE: undefined,
      },
      () =>
        withMockedFetch(
          () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }),
          async () => {
            const provider = new AmazonBedrockProvider();
            const result = await provider.refreshModels();
            expect(result.source).toBe('dated-static');
            expect(result.error).toBeDefined();
            expect(provider.models).toEqual([...BEDROCK_DATED_STATIC_MODELS]);
          },
        ),
    ));
});

describe('AnthropicVertexProvider.refreshModels', () => {
  const CLEAR_VERTEX_ENV = {
    ANTHROPIC_VERTEX_PROJECT_ID: undefined,
    GOOGLE_CLOUD_PROJECT: undefined,
    GOOGLE_CLOUD_PROJECT_ID: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    ANTHROPIC_VERTEX_USE_GCP_METADATA: undefined,
  } as const;

  test('with no Vertex credentials configured, falls back to the dated-static list synchronously at construction', () =>
    withEnvVars(CLEAR_VERTEX_ENV, () => {
      const provider = new AnthropicVertexProvider();
      expect(provider.models).toEqual([...VERTEX_DATED_STATIC_MODELS]);
      expect(provider.modelSource).toEqual({ kind: 'live-discovery' });
    }));

  test('with no credentials, refreshModels() reports the dated-static source honestly', () =>
    withEnvVars(CLEAR_VERTEX_ENV, async () => {
      const provider = new AnthropicVertexProvider();
      const result = await provider.refreshModels();
      expect(result.source).toBe('dated-static');
      expect(provider.models).toEqual([...VERTEX_DATED_STATIC_MODELS]);
    }));

  test('with a configured project, a mocked live publisher-models response replaces the model list, deduping versioned aliases', () =>
    withEnvVars(
      {
        ANTHROPIC_VERTEX_PROJECT_ID: 'test-project',
        GOOGLE_APPLICATION_CREDENTIALS: '/fake/path/adc-creds.json',
        GOOGLE_CLOUD_LOCATION: 'us-east5',
      },
      () =>
        withTempDir(async (dir) => {
          await withMockedFetch(
            (url, init) => {
              expect(url).toBe('https://us-east5-aiplatform.googleapis.com/v1/publishers/anthropic/models');
              expect(headerValue(init, 'authorization')).toBe('Bearer fake-vertex-token');
              return new Response(
                JSON.stringify({
                  publisherModels: [
                    { name: 'publishers/anthropic/models/claude-sonnet-4-6' },
                    { name: 'publishers/anthropic/models/claude-sonnet-4-6@20260514' },
                    { name: 'publishers/anthropic/models/claude-brand-new@20260601' },
                  ],
                }),
                { status: 200 },
              );
            },
            async () => {
              const provider = new AnthropicVertexProvider(join(dir, 'anthropic-vertex.json'), FAKE_VERTEX_AUTH_CLIENT);
              const result = await provider.refreshModels();
              expect(result.source).toBe('live');
              expect(provider.models).toEqual(['claude-sonnet-4-6', 'claude-brand-new']);
              expect(result.added).toContain('claude-brand-new');
            },
          );
        }),
    ));

  test('a live fetch failure with no cache falls back to the dated-static list and surfaces the honest reason, never throwing', () =>
    withEnvVars(
      { ANTHROPIC_VERTEX_PROJECT_ID: 'test-project', GOOGLE_APPLICATION_CREDENTIALS: '/fake/path/adc-creds.json' },
      () =>
        withMockedFetch(
          () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }),
          async () => {
            const provider = new AnthropicVertexProvider(undefined, FAKE_VERTEX_AUTH_CLIENT);
            const result = await provider.refreshModels();
            expect(result.source).toBe('dated-static');
            expect(result.error).toBeDefined();
            expect(provider.models).toEqual([...VERTEX_DATED_STATIC_MODELS]);
          },
        ),
    ));
});

function makeCopilotFetchStub(modelsResponse: unknown, modelsStatus = 200) {
  let seenModelsAuth: string | null = null;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/copilot_internal/v2/token')) {
      return new Response(
        JSON.stringify({ token: 'session-token-abc', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200 },
      );
    }
    if (href.endsWith('/models')) {
      seenModelsAuth = headerValue(init, 'authorization');
      return new Response(JSON.stringify(modelsResponse), { status: modelsStatus });
    }
    throw new Error(`unexpected fetch in test stub: ${href}`);
  }) as typeof fetch;
  return { fetchFn, seenModelsAuth: () => seenModelsAuth };
}

describe('GitHubCopilotProvider.refreshModels', () => {
  const CLEAR_COPILOT_ENV = { COPILOT_GITHUB_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined } as const;

  test('with no GitHub token configured, falls back to the dated-static list synchronously at construction', () =>
    withEnvVars(CLEAR_COPILOT_ENV, () =>
      withTempDir((dir) => {
        const provider = new GitHubCopilotProvider({ tokenCachePath: join(dir, 'token.json') });
        expect(provider.models).toEqual([...COPILOT_DATED_STATIC_MODELS]);
        expect(provider.modelSource).toEqual({ kind: 'live-discovery' });
      })));

  test('with no token, refreshModels() reports the dated-static source honestly', () =>
    withEnvVars(CLEAR_COPILOT_ENV, () =>
      withTempDir(async (dir) => {
        const provider = new GitHubCopilotProvider({ tokenCachePath: join(dir, 'token.json') });
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(provider.models).toEqual([...COPILOT_DATED_STATIC_MODELS]);
      })));

  test('with a configured token, a mocked live /models response replaces the model list, filtering out non-chat entries', () =>
    withEnvVars({ COPILOT_GITHUB_TOKEN: 'gh-token-abc', GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, () =>
      withTempDir(async (dir) => {
        const { fetchFn, seenModelsAuth } = makeCopilotFetchStub({
          object: 'list',
          data: [
            { id: 'gpt-5.6', capabilities: { type: 'chat' } },
            { id: 'claude-brand-new', capabilities: { type: 'chat' } },
            { id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } },
          ],
        });
        const provider = new GitHubCopilotProvider({
          tokenCachePath: join(dir, 'token.json'),
          modelsCachePath: join(dir, 'models.json'),
          fetchFn,
        });
        const result = await provider.refreshModels();
        expect(result.source).toBe('live');
        expect(provider.models).toEqual(['gpt-5.6', 'claude-brand-new']);
        expect(provider.models).not.toContain('text-embedding-3-small');
        expect(seenModelsAuth()).toBe('Bearer session-token-abc');
      })));

  test('a live fetch failure with no cache falls back to the dated-static list and surfaces the honest reason, never throwing', () =>
    withEnvVars({ COPILOT_GITHUB_TOKEN: 'gh-token-abc', GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, () =>
      withTempDir(async (dir) => {
        const fetchFn = (async (url: string | URL | Request) => {
          const href = String(url);
          if (href.includes('/copilot_internal/v2/token')) {
            return new Response(
              JSON.stringify({ token: 'session-token-abc', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
              { status: 200 },
            );
          }
          return new Response('server error', { status: 500, statusText: 'Internal Server Error' });
        }) as typeof fetch;
        const provider = new GitHubCopilotProvider({ tokenCachePath: join(dir, 'token.json'), fetchFn });
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(result.error).toBeDefined();
        expect(provider.models).toEqual([...COPILOT_DATED_STATIC_MODELS]);
      })));
});
