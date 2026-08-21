/**
 * channel-rollover-surface-agnostic.test.ts
 *
 * "This is surface agnostic. I don't want to just fix telegram if this is a
 * problem with all surfaces."
 *
 * It is a problem with all of them. Every channel adapter reaches the broker
 * through `submitMessage` carrying a `routeId` and no `sessionId`, so every one
 * of them resolved to the closed session and every one of them would have been
 * black-holed the same way, Telegram is simply the surface the owner uses.
 *
 * The fix therefore lives at the shared seam, and this file demonstrates that
 * rather than inferring it from the call graph:
 *
 *  - a SECOND adapter's real inbound path (Signal) heals a closed-bound
 *    conversation, with a real broker and real route bindings underneath;
 *  - the announcement goes out on the route the message arrived on, whatever
 *    surface that is, nothing about it is Telegram-shaped;
 *  - the incident alarm keys on the failing surface, and `ChannelPluginRegistry`
 *    feeds it for every webhook-delivered surface at one seam, so no adapter
 *    can be forgotten.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSignalSurfaceWebhook } from '../packages/sdk/src/platform/adapters/signal/index.ts';
import { handleWhatsAppSurfaceWebhook } from '../packages/sdk/src/platform/adapters/whatsapp/index.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.ts';
import { ChannelPluginRegistry } from '../packages/sdk/src/platform/channels/plugin-registry.ts';
import { ChannelIngressAlarm } from '../packages/sdk/src/platform/channels/ingress-alarm.ts';
import type { ChannelPlugin } from '../packages/sdk/src/platform/channels/plugin-registry.ts';
import type { SurfaceAdapterContext } from '../packages/sdk/src/platform/adapters/types.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

interface Harness {
  readonly broker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly notices: Array<{ routeId: string; text: string }>;
  readonly replies: unknown[];
  readonly context: SurfaceAdapterContext;
  readonly dir: string;
}

async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gv-surface-'));
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
  const notices: Array<{ routeId: string; text: string }> = [];
  broker.setSurfaceNoticeSender((routeId, text) => { notices.push({ routeId, text }); });
  const replies: unknown[] = [];
  const context = {
    serviceRegistry: { resolveSecret: async () => null },
    secretsManager: { get: () => null, getGlobalHome: () => undefined },
    configManager: { get: (key: string) => config[key] },
    routeBindings,
    sessionBroker: broker,
    authorizeSurfaceIngress: async () => ({ allowed: true }),
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    trySpawnAgent: () => ({ id: 'agent-1' }),
    queueSurfaceReplyFromBinding: (binding: unknown, input: unknown) => { replies.push({ binding, input }); },
  } as unknown as SurfaceAdapterContext;
  return { broker, routeBindings, notices, replies, context, dir };
}

describe('the healed seam is shared: a non-Telegram surface behaves identically', () => {
  test('a Signal message whose bound session is closed lands in a fresh session', async () => {
    const h = await makeHarness();
    try {
      // Drive the adapter once so the binding is created exactly as production
      // creates it, then close the session it bound, the observed state.
      const first = await handleSignalSurfaceWebhook(new Request('http://localhost/webhook/signal', {
        method: 'POST',
        body: JSON.stringify({ source: '+15550001111', message: 'first message' }),
      }), h.context);
      expect(first.status).toBe(200);
      const firstBody = await first.json() as Record<string, unknown>;
      const bindingId = String(firstBody.bindingId);
      const firstSession = String(firstBody.sessionId);
      expect(h.routeBindings.getBinding(bindingId)?.sessionId).toBe(firstSession);

      await h.broker.closeSession(firstSession);

      const second = await handleSignalSurfaceWebhook(new Request('http://localhost/webhook/signal', {
        method: 'POST',
        body: JSON.stringify({ source: '+15550001111', message: 'still there?' }),
      }), h.context);

      // No throw, no drop: work queued and an answer routed back.
      expect(second.status).toBe(200);
      const body = await second.json() as Record<string, unknown>;
      expect(body.queued).toBe(true);
      const rolled = String(body.sessionId);
      expect(rolled).not.toBe(firstSession);
      expect(h.broker.getMessages(rolled).map((m) => m.body)).toContain('still there?');
      expect(h.broker.getSession(firstSession)?.status).toBe('closed');
      expect(h.routeBindings.getBinding(bindingId)?.sessionId).toBe(rolled);
      expect(h.replies).toHaveLength(2);

      // The announcement goes out on the SIGNAL route, nothing Telegram-shaped
      // anywhere in the path; the broker only ever names a route id, and the
      // delivery helper picks the escaper from that route's own surface.
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]?.routeId).toBe(bindingId);
      expect(h.routeBindings.getBinding(h.notices[0]!.routeId)?.surfaceKind).toBe('signal');
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test('a WhatsApp message heals the same way — a third surface, same seam, no adapter change', async () => {
    const signingSecret = 'whatsapp-signing-secret';
    const h = await makeHarness({
      'surfaces.whatsapp.phoneNumberId': '15550002222',
      'surfaces.whatsapp.signingSecret': signingSecret,
    });
    try {
      // A real Meta Cloud webhook, signed the way Meta signs it, the adapter
      // rejects anything else, and a test that bypassed that would be exercising
      // a code path production never takes.
      const signedRequest = (text: string): Request => {
        const body = JSON.stringify({
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: '15550002222' },
                contacts: [{ wa_id: '15551234567', profile: { name: 'Avery' } }],
                messages: [{ from: '15551234567', id: `wamid-${text}`, type: 'text', text: { body: text } }],
              },
            }],
          }],
        });
        return new Request('http://localhost/webhook/whatsapp', {
          method: 'POST',
          headers: {
            'x-hub-signature-256': `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`,
          },
          body,
        });
      };

      const first = await handleWhatsAppSurfaceWebhook(signedRequest('first message'), h.context);
      expect(first.status).toBe(200);
      const firstBody = await first.json() as Record<string, unknown>;
      const bindingId = String(firstBody.bindingId);
      const firstSession = String(firstBody.sessionId);
      expect(h.routeBindings.getBinding(bindingId)?.sessionId).toBe(firstSession);

      await h.broker.closeSession(firstSession);

      const second = await handleWhatsAppSurfaceWebhook(signedRequest('still there?'), h.context);
      const body = await second.json() as Record<string, unknown>;

      const rolled = String(body.sessionId);
      expect(rolled).not.toBe(firstSession);
      expect(h.broker.getMessages(rolled).map((m) => m.body)).toContain('still there?');
      expect(h.routeBindings.getBinding(bindingId)?.sessionId).toBe(rolled);
      expect(h.routeBindings.getBinding(h.notices[0]!.routeId)?.surfaceKind).toBe('whatsapp');
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('the incident alarm is fed for every webhook surface at one seam', () => {
  function registryWith(surface: string, handler: () => Promise<Response>): {
    registry: ChannelPluginRegistry;
    alarm: ChannelIngressAlarm;
    alerts: Array<{ surface: string; text: string }>;
  } {
    const registry = new ChannelPluginRegistry();
    const alerts: Array<{ surface: string; text: string }> = [];
    const alarm = new ChannelIngressAlarm({ notify: (s, text) => { alerts.push({ surface: s, text }); } });
    registry.setIngressAlarm(alarm);
    registry.register({
      id: `${surface}-plugin`,
      surface,
      label: surface,
      webhookPath: `/webhook/${surface}`,
      handleInbound: handler,
    } as unknown as ChannelPlugin);
    return { registry, alarm, alerts };
  }

  test.each(['signal', 'whatsapp', 'matrix', 'msteams', 'google-chat', 'mattermost'])(
    'a processing failure on %s degrades that surface and alerts once',
    async (surface) => {
      const { registry, alarm, alerts } = registryWith(surface, async () => {
        throw new Error('the store rejected the write');
      });

      await expect(registry.handleInbound(`/webhook/${surface}`, new Request('http://localhost/x')))
        .rejects.toThrow('the store rejected the write');

      // Keyed on the surface that failed, not on telegram.
      expect(alarm.failure(surface as never)?.detail).toContain('the store rejected the write');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.surface).toBe(surface);
      expect(alerts[0]?.text).toContain(surface);
    },
  );

  test('the error is re-thrown so a retrying provider still sees a failure', async () => {
    // Swallowing it here would turn a retryable 500 into a 200, "might be
    // redelivered" becomes "definitely lost", which is the opposite of the fix.
    const { registry } = registryWith('signal', async () => { throw new Error('boom'); });
    await expect(registry.handleInbound('/webhook/signal', new Request('http://localhost/x')))
      .rejects.toThrow('boom');
  });

  test('a surface that processes cleanly clears its own failure run and no other', async () => {
    const { registry, alarm } = registryWith('signal', async () => new Response('ok'));
    alarm.recordFailure('signal', 'earlier failure');
    alarm.recordFailure('whatsapp', 'unrelated failure');

    await registry.handleInbound('/webhook/signal', new Request('http://localhost/x'));

    expect(alarm.failure('signal')).toBeNull();
    expect(alarm.failure('whatsapp')?.count).toBe(1);
  });

  test('a registry with no alarm wired behaves exactly as before', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'signal-plugin',
      surface: 'signal',
      label: 'signal',
      webhookPath: '/webhook/signal',
      handleInbound: async () => { throw new Error('boom'); },
    } as unknown as ChannelPlugin);
    await expect(registry.handleInbound('/webhook/signal', new Request('http://localhost/x')))
      .rejects.toThrow('boom');
  });
});
