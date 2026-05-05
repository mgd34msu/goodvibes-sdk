import { afterEach, describe, expect, test } from 'bun:test';
import { builtinGenerationProviders } from '../packages/sdk/src/platform/media/builtin-generation-providers.ts';
import type { MediaProvider } from '../packages/sdk/src/platform/media/provider-registry.ts';

const originalFetch = globalThis.fetch;
const originalFalKey = process.env.FAL_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFalKey === undefined) {
    delete process.env.FAL_KEY;
  } else {
    process.env.FAL_KEY = originalFalKey;
  }
});

function getFalProvider(): MediaProvider {
  const provider = builtinGenerationProviders().find((entry) => entry.id === 'fal');
  if (!provider?.generate) throw new Error('fal generation provider unavailable');
  return provider;
}

function installFalFetchStub(
  finalFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Array<{ readonly url: string; readonly method: string }> {
  const calls: Array<{ readonly url: string; readonly method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method });
    if (method === 'POST' && url.includes('queue.fal.run')) {
      return Response.json({
        status_url: 'https://queue.fal.run/status/task-1',
        response_url: 'https://queue.fal.run/result/task-1',
      });
    }
    if (url === 'https://queue.fal.run/status/task-1') {
      return Response.json({ status: 'COMPLETED' });
    }
    if (url === 'https://queue.fal.run/result/task-1') {
      return Response.json({ image: { url: 'https://cdn.example/generated.png' } });
    }
    return finalFetch(input, init);
  }) as typeof globalThis.fetch;
  return calls;
}

describe('media generation providers', () => {
  test('records explicit HEAD-to-GET transport recovery for inlined generated artifacts', async () => {
    process.env.FAL_KEY = 'test-key';
    const calls = installFalFetchStub(async (_input, init) => {
      if (init?.method === 'HEAD') throw new Error('HEAD not supported by provider CDN');
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const result = await getFalProvider().generate!({
      prompt: 'a small icon',
      outputMimeType: 'image/png',
      options: { image: true },
      metadata: {},
    });

    const artifact = result.artifacts[0]!;
    expect(artifact.dataBase64).toBe('AQID');
    expect(artifact.metadata).toMatchObject({
      source: 'media-generation-provider',
      sourceProviderId: 'fal',
      sourceUrl: 'https://cdn.example/generated.png',
      sourceQuality: 'provider-output-url',
      inlined: true,
      retrievalMethod: 'GET',
      transportRecovery: {
        from: 'HEAD',
        to: 'GET',
        reason: 'HEAD not supported by provider CDN',
      },
      headProbe: {
        attempted: true,
        ok: false,
        error: 'HEAD not supported by provider CDN',
      },
    });
    expect(calls.some((call) => call.url === 'https://cdn.example/generated.png' && call.method === 'GET')).toBe(true);
  });

  test('keeps oversized generated artifacts as observable remote references', async () => {
    process.env.FAL_KEY = 'test-key';
    const calls = installFalFetchStub(async (_input, init) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Length': '6000000',
          'Content-Type': 'image/png',
        },
      });
    });

    const result = await getFalProvider().generate!({
      prompt: 'a large image',
      outputMimeType: 'image/png',
      options: { image: true },
      metadata: {},
    });

    const artifact = result.artifacts[0]!;
    expect(artifact.uri).toBe('https://cdn.example/generated.png');
    expect(artifact.dataBase64).toBeUndefined();
    expect(artifact.metadata).toMatchObject({
      source: 'media-generation-provider',
      sourceProviderId: 'fal',
      sourceUrl: 'https://cdn.example/generated.png',
      sourceQuality: 'provider-output-url',
      inlined: false,
      retrievalMethod: 'remote-reference',
      headProbe: {
        attempted: true,
        ok: true,
        status: 200,
        contentLength: 6000000,
        contentType: 'image/png',
      },
    });
    expect(calls.filter((call) => call.url === 'https://cdn.example/generated.png' && call.method === 'GET')).toHaveLength(0);
  });
});
