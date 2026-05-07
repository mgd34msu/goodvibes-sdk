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
    await sdk.operator.invoke('companion.chat.sessions.create', {
      title: 'WebUI chat',
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(transport.calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions');
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('homeassistant.homeGraph.status', {}),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
    await expect(
      (sdk.operator as { invoke(methodId: string, input?: unknown): Promise<unknown> })
        .invoke('companion.chat.events.stream', { sessionId: 'chat-1' }),
    ).rejects.toThrow('is not available from this scoped browser SDK entrypoint');
  });

  test('knowledge browser sdk exposes companion chat helpers and session event stream', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/events')) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: companion-chat.turn.delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"turn.delta","sessionId":"chat-1","turnId":"turn-1","delta":"Hi"}\n\n'));
            controller.close();
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/sessions')) {
        return jsonResponse({
          sessionId: 'chat-1',
          createdAt: 123,
          session: {
            id: 'chat-1',
            kind: 'companion-chat',
            title: 'WebUI chat',
            model: 'openai:gpt-5.5',
            provider: 'openai',
            systemPrompt: null,
            status: 'active',
            createdAt: 123,
            updatedAt: 123,
            closedAt: null,
            messageCount: 0,
          },
        });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const sdk = createBrowserKnowledgeSdk({
      baseUrl: 'https://daemon.example.test',
      fetch: fetchImpl,
    });

    await sdk.chat.sessions.create({
      title: 'WebUI chat',
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(calls[0]).toBe('https://daemon.example.test/api/companion/chat/sessions');
    await sdk.chat.sessions.list({ limit: 10 });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions?limit=10');
    await sdk.chat.sessions.update('chat-1', {
      provider: 'openai',
      model: 'openai:gpt-5.5',
    });
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions/chat-1');
    const events: unknown[] = [];
    const close = await sdk.chat.events.stream('chat-1', {
      onEvent: (_eventName, payload) => {
        events.push(payload);
      },
    }, { reconnect: { enabled: false } });
    await Promise.resolve();
    close();
    expect(calls.at(-1)).toBe('https://daemon.example.test/api/companion/chat/sessions/chat-1/events');
    expect(events).toEqual([{ type: 'turn.delta', sessionId: 'chat-1', turnId: 'turn-1', delta: 'Hi' }]);
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
    expect(bundle).toContain('companion.chat.sessions.create');
  });

  test('bundled home assistant entrypoint does not include base knowledge/wiki contract metadata', async () => {
    const bundle = await bundleEntrypoint('packages/sdk/src/browser-homeassistant.ts');

    expect(bundle).not.toContain('knowledge.ask');
    expect(bundle).not.toContain('knowledge.refinement.tasks.list');
    expect(bundle).not.toContain('/api/knowledge/ask');
    expect(bundle).not.toContain('/api/knowledge/projections');
  });
});
