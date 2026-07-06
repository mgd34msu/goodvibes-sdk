/**
 * companion-broker-live-registration.test.ts
 *
 * R3: companion sessions register INTO the shared broker at WRITE time (not only
 * at the next boot fold). Creating a companion session must make it visible via
 * the broker's sessions list same-process (no restart), and closing it must flip
 * the shared record to closed live. Also proves the R2 injected-home path helper.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.ts';
import { defaultSessionsDir } from '../packages/sdk/src/platform/companion/companion-chat-persistence.ts';
import type {
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.ts';
import { dispatchCompanionChatRoutes } from '../packages/sdk/src/platform/companion/companion-chat-routes.ts';
import type { CompanionChatRouteContext } from '../packages/sdk/src/platform/companion/companion-chat-route-types.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';

function mockProvider(): CompanionLLMProvider {
  return { async *chatStream() { yield { type: 'done' } satisfies CompanionProviderChunk; } };
}

function makeBroker(storePath: string): SharedSessionBroker {
  return new SharedSessionBroker({
    storePath,
    routeBindings: { start: async () => {}, patchBinding: async () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

describe('R3 — companion registers into the broker live (same-process)', () => {
  test('createSession → broker.listSessions shows the companion session without restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-live-'));
    try {
      const broker = makeBroker(join(dir, 'sessions.json'));
      await broker.start();
      const manager = new CompanionChatManager({
        provider: mockProvider(),
        eventPublisher: { publishEvent() {} },
        gcIntervalMs: 999_999,
        rateLimiter: false,
        sessionBroker: broker,
      });

      const created = manager.createSession({ title: 'Live Chat' });
      await manager.flushBrokerSync();

      const record = broker.getSession(created.id);
      expect(record).not.toBeNull();
      expect(record?.kind).toBe('companion-chat');
      expect(record?.status).toBe('active');
      expect(record?.title).toBe('Live Chat');
      expect(broker.listSessions(100, { includeClosed: true }).map((s) => s.id)).toContain(created.id);
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('closeSession flips the shared broker record to closed live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-live-close-'));
    try {
      const broker = makeBroker(join(dir, 'sessions.json'));
      await broker.start();
      const manager = new CompanionChatManager({
        provider: mockProvider(),
        eventPublisher: { publishEvent() {} },
        gcIntervalMs: 999_999,
        rateLimiter: false,
        sessionBroker: broker,
      });

      const created = manager.createSession();
      manager.closeSession(created.id);
      await manager.flushBrokerSync();

      expect(broker.getSession(created.id)?.status).toBe('closed');
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no broker bridge, flushBrokerSync is a no-op and createSession still works', async () => {
    const manager = new CompanionChatManager({
      provider: mockProvider(),
      eventPublisher: { publishEvent() {} },
      gcIntervalMs: 999_999,
      rateLimiter: false,
    });
    const created = manager.createSession();
    await manager.flushBrokerSync();
    expect(manager.getSession(created.id)).not.toBeNull();
    manager.dispose();
  });
});

function makeRouteContext(chatManager: CompanionChatManager): CompanionChatRouteContext {
  return {
    chatManager,
    async parseJsonBody(req) {
      try {
        return await req.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    async parseOptionalJsonBody(req) {
      const text = await req.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    openSessionEventStream: (_req, sessionId) =>
      new Response(`data: connected sessionId=${sessionId}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  };
}

// ---------------------------------------------------------------------------
// F2 (Wave-5 review-fix) — the companion HTTP routes actually flush the
// broker mirror before responding, matching CompanionBrokerSync's documented
// contract ("the daemon's companion HTTP routes call this before responding
// so /api/sessions reflects the change synchronously"). Previously nothing
// called flushBrokerSync() outside of tests — the doc was aspirational, not
// true. These assert the shared broker record is already up to date by the
// time each route's Response comes back, with NO extra manual flush call.
// ---------------------------------------------------------------------------

describe('F2 — companion HTTP routes flush the broker mirror before responding', () => {
  test('POST /sessions: the broker already lists the session by the time the route responds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-route-flush-create-'));
    try {
      const broker = makeBroker(join(dir, 'sessions.json'));
      await broker.start();
      const manager = new CompanionChatManager({
        provider: mockProvider(),
        eventPublisher: { publishEvent() {} },
        gcIntervalMs: 999_999,
        rateLimiter: false,
        sessionBroker: broker,
      });
      const context = makeRouteContext(manager);

      const res = await dispatchCompanionChatRoutes(
        new Request('http://daemon/api/companion/chat/sessions', {
          method: 'POST',
          body: JSON.stringify({ title: 'Route Flush', provider: 'test-provider', model: 'test-model' }),
        }),
        context,
      );
      expect(res?.status).toBe(201);
      const { sessionId } = await res!.json() as { sessionId: string };

      // No await manager.flushBrokerSync() here — the route must have already done it.
      expect(broker.getSession(sessionId)).not.toBeNull();
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('POST /sessions/:id/close then DELETE: the broker reflects close then removal with no manual flush', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-route-flush-delete-'));
    try {
      const broker = makeBroker(join(dir, 'sessions.json'));
      await broker.start();
      const manager = new CompanionChatManager({
        provider: mockProvider(),
        eventPublisher: { publishEvent() {} },
        gcIntervalMs: 999_999,
        rateLimiter: false,
        sessionBroker: broker,
      });
      const context = makeRouteContext(manager);

      const created = manager.createSession();
      await manager.flushBrokerSync(); // settle the create-time registration first

      const closeRes = await dispatchCompanionChatRoutes(
        new Request(`http://daemon/api/companion/chat/sessions/${created.id}/close`, { method: 'POST' }),
        context,
      );
      expect(closeRes?.status).toBe(200);
      expect(broker.getSession(created.id)?.status).toBe('closed');

      const deleteRes = await dispatchCompanionChatRoutes(
        new Request(`http://daemon/api/companion/chat/sessions/${created.id}`, { method: 'DELETE' }),
        context,
      );
      expect(deleteRes?.status).toBe(200);

      // No await manager.flushBrokerSync() here — the route must have already done it.
      expect(broker.getSession(created.id)).toBeNull();
      manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R2 — companion sessions dir honors the injected home', () => {
  test('defaultSessionsDir(home) stays inside the injected home, not the OS home', () => {
    const dir = defaultSessionsDir('/isolated/home');
    expect(dir).toBe('/isolated/home/.goodvibes/companion-chat/sessions');
  });
});
