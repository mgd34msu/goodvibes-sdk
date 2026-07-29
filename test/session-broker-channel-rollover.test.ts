/**
 * session-broker-channel-rollover.test.ts
 *
 * The owner's Telegram chat went silent for a day. A route binding
 * (`sessionPolicy: 'create-or-bind'`) named a shared session that had been
 * closed when its host was killed. Every inbound message then resolved to that
 * closed record and hit the guard in session-broker-intent.ts, which threw
 * SESSION_CLOSED/409 — correct for an HTTP caller that named a session id, and
 * wrong for a channel, where nothing on the far side can read a 409 and open a
 * new chat. The Telegram poller caught it, logged "advancing past it", and
 * advanced its cursor. Two of his messages were eaten outright.
 *
 * The fix treats a binding's `sessionId` as a routing HINT that is validated on
 * every resolve and healed when its target is unusable — for ANY reason, not
 * just closure. These tests pin all of it:
 *
 *  - the observed scenario (closed) rolls over, rebinds and lands the message;
 *  - the rebind survives a restart, because it went through the store;
 *  - a MISSING target rolls over too — the shape a node sees after a surface
 *    election or a restore from backup, since sessions do not replicate;
 *  - a caller that NAMED a closed session id still gets its 409, so the fix
 *    cannot widen into the webui companion's contract;
 *  - a binding whose policy says it may not be re-pointed keeps the 409.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.ts';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.ts';
import type { AutomationSessionPolicy } from '../packages/sdk/src/platform/automation/types.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-rollover-'));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly broker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly notices: Array<{ routeId: string; text: string }>;
}

/** A broker whose route bindings are REAL and durable, so a rebind can be reloaded. */
async function makeHarness(dir: string): Promise<Harness> {
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore(join(dir, 'automation-routes.json')),
  });
  await routeBindings.start();
  const notices: Array<{ routeId: string; text: string }> = [];
  const broker = disposables.add(new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings,
    agentStatusProvider: { getStatus: () => null }, // never a live agent to hand over to
    messageSender: { send: () => false },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
  broker.setSurfaceNoticeSender((routeId, text) => { notices.push({ routeId, text }); });
  return { broker, routeBindings, notices };
}

/** The exact submit shape `processTelegramUpdate` builds: a route, never a session id. */
function channelSubmit(binding: AutomationRouteBinding, body: string) {
  return {
    routeId: binding.id,
    surfaceKind: 'telegram' as const,
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: '678',
    displayName: 'mike',
    title: binding.title ?? 'Telegram',
    body,
  };
}

async function bindChat(
  routeBindings: RouteBindingManager,
  sessionPolicy?: AutomationSessionPolicy,
): Promise<AutomationRouteBinding> {
  return routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'telegram',
    surfaceId: 'goodvibes_bot',
    externalId: '12345',
    channelId: '12345',
    title: 'Mike',
    ...(sessionPolicy ? { sessionPolicy } : {}),
  });
}

async function caught(fn: () => Promise<unknown>): Promise<{ code?: string; status?: number } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err as { code?: string; status?: number };
  }
}

