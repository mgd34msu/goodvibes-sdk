/**
 * Live model discovery for gateway/compat providers: the shared
 * OpenAICompatProvider and AnthropicCompatProvider base classes fetch the
 * backend's own model listing (GET {baseURL}/models), demote the configured
 * static list to a dated baseline, and degrade honestly when the endpoint is
 * dead — the model list is never blanked.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatProvider } from '../packages/sdk/src/platform/providers/openai-compat.js';
import { AnthropicCompatProvider } from '../packages/sdk/src/platform/providers/anthropic-compat.js';
import { BUILTIN_COMPAT_PROVIDERS } from '../packages/sdk/src/platform/providers/builtin-catalog.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-compat-live-model-discovery-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('OpenAICompatProvider.refreshModels (gateway live discovery)', () => {
  const makeProvider = (overrides: Partial<ConstructorParameters<typeof OpenAICompatProvider>[0]> = {}) =>
    new OpenAICompatProvider({
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk-test-key',
      defaultModel: 'qwen/qwen3-32b',
      models: ['qwen/qwen3-32b', 'llama-3.3-70b-versatile'],
      modelsAsOf: '2026-07-12',
      ...overrides,
    });

  test('declares live discovery and keeps the dated baseline at construction', () => {
    const provider = makeProvider();
    expect(provider.modelSource).toEqual({ kind: 'live-discovery' });
    expect(provider.models).toEqual(['qwen/qwen3-32b', 'llama-3.3-70b-versatile']);
  });

  test('a mocked {baseURL}/models response replaces the list and reports a brand-new model', async () => {
    await withMockedFetch(
      (url, init) => {
        expect(url).toBe('https://api.groq.com/openai/v1/models');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer gsk-test-key');
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen/qwen3-32b' }, { id: 'groq/brand-new-model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('live');
        expect(result.added).toContain('groq/brand-new-model');
        expect(provider.models).toEqual(['qwen/qwen3-32b', 'groq/brand-new-model']);
      },
    );
  });

  test('a dead endpoint degrades to the dated baseline with the honest reason — never a blank list', async () => {
    await withMockedFetch(
      () => new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }),
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(result.asOf).toBe('2026-07-12');
        expect(result.error).toContain('502');
        expect(provider.models).toEqual(['qwen/qwen3-32b', 'llama-3.3-70b-versatile']);
        expect(provider.models.length).toBeGreaterThan(0);
      },
    );
  });

  test('a network-level failure also keeps the baseline and surfaces the reason', async () => {
    await withMockedFetch(
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(result.error).toContain('Cannot connect');
        expect(provider.models.length).toBeGreaterThan(0);
      },
    );
  });

  test('modelListing none makes no network call and reports the dated-static source', async () => {
    let fetched = 0;
    await withMockedFetch(
      () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      },
      async () => {
        const provider = makeProvider({ modelListing: 'none' });
        expect(provider.modelSource).toEqual({ kind: 'dated-static', asOf: '2026-07-12' });
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(fetched).toBe(0);
      },
    );
  });

  test('a successful live fetch persists to the on-disk cache and a later failure falls back to it', async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, 'groq.json');
      await withMockedFetch(
        () => new Response(
          JSON.stringify({ data: [{ id: 'live-model-a' }, { id: 'live-model-b' }] }),
          { status: 200 },
        ),
        async () => {
          const provider = makeProvider({ modelsCachePath: cachePath });
          const result = await provider.refreshModels(true);
          expect(result.source).toBe('live');
        },
      );
      await withMockedFetch(
        () => new Response('down', { status: 503, statusText: 'Service Unavailable' }),
        async () => {
          const provider = makeProvider({ modelsCachePath: cachePath });
          const result = await provider.refreshModels(true);
          expect(result.source).toBe('cache');
          expect(result.error).toContain('503');
          expect(provider.models).toEqual(['live-model-a', 'live-model-b']);
        },
      );
    });
  });

  test('non-chat ids from the listing are filtered out', async () => {
    await withMockedFetch(
      () => new Response(
        JSON.stringify({ data: [{ id: 'chat-model' }, { id: 'text-embedding-large' }, { id: 'whisper-large-v3' }] }),
        { status: 200 },
      ),
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.models).toEqual(['chat-model']);
      },
    );
  });
});

describe('AnthropicCompatProvider.refreshModels (gateway live discovery)', () => {
  const makeProvider = (overrides: Partial<ConstructorParameters<typeof AnthropicCompatProvider>[0]> = {}) =>
    new AnthropicCompatProvider({
      name: 'minimax',
      baseURL: 'https://api.minimax.io/anthropic',
      apiKey: 'mm-test-key',
      defaultModel: 'MiniMax-M2.7',
      models: ['MiniMax-M2.7', 'MiniMax-M2.5'],
      modelsAsOf: '2026-07-12',
      ...overrides,
    });

  test('a mocked {baseURL}/models response replaces the list and reports a brand-new model', async () => {
    await withMockedFetch(
      (url, init) => {
        expect(url).toBe('https://api.minimax.io/anthropic/models');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('mm-test-key');
        return new Response(
          JSON.stringify({ data: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3-brand-new' }] }),
          { status: 200 },
        );
      },
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('live');
        expect(result.added).toContain('MiniMax-M3-brand-new');
        expect(provider.models).toContain('MiniMax-M3-brand-new');
      },
    );
  });

  test('bearer auth mode sends Authorization instead of x-api-key', async () => {
    await withMockedFetch(
      (url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer mm-test-key');
        expect(headers['x-api-key']).toBeUndefined();
        return new Response(JSON.stringify({ data: [{ id: 'model-x' }] }), { status: 200 });
      },
      async () => {
        const provider = makeProvider({ authHeaderMode: 'bearer' });
        const result = await provider.refreshModels();
        expect(result.source).toBe('live');
      },
    );
  });

  test('a dead endpoint degrades to the dated baseline with the honest reason', async () => {
    await withMockedFetch(
      () => new Response('gone', { status: 500, statusText: 'Internal Server Error' }),
      async () => {
        const provider = makeProvider();
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(result.asOf).toBe('2026-07-12');
        expect(result.error).toContain('500');
        expect(provider.models).toEqual(['MiniMax-M2.7', 'MiniMax-M2.5']);
      },
    );
  });

  test('modelListing none reports dated-static without a network call', async () => {
    let fetched = 0;
    await withMockedFetch(
      () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      },
      async () => {
        const provider = makeProvider({ modelListing: 'none' });
        expect(provider.modelSource).toEqual({ kind: 'dated-static', asOf: '2026-07-12' });
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(fetched).toBe(0);
      },
    );
  });
});

describe('builtin compat catalog model-source declarations', () => {
  test('every builtin compat definition carries a dated baseline', () => {
    for (const definition of BUILTIN_COMPAT_PROVIDERS) {
      expect(definition.modelsAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(definition.models.length).toBeGreaterThan(0);
    }
  });
});
