/**
 * provider-prompt-cache-config.test.ts
 *
 * `cache.enabled` and `cache.stableTtl` govern the prompt-cache breakpoints the
 * Anthropic provider places on a request.
 *
 * Both keys used to be dead. `providers/anthropic.ts` built its `CacheContext`
 * unconditionally and called `getDefaultStrategy` on it, so `cache.enabled:
 * false` still paid cache writes; and `CacheContext.configuredTtl` — the field
 * `cache.stableTtl` exists to fill — was populated by no caller, so the enum's
 * '5m' position produced the same 1h breakpoints as its '1h' one. Their two live
 * siblings (`cache.monitorHitRate`, `cache.hitRateWarningThreshold`) are read
 * per turn through a ConfigManager, and these are read the same way.
 *
 * The assertions are on the REQUEST BODY the provider actually sends, not on a
 * strategy object, because that is where a `cache_control` block is either
 * present or absent and where a TTL is either '1h' or the 5-minute default.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '../packages/sdk/src/platform/providers/anthropic.js';
import {
  getDefaultStrategy,
  resolveCacheStrategy,
  type CachePolicyReader,
} from '../packages/sdk/src/platform/providers/cache-strategy.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * A system prompt comfortably over Anthropic's 1024-token minimum cacheable
 * size (the provider estimates tokens as characters/4), so BP1 is eligible and
 * the only reason it would be absent is a config decision.
 */
const BIG_SYSTEM_PROMPT = 'You are a careful assistant. '.repeat(400);

/** A minimal, well-formed Anthropic SSE response. */
function sseBody(): ReadableStream<Uint8Array> {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** A config stand-in holding just the two prompt-cache keys. */
function cacheConfig(values: { enabled?: unknown; stableTtl?: unknown }): CachePolicyReader {
  return {
    get: (key: string) => (key === 'cache.enabled' ? values.enabled : key === 'cache.stableTtl' ? values.stableTtl : undefined),
  } as CachePolicyReader;
}

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/**
 * Drive a real `chat()` against a stubbed transport and return what went out.
 */
async function captureChatRequest(config?: CachePolicyReader): Promise<CapturedRequest> {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    captured = {
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: headers ?? {},
    };
    return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;

  const provider = new AnthropicProvider('test-key', undefined, undefined, config);
  await provider.chat({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ],
    model: 'claude-sonnet-4-6',
    systemPrompt: BIG_SYSTEM_PROMPT,
    maxTokens: 64,
  });

  expect(captured, 'the provider never issued a request').not.toBeNull();
  return captured!;
}

/** Every `cache_control` value anywhere in the request body. */
function cacheControls(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['cache_control'] && typeof record['cache_control'] === 'object') {
      found.push(record['cache_control'] as Record<string, unknown>);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(body['system']);
  walk(body['messages']);
  walk(body['tools']);
  return found;
}

describe('cache.enabled governs whether breakpoints are placed at all', () => {
  test('unset (shipped default) places cache breakpoints', async () => {
    const request = await captureChatRequest(cacheConfig({}));
    expect(cacheControls(request.body).length).toBeGreaterThan(0);
  });

  test('true places cache breakpoints', async () => {
    const request = await captureChatRequest(cacheConfig({ enabled: true }));
    expect(cacheControls(request.body).length).toBeGreaterThan(0);
  });

  test('false places NO cache breakpoints anywhere in the request', async () => {
    const request = await captureChatRequest(cacheConfig({ enabled: false }));
    expect(cacheControls(request.body)).toEqual([]);
  });

  test('false also drops the extended-TTL beta header, which only a breakpoint needs', async () => {
    const on = await captureChatRequest(cacheConfig({ enabled: true }));
    const off = await captureChatRequest(cacheConfig({ enabled: false }));
    expect(on.headers['anthropic-beta'] ?? '').toContain('prompt-caching');
    expect(off.headers['anthropic-beta'] ?? '').not.toContain('prompt-caching');
  });

  test('no config at all keeps the shipped behaviour — caching on', async () => {
    const request = await captureChatRequest(undefined);
    expect(cacheControls(request.body).length).toBeGreaterThan(0);
  });
});

describe('cache.stableTtl reaches the stable-content breakpoint', () => {
  test("'1h' marks the stable prefix with the 1h TTL", async () => {
    const request = await captureChatRequest(cacheConfig({ stableTtl: '1h' }));
    expect(cacheControls(request.body)).toContainEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test("'5m' marks the stable prefix WITHOUT a ttl, which is the 5-minute default", async () => {
    const request = await captureChatRequest(cacheConfig({ stableTtl: '5m' }));
    const controls = cacheControls(request.body);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls).not.toContainEqual({ type: 'ephemeral', ttl: '1h' });
    expect(controls).toContainEqual({ type: 'ephemeral' });
  });

  test("'5m' also drops the extended-TTL beta header the 1h path requires", async () => {
    const long = await captureChatRequest(cacheConfig({ stableTtl: '1h' }));
    const short = await captureChatRequest(cacheConfig({ stableTtl: '5m' }));
    expect(long.headers['anthropic-beta'] ?? '').toContain('prompt-caching');
    expect(short.headers['anthropic-beta'] ?? '').not.toContain('prompt-caching');
  });
});

describe('resolveCacheStrategy — the read itself', () => {
  const context = {
    providerName: 'anthropic',
    systemPromptTokens: 4000,
    toolCount: 0,
    toolTokens: 0,
    conversationTurns: 3,
    conversationTokens: 500,
  };

  test('enabled=false yields the no-op strategy, not a shorter TTL', () => {
    const strategy = resolveCacheStrategy(context, cacheConfig({ enabled: false }));
    expect(strategy.breakpoints).toEqual([]);
    expect(strategy.prefixStable).toBe(false);
    expect(strategy.refreshAfterTurns).toBe(0);
  });

  test('stableTtl lands in configuredTtl, changing the stable breakpoint seconds', () => {
    const short = resolveCacheStrategy(context, cacheConfig({ stableTtl: '5m' }));
    const long = resolveCacheStrategy(context, cacheConfig({ stableTtl: '1h' }));
    const stableOf = (s: ReturnType<typeof resolveCacheStrategy>) =>
      s.breakpoints.find((bp) => bp.position === 'system_and_tools');
    expect(stableOf(short)?.ttlSeconds).toBe(300);
    expect(stableOf(long)?.ttlSeconds).toBe(3600);
  });

  test('with no config it matches getDefaultStrategy exactly', () => {
    expect(resolveCacheStrategy(context)).toEqual(getDefaultStrategy(context));
  });

  test('a non-string stableTtl is ignored rather than passed through', () => {
    expect(resolveCacheStrategy(context, cacheConfig({ stableTtl: 3600 }))).toEqual(
      getDefaultStrategy(context),
    );
  });
});
