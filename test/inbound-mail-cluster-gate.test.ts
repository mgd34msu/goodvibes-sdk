/**
 * inbound-mail-cluster-gate.test.ts
 *
 * Inbound mail as a leadership gate (docs/inbound-email.md §3.5), and the
 * registration hazard that sat directly above it.
 *
 * Why the gate exists: clustering defaults off, but when the owner opts in,
 * two nodes both holding a connection to one mailbox both fetch and both
 * notify — the same message announced twice, by a capability whose entire
 * value is being told exactly once.
 *
 * Why the second half of this file exists: `registerDaemonClusterSurfaces`
 * ended Telegram's registration with an early `return` at the top level of the
 * function, so anything registered AFTER Telegram was skipped on any machine
 * whose bot token failed to resolve. That is a condition which produces no
 * error and looks exactly like a healthy node, and the surface it would have
 * silenced is a mailbox. The registration is now per-surface, and the test
 * below is what stops the early `return` coming back.
 */
import { describe, expect, test } from 'bun:test';
import { registerDaemonClusterSurfaces } from '../packages/sdk/src/platform/daemon/facade-cluster.ts';
import { inboxSurface, surfaceIdFor } from '../packages/sdk/src/platform/cluster/surface-id.ts';
import type { ClusterConsumerGate } from '../packages/sdk/src/platform/cluster/types.ts';
import type { ClusterCoordinator } from '../packages/sdk/src/platform/cluster/index.ts';
import type {
  DaemonFacadeCollaborators,
  ResolvedDaemonFacadeRuntime,
} from '../packages/sdk/src/platform/daemon/facade-types.ts';
import { addNode, advance, createWorld, startNode } from './cluster-harness.ts';

// ---------------------------------------------------------------------------
// One node consumes a mailbox, and only one
// ---------------------------------------------------------------------------

describe('only one cluster node consumes a mailbox', () => {
  test('two nodes registering the same mailbox surface leave exactly one reading it', async () => {
    const world = createWorld();
    const surface = inboxSurface('email:primary:INBOX');
    const running = new Map<string, boolean>();

    const nodes = ['node-a', 'node-b'].map((id) => {
      const node = addNode(world, { id, surfaces: [] });
      running.set(id, false);
      node.registry.register({
        id: 'email-inbound',
        surface,
        start: async () => { running.set(id, true); },
        stop: async () => { running.set(id, false); },
      });
      return node;
    });

    for (const node of nodes) await startNode(world, node);
    await advance(world, 10_000);

    const readers = [...running.entries()].filter(([, on]) => on).map(([id]) => id);
    expect(readers).toHaveLength(1);
  });

  test('two mailboxes are two elections, not one', () => {
    // A node watching the signup alias must not stand down for a node watching
    // the owner's personal mailbox, so the discriminator carries both the
    // account and the mailbox.
    expect(surfaceIdFor(inboxSurface('email:primary:INBOX')))
      .not.toBe(surfaceIdFor(inboxSurface('email:primary:Signups')));
    expect(surfaceIdFor(inboxSurface('email:primary:INBOX')))
      .not.toBe(surfaceIdFor(inboxSurface('email:secondary:INBOX')));
  });
});

// ---------------------------------------------------------------------------
// Nothing registered after the telegram branch is skipped
// ---------------------------------------------------------------------------

interface Harness {
  readonly gates: ClusterConsumerGate[];
  readonly started: string[];
  readonly stopped: string[];
  register(): Promise<void>;
}

function harness(options: {
  readonly config: Record<string, unknown>;
  readonly telegramBotId: string | null;
  readonly mailbox: { readonly account: string; readonly mailbox: string } | null;
}): Harness {
  const gates: ClusterConsumerGate[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const coordinator = {
    register: (gate: ClusterConsumerGate) => { gates.push(gate); return () => {}; },
    reportConsumerConflict: () => {},
  } as unknown as ClusterCoordinator;
  const runtime = {
    configManager: { get: (key: string) => options.config[key] },
  } as unknown as ResolvedDaemonFacadeRuntime;
  const collaborators = {
    providerRuntime: {
      ntfyBaseUrl: () => 'https://ntfy.test',
      ntfyTopics: () => [],
      resolveSocketSurfaceIdentity: async () => null,
      setSocketLostHandler: () => {},
    },
    builtinChannels: {
      resolveServableTelegramBotId: async () => options.telegramBotId,
      setConsumerConflictHandler: () => {},
      inboundMailIdentity: () => options.mailbox,
      startInboundMail: async () => { started.push('email'); },
      stopInboundMail: async () => { stopped.push('email'); },
      startIngress: async () => { started.push('telegram'); },
      stopIngress: async () => { stopped.push('telegram'); },
    },
  } as unknown as DaemonFacadeCollaborators;
  return {
    gates,
    started,
    stopped,
    register: () => registerDaemonClusterSurfaces(coordinator, runtime, collaborators),
  };
}

const EMAIL_ON = {
  'surfaces.ntfy.enabled': false,
  'surfaces.slack.enabled': false,
  'surfaces.discord.enabled': false,
  'surfaces.telegram.enabled': true,
  'surfaces.email.inbound.enabled': true,
};

describe('the telegram inert branch cannot skip a later registration', () => {
  test('an unresolvable Telegram token still leaves the mailbox gate registered', async () => {
    const rig = harness({
      config: EMAIL_ON,
      // The exact condition the early `return` used to trigger on: the surface
      // is enabled and no bot token resolves, so Telegram is reported inert.
      telegramBotId: null,
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();

    expect(rig.gates.map((gate) => gate.id)).toEqual(['email-inbound']);
    expect(surfaceIdFor(rig.gates[0]!.surface)).toBe(surfaceIdFor(inboxSurface('email:primary:INBOX')));
  });

  test('both gates register when both surfaces are servable, and the mailbox one is last', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: '1234567',
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress', 'email-inbound']);
  });

  test('the mailbox gate drives the supervisor through the channel runtime', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: null,
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    const gate = rig.gates.find((entry) => entry.id === 'email-inbound')!;
    await gate.start({ replayFromMs: null, reason: 'won the election' });
    expect(rig.started).toEqual(['email']);
    await gate.stop('standing down');
    expect(rig.stopped).toEqual(['email']);
  });

  test('a node that watches no mailbox does not contest the surface', async () => {
    const rig = harness({
      config: EMAIL_ON,
      telegramBotId: '1234567',
      mailbox: null,
    });
    await rig.register();
    // Winning an election for a mailbox this node cannot read would stand every
    // other node down and then read nothing.
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
  });

  test('the mailbox gate is not registered when the surface is switched off', async () => {
    const rig = harness({
      config: { ...EMAIL_ON, 'surfaces.email.inbound.enabled': false },
      telegramBotId: '1234567',
      mailbox: { account: 'primary', mailbox: 'INBOX' },
    });
    await rig.register();
    expect(rig.gates.map((gate) => gate.id)).toEqual(['telegram-ingress']);
  });
});
