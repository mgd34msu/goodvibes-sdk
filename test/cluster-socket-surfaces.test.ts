/**
 * Socket surfaces — contesting Slack and Discord under their REAL identity.
 *
 * These two are the awkward pair: what a token reads is not in the config, it
 * is a fact the provider reports. The shortcut — every node contesting one
 * "Slack surface" under a fixed placeholder — is a starvation bug. Two nodes
 * configured for two DIFFERENT workspaces would contest a single election, the
 * loser's workspace would go unanswered, and nothing anywhere would say why.
 * That silence is what per-surface elections exist to remove, so it must not
 * come back through the naming.
 *
 * The identity is resolved through an authenticated REST call that opens no
 * socket and consumes no events, so a surface is contested under its true name
 * from the first datagram and there is never a window in which a node reads a
 * workspace it has not won.
 */
import { describe, expect, test } from 'bun:test';
import { SocketSurfaceSupervisor } from '../packages/sdk/src/platform/daemon/facade-cluster-sockets.js';
import { providerSurface, surfaceIdFor } from '../packages/sdk/src/platform/cluster/surface-id.js';
import type { ClusterSurfaceKey } from '../packages/sdk/src/platform/cluster/surface-id.js';
import {
  addNode,
  advance,
  createWorld,
  flush,
  holders,
  registerSurface,
  roleOf,
  startNode,
  surfaceState,
} from './cluster-harness.js';

const QUIET = { info: () => {}, debug: () => {} };

/** A controllable stand-in for the daemon's registration and retry plumbing. */
function harness(options: {
  readonly identities: (string | null)[];
  readonly running?: () => boolean;
}) {
  const registered: ClusterSurfaceKey[] = [];
  const withdrawn: ClusterSurfaceKey[] = [];
  const inert: { surface: string; action: string }[] = [];
  let pending: (() => void) | null = null;
  const queue = [...options.identities];
  const supervisor = new SocketSurfaceSupervisor({
    kind: 'slack',
    resolveIdentity: async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? null),
    register: (surface) => {
      registered.push(surface);
      return () => { withdrawn.push(surface); };
    },
    isRunning: options.running ?? (() => true),
    reportInert: (surface, action) => { inert.push({ surface, action }); },
    logger: QUIET,
    setTimer: (fn) => { pending = fn; return () => { pending = null; }; },
    retryMs: 1_000,
  });
  return {
    supervisor,
    registered,
    withdrawn,
    inert,
    /** Fire the pending retry, if one is scheduled. */
    async retry(): Promise<void> {
      const fire = pending;
      pending = null;
      fire?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    hasRetry: (): boolean => pending !== null,
  };
}

describe('socket surfaces — the identity must be real', () => {
  test('the surface is contested under the identity the provider reported', async () => {
    const rig = harness({ identities: ['T0ACME999'] });
    await rig.supervisor.begin();

    expect(rig.registered).toEqual([providerSurface('slack', 'T0ACME999')]);
    expect(rig.inert).toEqual([]);
    expect(rig.supervisor.contestedSurface).toEqual(providerSurface('slack', 'T0ACME999'));
  });

  test('two different workspaces are two different surfaces, not one', () => {
    const acme = surfaceIdFor(providerSurface('slack', 'T0ACME999'));
    const other = surfaceIdFor(providerSurface('slack', 'T0OTHER11'));
    // If these collided, one of the two workspaces would lose an election it
    // was never in and go unanswered.
    expect(acme).not.toBe(other);
    // And the workspace id itself never reaches the wire.
    expect(acme).toMatch(/^[0-9a-f]{32}$/);
    expect(acme).not.toContain('ACME');
  });

  test('a node that cannot identify the surface registers nothing and says why', async () => {
    const rig = harness({ identities: [null] });
    await rig.supervisor.begin();

    // Nothing registered means nothing contested, which is the only way to be
    // sure this node cannot win a workspace it cannot read.
    expect(rig.registered).toEqual([]);
    expect(rig.supervisor.contestedSurface).toBeNull();
    expect(rig.inert).toHaveLength(1);
    expect(rig.inert[0]?.surface).toBe('slack');
    expect(rig.inert[0]?.action).toContain('will not contest');
    // It keeps trying: a provider outage ends, and a node that gave up for
    // good would leave the workspace unread once every other node went away.
    expect(rig.hasRetry()).toBe(true);
  });

  test('an identity that resolves on a later attempt is then contested', async () => {
    const rig = harness({ identities: [null, 'T0LATE777'] });
    await rig.supervisor.begin();
    expect(rig.registered).toEqual([]);

    await rig.retry();
    expect(rig.registered).toEqual([providerSurface('slack', 'T0LATE777')]);
  });

  test('a lost socket withdraws the surface, and it is taken up again on retry', async () => {
    const rig = harness({ identities: ['T0ACME999'] });
    await rig.supervisor.begin();
    expect(rig.registered).toHaveLength(1);

    rig.supervisor.onSocketLost('the Slack Socket Mode connection closed');
    // Withdrawing runs the registry's ordered stand-down: the consumer stops,
    // then the resignation goes out, so another machine can take the workspace
    // at once instead of waiting out the crash timeout.
    expect(rig.withdrawn).toEqual([providerSurface('slack', 'T0ACME999')]);

    await rig.retry();
    expect(rig.registered).toHaveLength(2);
  });

  test('a socket lost while the daemon is shutting down does not re-register', async () => {
    let running = true;
    const rig = harness({ identities: ['T0ACME999'], running: () => running });
    await rig.supervisor.begin();
    running = false;
    rig.supervisor.onSocketLost('closed');
    await rig.retry();
    expect(rig.registered).toHaveLength(1);
  });

  test('disposing withdraws the surface and stops the retries', async () => {
    const rig = harness({ identities: [null] });
    await rig.supervisor.begin();
    expect(rig.hasRetry()).toBe(true);
    rig.supervisor.dispose();
    expect(rig.hasRetry()).toBe(false);
    await rig.retry();
    expect(rig.registered).toEqual([]);
  });
});

