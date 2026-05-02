/**
 * sec-08-ssrf-filter.test.ts
 *
 * SEC-08: SSRF tier filter on HTTP hooks and WebhookNotifier.
 * Verifies that requests to private/internal hosts are blocked, and that
 * HookDefinition.allowInternal: true bypasses the filter for hooks.
 */

import { describe, expect, test } from 'bun:test';
import { run as runHttpHook } from '../packages/sdk/src/_internal/platform/hooks/runners/http.ts';
import type { HookDefinition, HookEvent } from '../packages/sdk/src/_internal/platform/hooks/types.ts';
import { WebhookNotifier } from '../packages/sdk/src/_internal/platform/integrations/webhooks.ts';

const MOCK_EVENT: HookEvent = {
  path: 'Post:tool:test' as HookEvent['path'],
  phase: 'Post',
  category: 'tool',
  specific: 'test',
  sessionId: 'sess-ssrf-test',
  timestamp: Date.now(),
  payload: {},
};

describe('SEC-08: HTTP hook SSRF filter', () => {
  test('localhost hook URL is blocked', async () => {
    const hook: HookDefinition = {
      match: 'Post:tool:*',
      type: 'http',
      url: 'http://localhost:9999/hook',
    };
    const result = await runHttpHook(hook, MOCK_EVENT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/);
  });

  test('private IPv4 hook URL is blocked', async () => {
    const hook: HookDefinition = {
      match: 'Post:tool:*',
      type: 'http',
      url: 'http://192.168.1.100/hook',
    };
    const result = await runHttpHook(hook, MOCK_EVENT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/);
  });

  test('cloud metadata endpoint is blocked', async () => {
    const hook: HookDefinition = {
      match: 'Post:tool:*',
      type: 'http',
      url: 'http://169.254.169.254/latest/meta-data/',
    };
    const result = await runHttpHook(hook, MOCK_EVENT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/);
  });

  test('allowInternal: true bypasses the SSRF filter (attempts actual fetch — expected network fail, not SSRF block)', async () => {
    const hook: HookDefinition = {
      match: 'Post:tool:*',
      type: 'http',
      url: 'http://127.0.0.1:19999/no-such-endpoint',
      allowInternal: true,
      timeout: 1, // 1 second — connection refused is instant
    };
    const result = await runHttpHook(hook, MOCK_EVENT);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').not.toMatch(/^http hook blocked/);
  });

  test('public external URL is not blocked (does not contain SSRF error)', async () => {
    // We do not make a real network request here — we only verify the filter passes.
    // The hook runner will try to fetch but will fail with a network error, NOT an SSRF block.
    const hook: HookDefinition = {
      match: 'Post:tool:*',
      type: 'http',
      url: 'https://example.com/hook-does-not-exist',
      timeout: 1, // 1 second
    };
    const result = await runHttpHook(hook, MOCK_EVENT);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').not.toMatch(/^http hook blocked/);
  });
});

describe('SEC-08: WebhookNotifier SSRF filter', () => {
  test('localhost webhook URL throws on postOne', async () => {
    const notifier = new WebhookNotifier();
    notifier.addUrl('http://localhost:19999/webhook');

    const results = await notifier.test();
    expect(results.length).toBe(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/blocked/);
  });

  test('private IP webhook URL throws on postOne', async () => {
    const notifier = new WebhookNotifier();
    notifier.addUrl('http://10.0.0.1/webhook');

    const results = await notifier.test();
    expect(results.length).toBe(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/blocked/);
  });

  test('public URL is not blocked by SSRF filter', async () => {
    const notifier = new WebhookNotifier([], { timeoutMs: 1_000 });
    notifier.addUrl('https://example.com/no-such-webhook');

    const results = await notifier.test();
    expect(results.length).toBe(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error ?? '').not.toMatch(/blocked URL/);
  });
});
