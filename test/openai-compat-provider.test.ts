/**
 * openai-compat-provider.test.ts
 *
 * Regression tests for two 1.7.0 defects in the OpenAI-compatible provider
 * stack, both traced to the `openai` npm dependency resolving past 6.4x:
 *
 * 1. `new OpenAI({ apiKey: '' })` started throwing "Missing credentials..."
 *    once `apiKey` is falsy (previously it only threw on `undefined`). Every
 *    discovered/anonymous provider (Ollama, LM Studio, llama.cpp, vLLM, TGI,
 *    LocalAI) is registered with a hardcoded `apiKey: ''`
 *    (discovered-factory.ts), so ProviderRegistry.registerDiscoveredProviders()
 *    threw at discovery time for every local-server user. Fixed by
 *    substituting a harmless placeholder before constructing the `openai`
 *    client (resolveOpenAIClientApiKey in openai-compat.ts), while deriving
 *    `configured`/`isConfigured()` status from the ORIGINAL apiKey.
 *
 * 2. The chat/stream error-diagnostic path (extractOpenAICompatErrorDiagnostic
 *    + buildOpenAICompatErrorMessage) must render a clean, bounded message —
 *    "<provider> chat <phase> failed <status>: <detail> (request_id=<id>)" —
 *    for both the request phase (fails before the stream opens) and the
 *    stream phase (fails after the stream opens, mid-consumption), never a
 *    stringified function/object dump.
 *
 * These run against whatever `openai` version bun.lock actually resolves —
 * printed below so the pin is visible in test output.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import type { Server } from 'bun';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { OpenAICompatProvider } from '../packages/sdk/src/platform/providers/openai-compat.js';
import { createDiscoveredProvider } from '../packages/sdk/src/platform/providers/discovered-factory.js';
import type { DiscoveredServer } from '../packages/sdk/src/platform/discovery/scanner.js';
import type { ProviderRuntimeMetadataDeps } from '../packages/sdk/src/platform/providers/interface.js';

/** Minimal describeRuntime() dependency stub — no stored secrets, no
 * services, no subscriptions. Enough to exercise the auth-mode/configured
 * derivation without pulling in real secret-store/service-registry plumbing. */
const STUB_RUNTIME_DEPS: ProviderRuntimeMetadataDeps = {
  secretsManager: { listDetailed: async () => [] },
  serviceRegistry: { getAll: () => ({}), inspect: async () => null },
  subscriptionManager: { get: () => null, getPending: () => null },
};

// Resolve relative to openai-compat.ts (not this test file) — `openai` is a
// dependency of packages/sdk, and Bun's workspace hoisting doesn't guarantee
// it's reachable via require.resolve() from the repo root.
const providerModuleRequire = createRequire(
  new URL('../packages/sdk/src/platform/providers/openai-compat.ts', import.meta.url),
);
function resolveInstalledOpenAIVersion(): string {
  try {
    const entry = providerModuleRequire.resolve('openai');
    // openai's package.json sits at the package root; walk up from the
    // resolved entry file (dist/**/index.js) to find it rather than relying
    // on a 'openai/package.json' export subpath, which isn't guaranteed.
    let dir = entry.replace(/\/[^/]*$/, '');
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'openai' && pkg.version) return pkg.version;
      } catch {
        // keep walking up
      }
      dir = dir.replace(/\/[^/]*$/, '');
      if (!dir) break;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}
console.log(`[openai-compat-provider.test] resolved openai version: ${resolveInstalledOpenAIVersion()}`);

function makeDiscoveredServer(over: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return {
    name: 'test-local-server',
    host: '127.0.0.1',
    port: 1,
    serverType: 'ollama',
    baseURL: 'http://127.0.0.1:1/v1',
    models: ['llama3'],
    ...over,
  };
}

// ── Empty-apiKey construction (discovered/anonymous providers) ───────────────

