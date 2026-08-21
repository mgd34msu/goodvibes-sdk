/**
 * channel-session-classification.test.ts
 *
 * The owner's private Telegram chat produced a shared control-plane session
 * with `kind: 'tui'`, `project: '/home/buzzkill'`, and
 * `attributedPrincipalId: 'principal:unknown'`, a private chat classified as
 * an operator terminal session rooted at a filesystem project, and the owner
 * himself attributed as an unknown sender in his own chat even though the
 * channel's own ingress policy had already authorized him.
 *
 * These tests pin the fix at the session-classification layer:
 *
 *  - a channel-originated session (no explicit kind/project, the shape every
 *    channel adapter's submitMessage call has) is classified 'channel', with
 *    no filesystem project root, never 'tui' merely because that happens to
 *    be the daemon's process cwd;
 *  - the pre-existing product-surface paths (TUI/webui/agent, which pass kind
 *    explicitly) are completely unaffected;
 *  - a policy-authorized owner sender is attributed to the honest owner
 *    principal, never the unknown one, even absent a named-principal mapping;
 *  - a channel rollover (the bound session is unusable) re-derives
 *    classification from the incoming surface rather than defaulting to the
 *    same 'tui' bug on the successor;
 *  - an old-shape persisted record (missing `kind`, or carrying a kind this
 *    build doesn't know) loads without crashing or quarantine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.ts';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.ts';
import { ChannelPolicyManager } from '../packages/sdk/src/platform/channels/policy-manager.ts';
import {
  attributeInboundSession,
  installInboundIntakeEnrichment,
  ATTRIBUTED_PRINCIPAL_ID_KEY,
  ATTRIBUTED_PRINCIPAL_NAME_KEY,
  ATTRIBUTED_PRINCIPAL_KNOWN_KEY,
} from '../packages/sdk/src/platform/channel-profiles/index.ts';
import { PrincipalRegistry, PrincipalStore, UNKNOWN_PRINCIPAL_ID, OWNER_PRINCIPAL_ID } from '../packages/sdk/src/platform/principals/index.ts';
import { isChannelSurfaceKind } from '../packages/sdk/src/events/surfaces.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-channel-classify-'));
  scratchDirs.push(dir);
  return dir;
}

interface Harness {
  readonly broker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly notices: Array<{ routeId: string; text: string }>;
}

async function makeHarness(dir: string): Promise<Harness> {
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore(join(dir, 'automation-routes.json')),
  });
  await routeBindings.start();
  const notices: Array<{ routeId: string; text: string }> = [];
  const broker = disposables.add(new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
  broker.setSurfaceNoticeSender((routeId, text) => { notices.push({ routeId, text }); });
  return { broker, routeBindings, notices };
}

async function bindTelegram(routeBindings: RouteBindingManager): Promise<AutomationRouteBinding> {
  return routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'telegram',
    surfaceId: 'goodvibes_bot',
    externalId: '12345',
    channelId: '12345',
    title: 'Avery',
  });
}

function telegramSubmit(binding: AutomationRouteBinding, body: string, userId = '678') {
  return {
    routeId: binding.id,
    surfaceKind: 'telegram' as const,
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    userId,
    displayName: 'avery',
    title: binding.title ?? 'Telegram',
    body,
  };
}

describe('a channel-originated session is classified by its surface, not tui', () => {
  test('sanity: isChannelSurfaceKind treats telegram as a channel and tui/web/service as first-party', () => {
    expect(isChannelSurfaceKind('telegram')).toBe(true);
    expect(isChannelSurfaceKind('slack')).toBe(true);
    expect(isChannelSurfaceKind('tui')).toBe(false);
    expect(isChannelSurfaceKind('web')).toBe(false);
    expect(isChannelSurfaceKind('service')).toBe(false);
    expect(isChannelSurfaceKind(undefined)).toBe(false);
  });

  test('a fresh Telegram message creates a channel-kind session with no filesystem project root', async () => {
    const { broker, routeBindings } = await makeHarness(scratch());
    const binding = await bindTelegram(routeBindings);

    const submission = await broker.submitMessage(telegramSubmit(binding, 'hello from telegram'));

    expect(submission.session.kind).toBe('channel');
    expect(submission.session.project).toBe('unknown');
    expect(submission.session.surfaceKinds).toContain('telegram');
  });

  test('every channel surface classifies the same way — not a telegram special case', async () => {
    for (const surfaceKind of ['slack', 'discord', 'ntfy', 'signal', 'whatsapp'] as const) {
      const { broker } = await makeHarness(scratch());
      const session = await broker.createSession({
        participant: { surfaceKind, surfaceId: `surf:${surfaceKind}`, lastSeenAt: Date.now() },
      });
      expect(session.kind).toBe('channel');
      expect(session.project).toBe('unknown');
    }
  });

  test('an explicit kind from a product surface is never overridden', async () => {
    const { broker } = await makeHarness(scratch());
    const tuiSession = await broker.createSession({
      kind: 'tui',
      project: '/home/buzzkill/projects/goodvibes-tui',
      participant: { surfaceKind: 'tui', surfaceId: 'surf:tui', lastSeenAt: Date.now() },
    });
    expect(tuiSession.kind).toBe('tui');
    expect(tuiSession.project).toBe('/home/buzzkill/projects/goodvibes-tui');

    const webuiSession = await broker.createSession({
      kind: 'webui',
      participant: { surfaceKind: 'webui', surfaceId: 'surf:webui', lastSeenAt: Date.now() },
    });
    expect(webuiSession.kind).toBe('webui');
  });

  test('a session with no surface information at all keeps the legacy tui default', async () => {
    const { broker } = await makeHarness(scratch());
    const bare = await broker.createSession({});
    expect(bare.kind).toBe('tui');
  });
});

describe('a channel rollover re-derives classification from the surface, never blind-copies stale values', () => {
  test('rolling over a wrongly-classified legacy session lands a channel-kind, projectless successor', async () => {
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindTelegram(routeBindings);

    // The exact observed shape: a stale session wrongly stamped as a TUI
    // session rooted at the daemon's home directory, then closed (host died,
    // GC swept it, whatever). The binding still names it.
    const stale = await broker.createSession({
      id: 'sess-e354d678',
      kind: 'tui',
      project: '/home/buzzkill',
    });
    await routeBindings.patchBinding(binding.id, { sessionId: stale.id });
    await broker.closeSession(stale.id);

    const submission = await broker.submitMessage(telegramSubmit(binding, 'are you there?'));

    expect(submission.created).toBe(true);
    expect(submission.session.id).not.toBe('sess-e354d678');
    // Re-derived from the incoming surface, not copied from the stale record.
    expect(submission.session.kind).toBe('channel');
    expect(submission.session.project).toBe('unknown');
    expect(submission.session.metadata.rolledOverFromSessionId).toBe('sess-e354d678');
    // The predecessor is untouched history, its own wrong shape is not rewritten.
    expect(broker.getSession('sess-e354d678')?.kind).toBe('tui');
    expect(broker.getSession('sess-e354d678')?.project).toBe('/home/buzzkill');
    expect(notices).toHaveLength(1);
  });
});

describe('old-shape persisted session records load safely (no crash, no quarantine)', () => {
  test('a record with no kind field at all loads fine and keeps working', async () => {
    const dir = scratch();
    const storePath = join(dir, 'sessions.json');
    writeFileSync(storePath, JSON.stringify({
      sessions: [{
        id: 'legacy-no-kind',
        title: 'Legacy',
        status: 'active',
        surfaceKinds: ['telegram'],
        participants: [],
        metadata: {},
      }],
      messages: [],
      inputs: [],
    }));

    const broker = disposables.add(new SharedSessionBroker({
      storePath,
      routeBindings: { start: async () => {}, patchBinding: async () => null } as unknown as RouteBindingManager,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
    await broker.start();

    const loaded = broker.getSession('legacy-no-kind');
    expect(loaded).not.toBeNull();
    expect(loaded!.kind).toBe('tui'); // documented legacy fallback
    expect(loaded!.project).toBe('unknown');
  });

  test('a record carrying the NEW channel kind round-trips through persist+reload', async () => {
    const dir = scratch();
    const { broker } = await makeHarness(dir);
    await broker.createSession({
      id: 'k-channel',
      participant: { surfaceKind: 'telegram', surfaceId: 'surf:t', lastSeenAt: Date.now() },
    });
    await broker.stop();

    const reloaded = disposables.add(new SharedSessionBroker({
      storePath: join(dir, 'sessions.json'),
      routeBindings: { start: async () => {}, patchBinding: async () => null } as unknown as RouteBindingManager,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
    await reloaded.start();
    expect(reloaded.getSession('k-channel')?.kind).toBe('channel');
  });

  test('a record wrongly stamped tui for a telegram surface loads as-is — no crash, no silent rewrite', async () => {
    // The exact shape of the live defect: a persisted record whose `kind` is a
    // legitimately-known value ('tui') that is simply WRONG for what actually
    // created it (surfaceKinds says telegram). Loading it must not crash or
    // quarantine the store, and it must not be silently rewritten in place,
    // the fix is that the NEXT session a channel message lands in gets
    // classified correctly (see the rollover describe block above), not that
    // this file gets patched by a migration.
    const dir = scratch();
    const storePath = join(dir, 'sessions.json');
    writeFileSync(storePath, JSON.stringify({
      sessions: [{
        id: 'sess-e354d678',
        kind: 'tui',
        title: 'Telegram',
        status: 'active',
        project: '/home/buzzkill',
        surfaceKinds: ['telegram'],
        participants: [],
        metadata: { attributedPrincipalId: 'principal:unknown', attributedPrincipalKnown: false },
      }],
      messages: [],
      inputs: [],
    }));

    const broker = disposables.add(new SharedSessionBroker({
      storePath,
      routeBindings: { start: async () => {}, patchBinding: async () => null } as unknown as RouteBindingManager,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
    await expect(broker.start()).resolves.toBeUndefined();
    const loaded = broker.getSession('sess-e354d678');
    expect(loaded?.kind).toBe('tui');
    expect(loaded?.project).toBe('/home/buzzkill');
  });
});

describe('a channel-policy-authorized owner sender is attributed as the known owner, never unknown', () => {
  function makePolicy(): ChannelPolicyManager {
    const dir = scratch();
    return new ChannelPolicyManager({ storePath: join(dir, 'policies.json') });
  }

  test('attributeInboundSession: the seeded owner attributes to the owner principal, not unknown', async () => {
    const policy = makePolicy();
    // Channel policy self-seeds its owner allowlist from the first identified
    // sender, this IS "channel policy already authorized" for this userId.
    await policy.evaluateIngress({ surface: 'telegram', userId: '678', conversationKind: 'direct', text: 'hi' });

    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
    const result = await attributeInboundSession(principals, { surfaceKind: 'telegram', userId: '678' }, policy);

    expect(result.metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(OWNER_PRINCIPAL_ID);
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('owner');
    expect(result.resolution?.known).toBe(true);
  });

  test('a named-principal mapping still wins over the owner-allowlist fallback', async () => {
    const policy = makePolicy();
    await policy.evaluateIngress({ surface: 'telegram', userId: '678', conversationKind: 'direct', text: 'hi' });
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
    const avery = await principals.create({ name: 'Avery', kind: 'user', identities: [{ channel: 'telegram', value: '678' }] });

    const result = await attributeInboundSession(principals, { surfaceKind: 'telegram', userId: '678' }, policy);

    expect(result.metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(avery.id);
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('Avery');
  });

  test('a stranger not on the owner allowlist stays the honest unknown principal', async () => {
    const policy = makePolicy();
    await policy.evaluateIngress({ surface: 'telegram', userId: '678', conversationKind: 'direct', text: 'hi' });
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));

    const result = await attributeInboundSession(principals, { surfaceKind: 'telegram', userId: 'someone-else' }, policy);

    expect(result.metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
  });

  test('without a channelPolicy dependency, behavior is unchanged (unmapped stays unknown)', async () => {
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
    const result = await attributeInboundSession(principals, { surfaceKind: 'telegram', userId: '678' });
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(result.metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
  });

  test('wired end-to-end: submitMessage from the policy-seeded owner originates a session attributed to the owner', async () => {
    const policy = makePolicy();
    await policy.evaluateIngress({ surface: 'telegram', userId: '678', conversationKind: 'direct', text: 'hi' });
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));

    const dir = scratch();
    const { broker, routeBindings } = await makeHarness(dir);
    const binding = await bindTelegram(routeBindings);
    installInboundIntakeEnrichment(broker, { principals, channelProfiles: { resolve: async () => null }, channelPolicy: policy });

    const submission = await broker.submitMessage(telegramSubmit(binding, 'it is me'));

    const meta = submission.session.metadata ?? {};
    expect(meta[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(meta[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(OWNER_PRINCIPAL_ID);
    // And the classification fix holds through the same wired path.
    expect(submission.session.kind).toBe('channel');
    expect(submission.session.project).toBe('unknown');
  });
});

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
