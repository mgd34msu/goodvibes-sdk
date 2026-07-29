/**
 * telegram-ingress-closed-session-recovery.test.ts
 *
 * The incident, end to end.
 *
 * A route binding named a shared session that had been closed. Every inbound
 * update reached `sessionBroker.submitMessage`, which threw SESSION_CLOSED, and
 * the poller logged "advancing past it" and moved its cursor. Updates 882095266
 * and 882095267 were eaten. Nothing changed the reported health, and nobody was
 * told.
 *
 * Two halves are pinned here, at the two seams that actually failed:
 *
 *  - `processTelegramUpdate` driven against a REAL broker whose route binding
 *    names a closed session answers with queued work and a reply, not a throw.
 *    This is the drop that must no longer happen.
 *  - a supervisor whose processing DOES fail — for anything else, since nobody
 *    predicted the first one either — still advances its cursor, but now goes
 *    degraded and reaches the owner, and clears both when the next update lands.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramIngressSupervisor } from '../packages/sdk/src/platform/channels/telegram/ingress.ts';
import { TelegramBotApi } from '../packages/sdk/src/platform/channels/telegram/api.ts';
import { ChannelIngressAlarm } from '../packages/sdk/src/platform/channels/ingress-alarm.ts';
import { observeTelegramRuntime } from '../packages/sdk/src/platform/channels/builtin/health.ts';
import { resolveChannelHealthState } from '../packages/sdk/src/platform/channels/health.ts';
import { processTelegramUpdate } from '../packages/sdk/src/platform/adapters/telegram/index.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.ts';
import type { SurfaceAdapterContext } from '../packages/sdk/src/platform/adapters/types.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const TEST_BUDGET_MS = 45_000;

async function waitFor(predicate: () => boolean, label: string, ceilingMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ceilingMs) throw new Error(`telegram ingress: ${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Half one — the adapter over a real broker
// ---------------------------------------------------------------------------

describe('an inbound Telegram message whose bound session is closed is answered, not dropped', () => {
  test('processTelegramUpdate queues work and a reply instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-tg-closed-'));
    try {
      const routeBindings = new RouteBindingManager({
        store: new AutomationRouteStore(join(dir, 'automation-routes.json')),
      });
      await routeBindings.start();
      const broker = disposables.add(new SharedSessionBroker({
        storePath: join(dir, 'sessions.json'),
        routeBindings,
        agentStatusProvider: { getStatus: () => null },
        messageSender: { send: () => false },
      } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));

      // The exact state the daemon was in: a bound chat whose session is closed.
      const binding = await routeBindings.upsertBinding({
        kind: 'channel',
        surfaceKind: 'telegram',
        surfaceId: 'goodvibes_bot',
        externalId: '4242',
        channelId: '4242',
        title: 'Mike',
      });
      const dead = await broker.createSession({ id: 'sess-4ca358a3' });
      await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
      await broker.closeSession(dead.id);

      const replies: Array<Record<string, unknown>> = [];
      const spawned: string[] = [];
      const config: Record<string, unknown> = {
        'surfaces.telegram.botUsername': 'goodvibes_bot',
      };
      const context = {
        serviceRegistry: { resolveSecret: async () => null },
        configManager: { get: (key: string) => config[key] },
        routeBindings,
        sessionBroker: broker,
        authorizeSurfaceIngress: async () => ({ allowed: true }),
        parseSurfaceControlCommand: () => null,
        performSurfaceControlCommand: async () => 'ok',
        trySpawnAgent: (input: { task: unknown }) => {
          spawned.push(JSON.stringify(input.task));
          return { id: `agent-${spawned.length}` };
        },
        queueSurfaceReplyFromBinding: (routeBinding: unknown, input: unknown) => {
          replies.push({ routeBinding, input });
        },
      } as unknown as SurfaceAdapterContext;

      const response = await processTelegramUpdate({
        update_id: 882095266,
        message: { chat: { id: 4242, type: 'private' }, from: { id: 7, username: 'mike' }, text: 'any update?' },
      }, context);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.queued).toBe(true);
      // The work was started, and an answer is routed back to the chat.
      expect(spawned).toHaveLength(1);
      expect(replies).toHaveLength(1);
      // In a NEW session, with the message actually recorded there.
      const landedIn = String(body.sessionId);
      expect(landedIn).not.toBe('sess-4ca358a3');
      expect(broker.getMessages(landedIn).map((m) => m.body)).toContain('any update?');
      // And the route now points at it, durably.
      expect(routeBindings.getBinding(binding.id)?.sessionId).toBe(landedIn);
      // The closed session is untouched history.
      expect(broker.getSession('sess-4ca358a3')?.status).toBe('closed');
      expect(broker.getMessages('sess-4ca358a3')).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Half two — the poller when processing fails for some OTHER reason
// ---------------------------------------------------------------------------

interface ApiCall { readonly method: string; readonly body: Record<string, unknown>; }

class FakeTelegram {
  readonly calls: ApiCall[] = [];
  private readonly queues = new Map<string, Array<() => Response>>();
  /** Consulted on every poll once the queue drains; null = keep holding open. */
  private held: (() => Array<Record<string, unknown>> | null) | null = null;

  queue(method: string, ...responses: Array<() => Response>): void {
    this.queues.set(method, [...(this.queues.get(method) ?? []), ...responses]);
  }

  /**
   * Model Telegram's long poll faithfully: it holds the connection open until
   * there is something to deliver. That is what lets a test decide WHEN the
   * next update arrives instead of racing the poller for it.
   */
  holdGetUpdates(next: () => Array<Record<string, unknown>> | null): void {
    this.held = next;
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    this.calls.push({ method, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    const next = this.queues.get(method)?.shift();
    if (next) return next();
    if (method === 'getUpdates') {
      const signal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        if (!this.held) return;
        const poll = setInterval(() => {
          const updates = this.held?.() ?? null;
          if (!updates) return;
          this.held = null;
          clearInterval(poll);
          resolve(okResult(updates)());
        }, 5);
        signal?.addEventListener('abort', () => { clearInterval(poll); }, { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
}

function okResult(result: unknown): () => Response {
  return () => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function textUpdate(updateId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: { chat: { id: 4242, type: 'private' }, from: { id: 7, username: 'mike' }, text },
  };
}

describe('a skipped update advances the cursor LOUDLY', () => {
  test(
    'processing failure degrades health and alerts the owner; the next success clears both',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gv-tg-alarm-'));
      const telegram = new FakeTelegram();
      const alerts: string[] = [];
      const alarm = new ChannelIngressAlarm({ notify: (_surface, text) => { alerts.push(text); } });
      let failNext = true;
      const processed: string[] = [];
      const config: Record<string, unknown> = {
        'surfaces.telegram.enabled': true,
        'surfaces.telegram.mode': 'polling',
        'surfaces.telegram.botToken': '123456:test-token',
        'surfaces.telegram.botUsername': 'goodvibes_bot',
      };

      // The failing update is delivered immediately. The recovering one is held
      // back until the test has observed the degraded state — otherwise the two
      // race, and a green run would prove only that the poller is fast.
      let releaseSecond = false;
      telegram.queue('getUpdates', okResult([textUpdate(882095266, 'first')]));
      telegram.holdGetUpdates(() => (releaseSecond ? [textUpdate(882095267, 'second')] : null));

      const supervisor = new TelegramIngressSupervisor({
        configManager: { get: (key: string) => config[key] } as never,
        secretsManager: { get: () => null, getGlobalHome: () => undefined } as never,
        serviceRegistry: { resolveSecret: async () => null } as never,
        offsetFilePath: join(dir, 'telegram-offset.json'),
        createApi: (token) => new TelegramBotApi(token, telegram.fetch),
        ingressAlarm: alarm,
        conflictJitterFraction: () => 0,
        buildSurfaceAdapterContext: () => ({
          serviceRegistry: { resolveSecret: async () => null },
          configManager: { get: (key: string) => config[key] },
          routeBindings: {
            upsertBinding: async () => ({ id: 'binding-1', surfaceId: 'goodvibes_bot', externalId: '4242', channelId: '4242', title: 'Mike' }),
          },
          sessionBroker: {
            submitMessage: async (input: { body: string }) => {
              if (failNext) {
                failNext = false;
                throw Object.assign(new Error('the store rejected the write'), { status: 500 });
              }
              processed.push(input.body);
              return { mode: 'spawn', task: { prompt: input.body }, session: { id: 'session-1' } };
            },
            bindAgent: async () => { /* no-op */ },
          },
          authorizeSurfaceIngress: async () => ({ allowed: true }),
          parseSurfaceControlCommand: () => null,
          performSurfaceControlCommand: async () => 'ok',
          trySpawnAgent: () => ({ id: 'agent-1' }),
          queueSurfaceReplyFromBinding: () => { /* no-op */ },
        }) as never,
      });

      try {
        await supervisor.start();

        await waitFor(() => alerts.length > 0, 'the owner to be alerted about a skipped message');
        // The reason travels with it — this is the thing the warn line buried.
        expect(alerts[0]).toContain('could not be processed');
        expect(alerts[0]).toContain('the store rejected the write');
        expect(alarm.failure('telegram')?.count).toBe(1);

        // Health, read exactly the way the status verb reads it.
        const degraded = supervisor.status;
        expect(degraded.running).toBe(true); // the LOOP is fine; that was the trap
        expect(degraded.lastError).toContain('the store rejected the write');
        expect(resolveChannelHealthState({
          enabled: true,
          configured: true,
          credentialResolves: true,
          runtime: observeTelegramRuntime(degraded),
        })).toBe('degraded');

        // The cursor still advanced — a poison update must not wedge the channel.
        releaseSecond = true;
        await waitFor(() => processed.length > 0, 'the next update to be processed');
        expect(processed).toEqual(['second']);

        // …and recovery is announced once, then the surface reads healthy again.
        await waitFor(() => alerts.length > 1, 'the recovery notice');
        expect(alerts[1]).toContain('processing arriving messages again');
        expect(alarm.failure('telegram')).toBeNull();
        const recovered = supervisor.status;
        expect(recovered.lastError).toBeUndefined();
        expect(resolveChannelHealthState({
          enabled: true,
          configured: true,
          credentialResolves: true,
          runtime: observeTelegramRuntime(recovered),
        })).toBe('healthy');
      } finally {
        await supervisor.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
});