describe('OpenAICompatProvider — empty apiKey construction', () => {
  test('constructing with apiKey: "" (discovered-provider shape) does not throw', () => {
    expect(() =>
      new OpenAICompatProvider({
        name: 'ollama',
        baseURL: 'http://127.0.0.1:1/v1',
        apiKey: '',
        defaultModel: 'llama3',
        models: ['llama3'],
        allowAnonymous: true,
        anonymousConfigured: true,
      }),
    ).not.toThrow();
  });

  test('empty apiKey + allowAnonymous reports isConfigured() true but auth mode stays "anonymous" (unconfigured internal state preserved)', async () => {
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: '',
      defaultModel: 'llama3',
      models: ['llama3'],
      allowAnonymous: true,
      anonymousConfigured: true,
    });
    expect(provider.isConfigured()).toBe(true);
    const runtime = await provider.describeRuntime(STUB_RUNTIME_DEPS);
    // mode is 'anonymous' only when allowAnonymous && !this.configured — proves
    // the substituted placeholder never leaked into the internal `configured`
    // flag (it's still derived from the ORIGINAL empty apiKey).
    expect(runtime.auth.mode).toBe('anonymous');
    expect(runtime.auth.configured).toBe(true);
  });

  test('a real (non-empty) apiKey is passed through unchanged and reports api-key mode', async () => {
    const provider = new OpenAICompatProvider({
      name: 'openrouter',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-real-key',
      defaultModel: 'model',
      models: ['model'],
    });
    expect(provider.isConfigured()).toBe(true);
    const runtime = await provider.describeRuntime(STUB_RUNTIME_DEPS);
    expect(runtime.auth.mode).toBe('api-key');
    expect(runtime.auth.configured).toBe(true);
  });

  test('empty apiKey with allowAnonymous false reports unconfigured (no throw, but genuinely not usable)', async () => {
    const provider = new OpenAICompatProvider({
      name: 'some-remote-provider',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: '',
      defaultModel: 'model',
      models: ['model'],
    });
    expect(provider.isConfigured()).toBe(false);
    const runtime = await provider.describeRuntime(STUB_RUNTIME_DEPS);
    expect(runtime.auth.configured).toBe(false);
  });
});

// ── discovered-factory.ts integration: the exact regression scenario ─────────

describe('createDiscoveredProvider — every discovered server type constructs without throwing', () => {
  const serverTypes: DiscoveredServer['serverType'][] = [
    'ollama',
    'lm-studio',
    'llamacpp',
    'vllm',
    'tgi',
    'localai',
  ];

  for (const serverType of serverTypes) {
    test(`serverType=${serverType} — apiKey: '' hardcoded in discovered-factory.ts does not throw at construction`, () => {
      const server = makeDiscoveredServer({ serverType, name: `test-${serverType}` });
      let provider: ReturnType<typeof createDiscoveredProvider> | undefined;
      expect(() => {
        provider = createDiscoveredProvider(server);
      }).not.toThrow();
      expect(provider).toBeDefined();
      expect(provider!.isConfigured?.()).toBe(true);
    });
  }
});

// ── Error diagnostic message format: request phase and stream phase ──────────

describe('OpenAICompatProvider.chat — error diagnostic message format', () => {
  let server: Server | undefined;
  afterAll(() => {
    server?.stop(true);
  });

  test('request-phase failure (error before the stream opens): message includes status + request_id, no raw dump', async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json', 'x-request-id': 'req_diagnostic_test_401' },
          },
        );
      },
    });

    const provider = new OpenAICompatProvider({
      name: 'test-provider',
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'irrelevant-test-key',
      defaultModel: 'gpt-test',
      models: ['gpt-test'],
    });

    let caught: unknown;
    try {
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-test' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const err = caught as { message: string; statusCode?: number; requestId?: string; phase?: string };
    expect(err.message).toContain('chat request failed 401');
    expect(err.message).toContain('request_id=req_diagnostic_test_401');
    expect(err.statusCode).toBe(401);
    expect(err.requestId).toBe('req_diagnostic_test_401');
    expect(err.phase).toBe('request');
    // Guard against the exact regression shape: a stringified function/call
    // expression rather than a clean diagnostic (no arrow-function or
    // function-keyword source leaking into the rendered message).
    expect(err.message).not.toMatch(/=>|function\s*\(|\.call\(|\.apply\(/);
    expect(err.message.length).toBeLessThan(300);

    server.stop(true);
    server = undefined;
  });

  test('stream-phase failure (error after the stream opens mid-consumption): message says "stream", stays clean', async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        const encoder = new TextEncoder();
        const validChunk = {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-test',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        };
        const stream = new ReadableStream({
          start(controller) {
            // First chunk is well-formed so the SDK's stream genuinely opens
            // (streamOpened = true) before the failure.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(validChunk)}\n\n`));
            // Second "chunk" is malformed (no `choices` field) — our own
            // consumption code (`raw.choices[0]?.delta`) throws reading it,
            // a real thrown error occurring strictly after streamOpened=true.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'x' })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_diagnostic_test_stream' },
        });
      },
    });

    const provider = new OpenAICompatProvider({
      name: 'test-provider',
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'irrelevant-test-key',
      defaultModel: 'gpt-test',
      models: ['gpt-test'],
    });

    let caught: unknown;
    try {
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-test' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const err = caught as { message: string; phase?: string };
    expect(err.phase).toBe('stream');
    expect(err.message).toContain('chat stream failed');
    // Same anti-regression guard as the request-phase test: no
    // stringified-function/call-expression dump in place of a real message.
    expect(err.message).not.toMatch(/=>|function\s*\(|\.call\(|\.apply\(/);
    expect(err.message.length).toBeLessThan(300);

    server.stop(true);
    server = undefined;
  });
});
