/**
 * Anthropic/OpenAI/Gemini's own refreshModels(): the model list currency
 * requirement — "model lists can never be stale" — proven for the two
 * providers named in the done-when criteria plus Gemini (same empty-array
 * pattern), with a mocked API standing in for the live provider endpoint.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnthropicProvider,
  ANTHROPIC_DATED_STATIC_MODELS,
} from '../packages/sdk/src/platform/providers/anthropic.js';
import { OpenAIProvider, OPENAI_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/openai.js';
import { GeminiProvider, GEMINI_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/gemini.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-provider-live-model-discovery-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('AnthropicProvider.refreshModels', () => {
  test('with no API key configured, falls back to the dated-static list synchronously at construction', () => {
    const provider = new AnthropicProvider('');
    expect(provider.models).toEqual([...ANTHROPIC_DATED_STATIC_MODELS]);
    expect(provider.modelSource).toEqual({ kind: 'live-discovery' });
  });

  test('with no API key, refreshModels() reports the dated-static source honestly', async () => {
    const provider = new AnthropicProvider('');
    const result = await provider.refreshModels();
    expect(result.source).toBe('dated-static');
    expect(provider.models).toEqual([...ANTHROPIC_DATED_STATIC_MODELS]);
  });

  test('with a configured key, a mocked live /v1/models response replaces the model list and reports the diff', async () => {
    await withTempDir(async (dir) => {
      await withMockedFetch(
        (url) => {
          expect(url).toContain('api.anthropic.com/v1/models');
          return new Response(
            JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-brand-new-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
        async () => {
          const provider = new AnthropicProvider('sk-test-key', undefined, join(dir, 'anthropic.json'));
          const result = await provider.refreshModels();
          expect(result.source).toBe('live');
          expect(provider.models).toEqual(['claude-sonnet-5', 'claude-brand-new-model']);
          expect(result.added).toContain('claude-brand-new-model');
        },
      );
    });
  });

  test('a live fetch failure with no cache falls back to the dated-static list and surfaces the honest reason', async () => {
    await withMockedFetch(
      () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }),
      async () => {
        const provider = new AnthropicProvider('sk-test-key');
        const result = await provider.refreshModels();
        expect(result.source).toBe('dated-static');
        expect(result.error).toBeDefined();
        expect(provider.models).toEqual([...ANTHROPIC_DATED_STATIC_MODELS]);
      },
    );
  });
});

describe('OpenAIProvider.refreshModels', () => {
  test('with no API key configured, falls back to the dated-static list synchronously at construction', () => {
    const provider = new OpenAIProvider('');
    expect(provider.models).toEqual([...OPENAI_DATED_STATIC_MODELS]);
  });

  test('a mocked live /v1/models response filters out non-chat models (embeddings, whisper, dall-e)', async () => {
    await withTempDir(async (dir) => {
      await withMockedFetch(
        (url) => {
          expect(url).toContain('api.openai.com/v1/models');
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-5.6' },
                { id: 'gpt-5.7-brand-new' },
                { id: 'text-embedding-3-small' },
                { id: 'whisper-1' },
                { id: 'dall-e-3' },
              ],
            }),
            { status: 200 },
          );
        },
        async () => {
          const provider = new OpenAIProvider('sk-test-key', undefined, join(dir, 'openai.json'));
          const result = await provider.refreshModels();
          expect(result.source).toBe('live');
          expect(provider.models).toEqual(['gpt-5.6', 'gpt-5.7-brand-new']);
          expect(provider.models).not.toContain('text-embedding-3-small');
          expect(provider.models).not.toContain('whisper-1');
          expect(provider.models).not.toContain('dall-e-3');
        },
      );
    });
  });
});

describe('GeminiProvider.refreshModels', () => {
  test('with no API key configured, falls back to the dated-static list synchronously at construction', () => {
    const provider = new GeminiProvider('');
    expect(provider.models).toEqual([...GEMINI_DATED_STATIC_MODELS]);
  });

  test('a mocked ListModels response filters to generateContent-capable models', async () => {
    await withTempDir(async (dir) => {
      await withMockedFetch(
        (url) => {
          expect(url).toContain('generativelanguage.googleapis.com');
          return new Response(
            JSON.stringify({
              models: [
                { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
              ],
            }),
            { status: 200 },
          );
        },
        async () => {
          const provider = new GeminiProvider('test-key', undefined, join(dir, 'gemini.json'));
          const result = await provider.refreshModels();
          expect(result.source).toBe('live');
          expect(provider.models).toEqual(['gemini-3-pro']);
        },
      );
    });
  });
});