describe('socket surfaces — in a live group', () => {
  test('two workspaces on one group elect independently and BOTH are consumed', async () => {
    const world = createWorld();
    // Two machines, each holding a token for a DIFFERENT Slack workspace.
    const acme = addNode(world, { id: 'node-acme', surfaces: ['slack-T0ACME999'] });
    const other = addNode(world, { id: 'node-other', surfaces: ['slack-T0OTHER11'] });
    await startNode(world, acme);
    await startNode(world, other);
    await advance(world, 4_000);

    // Under a placeholder identity these two would have contested one election
    // and one workspace would be unread. Under real identities both are read.
    expect(surfaceState(acme, 'slack-T0ACME999').running).toBe(true);
    expect(surfaceState(other, 'slack-T0OTHER11').running).toBe(true);
    // And neither is in the other's election at all.
    expect(roleOf(acme, 'slack-T0OTHER11')).toBe('stopped');
    expect(roleOf(other, 'slack-T0ACME999')).toBe('stopped');
  });

  test('two nodes on the SAME workspace still settle on exactly one reader', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a', surfaces: ['slack-T0ACME999'] });
    const second = addNode(world, { id: 'node-b', surfaces: ['slack-T0ACME999'] });
    await startNode(world, first);
    await startNode(world, second);
    await advance(world, 4_000);

    expect(holders(world, 'slack-T0ACME999')).toHaveLength(1);
  });

  test('a node that identifies its workspace LATER stands by rather than double-reading', async () => {
    const world = createWorld();
    const early = addNode(world, { id: 'node-early', surfaces: ['slack-T0ACME999'] });
    // This node's identity lookup was slow — a provider hiccup — so it joins
    // the election minutes after the other node already took the workspace.
    const late = addNode(world, { id: 'node-late', surfaces: [] });
    await startNode(world, early);
    await startNode(world, late);
    await advance(world, 4_000);
    expect(surfaceState(early, 'slack-T0ACME999').running).toBe(true);

    world.events.length = 0;
    registerSurface(world, late, 'slack-T0ACME999');
    await advance(world, 2_000);

    // The sitting holder answers the newcomer's probe, so the newcomer stands
    // by. There is no window in which both are reading the workspace.
    expect(roleOf(late, 'slack-T0ACME999')).toBe('standby');
    expect(surfaceState(late, 'slack-T0ACME999').running).toBe(false);
    expect(surfaceState(late, 'slack-T0ACME999').startCount).toBe(0);
    expect(holders(world, 'slack-T0ACME999')).toEqual([early]);
    // And the holder was not disturbed by the arrival.
    expect(surfaceState(early, 'slack-T0ACME999').stopCount).toBe(0);
  });

  test('a holder that loses its socket stands down and the other node takes over', async () => {
    const world = createWorld();
    const first = addNode(world, { id: 'node-a', surfaces: ['slack-T0ACME999'] });
    const second = addNode(world, { id: 'node-b', surfaces: ['slack-T0ACME999'] });
    await startNode(world, first);
    await startNode(world, second);
    await advance(world, 4_000);

    const [holder] = holders(world, 'slack-T0ACME999');
    expect(holder).toBeDefined();
    const standby = holder === first ? second : first;
    await flush(world);

    world.events.length = 0;
    // The socket dropped: the supervisor withdraws the gate, which is exactly
    // what this does.
    holder!.unregister.get('slack-T0ACME999')?.();
    await advance(world, 3_000);

    const stopped = world.events.indexOf(`${holder!.id}:slack-T0ACME999:consumers-stop`);
    const resigned = world.events.indexOf(`${holder!.id}:slack-T0ACME999:send:RESIGN`);
    const started = world.events.indexOf(`${standby.id}:slack-T0ACME999:consumers-start`);
    expect(stopped).toBeGreaterThanOrEqual(0);
    // Ordered even here: it stops reading, THEN says so, and only then does
    // the other machine begin.
    expect(resigned).toBeGreaterThan(stopped);
    expect(started).toBeGreaterThan(resigned);
    expect(surfaceState(standby, 'slack-T0ACME999').running).toBe(true);
    // The node that lost its socket holds nothing it cannot serve.
    expect(roleOf(holder!, 'slack-T0ACME999')).toBe('stopped');
  });
});
