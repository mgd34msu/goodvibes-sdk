/**
 * adapters-swept-credential-auth.test.ts — inbound auth after the config sweep.
 *
 * `sweepPlaintextCredentials` moves a literal surface credential out of the
 * config file into the secret store and leaves a
 * `goodvibes://secrets/goodvibes/<KEY>` reference behind. Every inbound webhook
 * adapter compares a caller's presented secret against the CONFIG value, so
 * until the adapters resolve that reference a correctly-configured surface
 * answers 401 to every POST.
 *
 * Four cases per adapter family, because three of them pass for reasons that
 * do not generalise:
 *
 *   1. a swept (reference) credential authorises the right caller — the defect;
 *   2. a raw literal still authorises — the un-swept operator and the env-var
 *      operator both still hold literals, and resolution must pass those
 *      through rather than require a reference;
 *   3. a wrong secret is refused — resolution must not weaken the comparison;
 *   4. a reference that resolves to NOTHING refuses rather than authorising —
 *      the failure mode resolution introduces. Seven of these adapters skip the
 *      comparison entirely when the configured credential is empty ("no secret
 *      configured, no check to run"), so a resolution failure that degrades to
 *      an empty string turns a locked surface into an open one.
 */
import { describe, expect, test } from 'bun:test';
import { handleSignalSurfaceWebhook } from '../packages/sdk/src/platform/adapters/signal/index.js';
import { handleIMessageSurfaceWebhook } from '../packages/sdk/src/platform/adapters/imessage/index.js';
import { handleMatrixSurfaceWebhook } from '../packages/sdk/src/platform/adapters/matrix/index.js';
import { handleMattermostSurfaceWebhook } from '../packages/sdk/src/platform/adapters/mattermost/index.js';
import { handleMSTeamsSurfaceWebhook } from '../packages/sdk/src/platform/adapters/msteams/index.js';
import { handleBlueBubblesSurfaceWebhook } from '../packages/sdk/src/platform/adapters/bluebubbles/index.js';
import { handleGoogleChatSurfaceWebhook } from '../packages/sdk/src/platform/adapters/google-chat/index.js';
import { handleNtfySurfaceWebhook } from '../packages/sdk/src/platform/adapters/ntfy/index.js';
import { handleTelegramSurfaceWebhook } from '../packages/sdk/src/platform/adapters/telegram/index.js';
import { handleTelephonySurfaceWebhook } from '../packages/sdk/src/platform/adapters/telephony/index.js';
import { handleWhatsAppSurfaceWebhook } from '../packages/sdk/src/platform/adapters/whatsapp/index.js';
import { handleGenericWebhookSurface } from '../packages/sdk/src/platform/adapters/webhook/index.js';
import { secretReferenceFor } from '../packages/sdk/src/platform/config/plaintext-credential-sweep.js';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.js';

const SECRET = 'the-real-surface-secret';

/**
 * The exact reference the sweep writes for a config key, derived through the
 * same two functions the sweep uses rather than hand-spelled — a test that
 * hard-codes the reference format keeps passing after the format changes.
 */
function sweptReference(configKey: string): string {
  return secretReferenceFor(daemonSecretKeyFor(configKey));
}

type ConfigShape = 'literal' | 'swept' | 'swept-unresolvable' | 'whitespace';

interface HarnessOptions {
  readonly shape: ConfigShape;
  readonly configKeys: readonly string[];
  readonly extraConfig?: Record<string, unknown>;
}

/**
 * Build the adapter context for one credential shape.
 *
 * `swept` files the secret in the store double and puts the reference in
 * config, which is the production shape after 1.19.1. `swept-unresolvable`
 * writes the same reference and leaves the store EMPTY — an operator who
 * cleared the store, a scope the daemon cannot read, a key renamed by hand.
 */
