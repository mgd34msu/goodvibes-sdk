import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createBrowserHomeAssistantSdk,
} from '../packages/sdk/dist/browser-homeassistant.js';
import {
  createBrowserKnowledgeSdk,
} from '../packages/sdk/dist/browser-knowledge.js';
import sdkPackage from '../packages/sdk/package.json' with { type: 'json' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createRecordingFetch(body: unknown = { ok: true }): {
  readonly calls: string[];
  readonly fetch: typeof fetch;
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(body);
    }) as typeof fetch,
  };
}

async function bundleEntrypoint(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '..', entrypoint)],
    target: 'browser',
    format: 'esm',
    minify: false,
    packages: 'external',
    write: false,
  });
  expect(result.success, result.logs.map((log) => log.message).join('\n')).toBe(true);
  const [output] = result.outputs;
  expect(output).toBeDefined();
  return await output!.text();
}

describe('scoped browser SDK entrypoints', () => {
  test('package exports expose knowledge and home assistant browser seams', () => {
    expect(sdkPackage.exports['./browser/knowledge']).toEqual({
      types: './dist/browser-knowledge.d.ts',
      import: './dist/browser-knowledge.js',
    });
    expect(sdkPackage.exports['./browser/homeassistant']).toEqual({
      types: './dist/browser-homeassistant.d.ts',
      import: './dist/browser-homeassistant.js',
    });
  });

  test('knowledge browser sdk routes only regular knowledge methods', async () => {
    const transport = createRecordingFetch({
      ready: true,
      storagePath: '/tmp/goodvibes',
      sourceCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      issueCount: 0,
      extractionCount: 0,
      jobRunCount: 0,
      usageCount: 0,
      candidateCount: 0,
      reportCount: 0,
      scheduleCount: 0,
    });
    const sdk = createBrowserKnowledgeSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: transport.fetch,
    });

    await sdk.knowledge.status();
    expect(transport.calls).toEqual(['https://daemon.example.test/api/knowledge/status']);
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('homeassistant.homeGraph.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('home assistant browser sdk routes only home graph methods', async () => {
    const transport = createRecordingFetch({ ok: true });
    const sdk = createBrowserHomeAssistantSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: transport.fetch,
    });

    await sdk.homeGraph.status();
    expect(transport.calls).toEqual(['https://daemon.example.test/api/homeassistant/home-graph/status']);
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('knowledge.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('bundled knowledge entrypoint does not include Home Graph contract metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-knowledge.ts');

    expect(bundle).not.toContain('homeassistant.homeGraph');
    expect(bundle).not.toContain('/api/homeassistant/home-graph');
  });

  test('bundled home assistant entrypoint does not include base knowledge/wiki contract metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-homeassistant.ts');

    expect(bundle).not.toContain('knowledge.ask');
    expect(bundle).not.toContain('knowledge.refinement.tasks.list');
    expect(bundle).not.toContain('/api/knowledge/ask');
    expect(bundle).not.toContain('/api/knowledge/projections');
  });
});
