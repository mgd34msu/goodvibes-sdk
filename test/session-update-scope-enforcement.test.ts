/**
 * session-update-scope-enforcement.test.ts  (m1)
 *
 * The `control.session_update` channel declares `scopes: ['read:sessions']`.
 * The gateway must ENFORCE that on the per-client SSE fan-out: a principal-scoped
 * web client without read:sessions does not receive session-update frames, while
 * one that has it (or an admin token — single-admin-token collapse) does. Internal
 * streams that carry no scopes stay trusted so nothing existing regresses.
 */

import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

function makeGateway(): ControlPlaneGateway {
  return new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus(), featureFlags: createFeatureFlagManager() });
}

/** Read from an SSE stream until `event: session-update` is seen or a short budget elapses. */
async function sawSessionUpdate(res: Response): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 200;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 40)),
      ]);
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes('event: session-update')) return true;
      if (chunk.done && !chunk.value) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return buffer.includes('event: session-update');
}

function openWebStream(gateway: ControlPlaneGateway, opts: { scopes?: readonly string[]; admin?: boolean }): Response {
  return gateway.createEventStream(new Request('http://localhost/api/control-plane/events'), {
    clientKind: 'web',
    transport: 'sse',
    principalId: 'p',
    principalKind: 'token',
    ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
    ...(opts.admin !== undefined ? { admin: opts.admin } : {}),
  });
}

describe('m1 — session-update honors the declared read:sessions scope', () => {
  test('a web client WITHOUT read:sessions does not receive session-update', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:events'] });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    expect(await sawSessionUpdate(res)).toBe(false);
  });

  test('a web client WITH read:sessions receives session-update', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:sessions'] });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    expect(await sawSessionUpdate(res)).toBe(true);
  });

  test('an admin token receives session-update even with only read:events (single-token collapse)', async () => {
    const gateway = makeGateway();
    const res = openWebStream(gateway, { scopes: ['read:events'], admin: true });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    expect(await sawSessionUpdate(res)).toBe(true);
  });

  test('an internal stream with NO scopes stays trusted (no regression for session-scoped streams)', async () => {
    const gateway = makeGateway();
    const res = gateway.createEventStream(new Request('http://localhost/stream'), { clientKind: 'web' });
    gateway.publishEvent('session-update', { event: 'session-created', payload: {}, createdAt: Date.now() });
    expect(await sawSessionUpdate(res)).toBe(true);
  });
});