describe('a channel whose bound session was closed rolls over instead of black-holing', () => {
  test('the observed scenario: the message lands in a NEW session and the route is rebound', async () => {
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindChat(routeBindings);
    // `create-or-bind` is what upsertBinding writes by default — the policy the
    // owner's own route carried, and the one that promises this rollover.
    expect(binding.sessionPolicy).toBe('create-or-bind');

    const dead = await broker.createSession({ id: 'sess-4ca358a3' });
    await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
    await broker.closeSession(dead.id);

    const submission = await broker.submitMessage(channelSubmit(binding, 'are you there?'));

    // A NEW session, not the closed one, and not a resurrection of it.
    expect(submission.created).toBe(true);
    expect(submission.session.id).not.toBe('sess-4ca358a3');
    expect(submission.session.status).toBe('active');
    // The message actually landed.
    const landed = broker.getMessages(submission.session.id);
    expect(landed.map((m) => m.body)).toContain('are you there?');
    // The closed session stays exactly as it was: history, not a dumping ground.
    expect(broker.getSession('sess-4ca358a3')?.status).toBe('closed');
    expect(broker.getMessages('sess-4ca358a3')).toHaveLength(0);
    // The route now points at the successor.
    expect(routeBindings.getBinding(binding.id)?.sessionId).toBe(submission.session.id);
    // The successor NAMES its predecessor rather than absorbing it.
    expect(submission.session.metadata.rolledOverFromSessionId).toBe('sess-4ca358a3');
    // And the person on the other end is told why the thread reset.
    expect(notices).toHaveLength(1);
    expect(notices[0]?.routeId).toBe(binding.id);
    expect(notices[0]?.text).toContain('fresh conversation');
    expect(notices[0]?.text).toContain('closed');
  });

  test('the rebind is durable: a restarted broker resolves the same successor', async () => {
    const dir = scratch();
    const first = await makeHarness(dir);
    const binding = await bindChat(first.routeBindings);
    const dead = await first.broker.createSession({ id: 'sess-restart' });
    await first.routeBindings.patchBinding(binding.id, { sessionId: dead.id });
    await first.broker.closeSession(dead.id);
    const rolled = await first.broker.submitMessage(channelSubmit(binding, 'first after the close'));
    await first.broker.stop();

    // Fresh stores over the SAME files — the restart.
    const second = await makeHarness(dir);
    expect(second.routeBindings.getBinding(binding.id)?.sessionId).toBe(rolled.session.id);

    const again = await second.broker.submitMessage(
      channelSubmit(second.routeBindings.getBinding(binding.id)!, 'second after the restart'),
    );
    // Same session as before the restart, and no second rollover.
    expect(again.session.id).toBe(rolled.session.id);
    expect(again.created).toBe(false);
    expect(second.notices).toHaveLength(0);
    expect(second.broker.getMessages(rolled.session.id).map((m) => m.body))
      .toEqual(['first after the close', 'second after the restart']);
  });

  test('a binding naming a session this node has never held rolls over cleanly', async () => {
    // The shape a node sees after a surface election or a restore from backup:
    // sessions are node-local (`~/.goodvibes/control-plane/sessions.json`) and
    // the cluster layer replicates config and secrets, never sessions. So the
    // only observable is a binding naming a session that is simply not here.
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindChat(routeBindings);
    await routeBindings.patchBinding(binding.id, { sessionId: 'sess-held-on-another-node' });

    const submission = await broker.submitMessage(channelSubmit(binding, 'after the promotion'));

    expect(submission.created).toBe(true);
    expect(submission.session.status).toBe('active');
    expect(broker.getMessages(submission.session.id).map((m) => m.body)).toContain('after the promotion');
    expect(routeBindings.getBinding(binding.id)?.sessionId).toBe(submission.session.id);
    expect(submission.session.metadata.rolledOverFromSessionId).toBe('sess-held-on-another-node');
    expect(notices[0]?.text).toContain('not in this node');
  });

  test('a brand-new chat is NOT announced as a rollover — nothing was lost', async () => {
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindChat(routeBindings);
    expect(binding.sessionId).toBeUndefined();

    const submission = await broker.submitMessage(channelSubmit(binding, 'hello for the first time'));

    expect(submission.created).toBe(true);
    expect(submission.session.metadata.rolledOverFromSessionId).toBeUndefined();
    expect(notices).toHaveLength(0);
  });

  test('steer and follow-up over a channel heal the same way submit does', async () => {
    for (const intent of ['steer', 'follow-up'] as const) {
      const { broker, routeBindings } = await makeHarness(scratch());
      const binding = await bindChat(routeBindings);
      const dead = await broker.createSession({ id: `sess-${intent}` });
      await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
      await broker.closeSession(dead.id);

      const submission = intent === 'steer'
        ? await broker.steerMessage(channelSubmit(binding, `${intent} over a channel`))
        : await broker.followUpMessage(channelSubmit(binding, `${intent} over a channel`));

      expect(submission.session.id).not.toBe(`sess-${intent}`);
      expect(submission.session.status).toBe('active');
      expect(broker.getMessages(submission.session.id).map((m) => m.body))
        .toContain(`${intent} over a channel`);
    }
  });
});