function makeContext(options: HarnessOptions) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const store = new Map<string, string>();
  const config = new Map<string, unknown>(Object.entries(options.extraConfig ?? {}));

  for (const configKey of options.configKeys) {
    if (options.shape === 'literal') {
      config.set(configKey, SECRET);
      continue;
    }
    if (options.shape === 'whitespace') {
      config.set(configKey, '   ');
      continue;
    }
    config.set(configKey, sweptReference(configKey));
    if (options.shape === 'swept') store.set(daemonSecretKeyFor(configKey), SECRET);
  }

  const binding = {
    id: 'binding-1',
    kind: 'channel',
    surfaceKind: 'test',
    surfaceId: 'surface-1',
    externalId: 'external-1',
    channelId: 'channel-1',
    threadId: undefined,
    title: 'title',
    metadata: {},
  };

  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      secretsManager: {
        get: async (key: string) => store.get(key) ?? null,
        getGlobalHome: () => '/nonexistent-home',
      },
      configManager: { get: (key: string) => config.get(key) },
      routeBindings: {
        upsertBinding: async (input: unknown) => {
          calls.push({ kind: 'upsertBinding', input });
          return binding;
        },
      },
      sessionBroker: {
        submitMessage: async (input: unknown) => {
          calls.push({ kind: 'submitMessage', input });
          return {
            mode: 'spawn',
            task: { prompt: 'hello' },
            session: { id: 'session-1' },
            routeBinding: binding,
          };
        },
        bindAgent: async () => {},
        findPreferredSession: async () => null,
        listSessions: () => [],
      },
      authorizeSurfaceIngress: async (input: unknown) => {
        calls.push({ kind: 'authorizeSurfaceIngress', input });
        return { allowed: true };
      },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return { id: 'agent-1' };
      },
      queueSurfaceReplyFromBinding: () => {},
      surfaceDeliveryEnabled: () => true,
      signWebhookPayload: (body: string, secret: string) => `sig:${secret}:${body.length}`,
      queueWebhookReply: () => {},
    } as never,
  };
}

/**
 * One adapter family's inbound call, parameterised by the secret the caller
 * presents. `authorized` is what "this request got past the credential check"
 * looks like for that adapter — never merely "not 401", because an adapter that
 * skips the check answers 200 for a request it never authenticated, and a test
 * asserting `not 401` would call that a pass.
 */
interface AdapterCase {
  readonly name: string;
  readonly configKeys: readonly string[];
  readonly extraConfig?: Record<string, unknown>;
  readonly call: (presented: string, context: never) => Promise<Response>;
}

const CASES: readonly AdapterCase[] = [
  {
    name: 'signal',
    configKeys: ['surfaces.signal.token'],
    call: (presented, context) => handleSignalSurfaceWebhook(new Request('http://localhost/signal', {
      method: 'POST',
      headers: { 'x-goodvibes-signal-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: '+15551234567', message: 'hello' }),
    }), context),
  },
  {
    name: 'imessage',
    configKeys: ['surfaces.imessage.token'],
    call: (presented, context) => handleIMessageSurfaceWebhook(new Request('http://localhost/imessage', {
      method: 'POST',
      headers: { 'x-goodvibes-imessage-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-1', message: 'hello' }),
    }), context),
  },
  {
    name: 'matrix',
    configKeys: ['surfaces.matrix.accessToken'],
    call: (presented, context) => handleMatrixSurfaceWebhook(new Request('http://localhost/matrix', {
      method: 'POST',
      headers: { 'x-goodvibes-matrix-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ event: { room_id: '!room:example.org', content: { body: 'hello' } } }),
    }), context),
  },
  {
    name: 'mattermost',
    configKeys: ['surfaces.mattermost.botToken'],
    call: (presented, context) => handleMattermostSurfaceWebhook(new Request('http://localhost/mattermost', {
      method: 'POST',
      headers: { 'x-goodvibes-mattermost-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: 'channel-1', text: 'hello' }),
    }), context),
  },
  {
    name: 'msteams',
    configKeys: ['surfaces.msteams.appPassword'],
    call: (presented, context) => handleMSTeamsSurfaceWebhook(new Request('http://localhost/msteams', {
      method: 'POST',
      headers: { 'x-goodvibes-msteams-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', text: 'hello', conversation: { id: 'conv-1' } }),
    }), context),
  },
  {
    name: 'bluebubbles',
    configKeys: ['surfaces.bluebubbles.password'],
    call: (presented, context) => handleBlueBubblesSurfaceWebhook(new Request('http://localhost/bluebubbles', {
      method: 'POST',
      headers: { 'x-goodvibes-bluebubbles-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { text: 'hello', chatGuid: 'chat-1', senderId: '+15551234567' } }),
    }), context),
  },
  {
    name: 'google-chat',
    configKeys: ['surfaces.googleChat.verificationToken'],
    call: (presented, context) => handleGoogleChatSurfaceWebhook(new Request('http://localhost/google-chat', {
      method: 'POST',
      headers: { 'x-goog-chat-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MESSAGE', space: { name: 'spaces/AAA' }, message: { text: 'hello' } }),
    }), context),
  },
  {
    name: 'ntfy',
    configKeys: ['surfaces.ntfy.token'],
    extraConfig: { 'surfaces.ntfy.enabled': true, 'surfaces.ntfy.agentTopic': 'agent-topic' },
    call: (presented, context) => handleNtfySurfaceWebhook(new Request('http://localhost/ntfy', {
      method: 'POST',
      headers: { 'x-ntfy-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'agent-topic', message: 'hello', id: crypto.randomUUID() }),
    }), context),
  },
  {
    name: 'telegram',
    configKeys: ['surfaces.telegram.webhookSecret'],
    call: (presented, context) => handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { text: 'hello', chat: { id: 42, type: 'private' } } }),
    }), context),
  },
  {
    name: 'telephony',
    configKeys: ['surfaces.telephony.webhookSecret'],
    call: (presented, context) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
      method: 'POST',
      headers: { 'x-goodvibes-telephony-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ from: '+15551234567', text: 'hello' }),
    }), context),
  },
  {
    name: 'whatsapp',
    configKeys: ['surfaces.whatsapp.signingSecret'],
    extraConfig: { 'surfaces.whatsapp.provider': 'bridge' },
    call: (presented, context) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
      method: 'POST',
      headers: { 'x-goodvibes-whatsapp-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ from: '+15551234567', text: { body: 'hello' } }] } }] }],
      }),
    }), context),
  },
  {
    name: 'webhook',
    configKeys: ['surfaces.webhook.secret'],
    extraConfig: { 'surfaces.webhook.enabled': true },
    call: (presented, context) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'x-goodvibes-webhook-secret': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }), context),
  },
];