describe('the healing does not widen past channel-bound resolution', () => {
  test('a caller that NAMES a closed session id still gets SESSION_CLOSED/409', async () => {
    // The webui companion depends on exactly this: it reads the 409 and opens a
    // new chat itself (companion-chat-routes.ts). A caller that addressed one
    // specific record asked about THAT record.
    const { broker } = await makeHarness(scratch());
    await broker.createSession({ id: 'sess-named-directly' });
    await broker.closeSession('sess-named-directly');

    const err = await caught(() => broker.submitMessage({
      sessionId: 'sess-named-directly',
      surfaceKind: 'web',
      surfaceId: 'surface:web',
      body: 'submit into a closed session by id',
    }));

    expect(err?.code).toBe('SESSION_CLOSED');
    expect(err?.status).toBe(409);
    expect(broker.getMessages('sess-named-directly')).toHaveLength(0);
  });

  test('naming a closed session id keeps the 409 even when a route binding also exists', async () => {
    // The sharp edge: both a binding AND an explicit sessionId. The explicit id
    // wins, because it is the more specific statement of intent.
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindChat(routeBindings);
    const dead = await broker.createSession({ id: 'sess-both' });
    await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
    await broker.closeSession(dead.id);

    const err = await caught(() => broker.submitMessage({
      ...channelSubmit(binding, 'named the closed id explicitly'),
      sessionId: 'sess-both',
    }));

    expect(err?.code).toBe('SESSION_CLOSED');
    expect(err?.status).toBe(409);
    expect(routeBindings.getBinding(binding.id)?.sessionId).toBe('sess-both');
    expect(notices).toHaveLength(0);
  });

  test.each(['continue-existing', 'require-existing'] as const)(
    'a binding whose policy is %s is not re-pointed; the honest error stands',
    async (sessionPolicy) => {
      const { broker, routeBindings, notices } = await makeHarness(scratch());
      const binding = await bindChat(routeBindings, sessionPolicy);
      expect(binding.sessionPolicy).toBe(sessionPolicy);
      const dead = await broker.createSession({ id: `sess-${sessionPolicy}` });
      await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
      await broker.closeSession(dead.id);

      const err = await caught(() => broker.submitMessage(channelSubmit(binding, 'policy says do not move me')));

      expect(err?.code).toBe('SESSION_CLOSED');
      expect(err?.status).toBe(409);
      expect(routeBindings.getBinding(binding.id)?.sessionId).toBe(`sess-${sessionPolicy}`);
      expect(notices).toHaveLength(0);
    },
  );

  test('an ACTIVE bound session is untouched — no rollover, no notice, same session', async () => {
    const { broker, routeBindings, notices } = await makeHarness(scratch());
    const binding = await bindChat(routeBindings);
    const live = await broker.createSession({ id: 'sess-live' });
    await routeBindings.patchBinding(binding.id, { sessionId: live.id });

    const submission = await broker.submitMessage(channelSubmit(binding, 'business as usual'));

    expect(submission.session.id).toBe('sess-live');
    expect(submission.created).toBe(false);
    expect(notices).toHaveLength(0);
  });

  test('a host that wired no notice sender still rolls over — the explanation is optional, the healing is not', async () => {
    const dir = scratch();
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(dir, 'automation-routes.json')),
    });
    await routeBindings.start();
    const broker = disposables.add(new SharedSessionBroker({
      store: new PersistentStore<never>(':memory:' as string),
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
    const binding = await bindChat(routeBindings);
    const dead = await broker.createSession({ id: 'sess-no-notice' });
    await routeBindings.patchBinding(binding.id, { sessionId: dead.id });
    await broker.closeSession(dead.id);

    const submission = await broker.submitMessage(channelSubmit(binding, 'no notice path here'));

    expect(submission.session.id).not.toBe('sess-no-notice');
    expect(broker.getMessages(submission.session.id).map((m) => m.body)).toContain('no notice path here');
  });
});