/**
 * Did this request get past the credential check?
 *
 * Measured by whether it reached `authorizeSurfaceIngress` — the first thing
 * every one of these adapters does once the caller is authenticated — and NOT
 * by the status code. "Not 401" is the tempting definition and it is wrong in
 * both directions: an adapter that refuses a broken credential answers 503, and
 * a test reading 503 as "authorised" reports a surface that rejects everything
 * as working. That mistake made the raw-literal case here pass under a mutation
 * that rejected every literal.
 */
function reachedHandler(calls: ReadonlyArray<{ kind: string }>): boolean {
  return calls.some((call) => call.kind === 'authorizeSurfaceIngress');
}

describe('inbound surface adapters — a swept credential reference', () => {
  for (const adapter of CASES) {
    describe(adapter.name, () => {
      const build = (shape: ConfigShape) => makeContext({
        shape,
        configKeys: adapter.configKeys,
        ...(adapter.extraConfig ? { extraConfig: adapter.extraConfig } : {}),
      });

      test('authorises the right caller when config holds a swept reference', async () => {
        const harness = build('swept');
        const res = await adapter.call(SECRET, harness.context);
        expect(res.status).not.toBe(401);
        expect(reachedHandler(harness.calls)).toBe(true);
      });

      test('still authorises the right caller when config holds a raw literal', async () => {
        const harness = build('literal');
        const res = await adapter.call(SECRET, harness.context);
        expect(res.status).not.toBe(401);
        expect(reachedHandler(harness.calls)).toBe(true);
      });

      test('refuses a wrong secret against a swept reference', async () => {
        const harness = build('swept');
        const res = await adapter.call('not-the-secret', harness.context);
        expect(res.status).toBe(401);
        expect(reachedHandler(harness.calls)).toBe(false);
      });

      test('refuses rather than authorising when the credential is only whitespace', async () => {
        // A whitespace-only setting is a misconfiguration, not an unconfigured
        // surface. It must not be trimmed into indistinguishability from "no
        // credential set", which on the skip-when-empty adapters would mean no
        // check ran at all.
        const harness = build('whitespace');
        const res = await adapter.call('   ', harness.context);
        expect(res.status).toBe(503);
        expect(reachedHandler(harness.calls)).toBe(false);
      });

      test('refuses rather than authorising when the reference resolves to nothing', async () => {
        const context = build('swept-unresolvable');
        // Both the right secret and an empty one, because the bypass this
        // guards is an empty configured credential matched against an empty
        // presented one — which no "wrong secret" case would ever catch.
        const withSecret = await adapter.call(SECRET, context.context);
        const withNothing = await adapter.call('', build('swept-unresolvable').context);
        // 503, and specifically not 200: a broken credential is a
        // configuration fault, and the request must not reach anything behind
        // the check. Asserting "not 401" here would pass for an adapter that
        // skipped the comparison and answered 200.
        expect(withSecret.status).toBe(503);
        expect(withNothing.status).toBe(503);
        expect(await withSecret.json()).toMatchObject({ reason: 'credential-unresolvable' });
        // And nothing behind the credential check ran.
        expect(context.calls).toEqual([]);
      });
    });
  }
});
