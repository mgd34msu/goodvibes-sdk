/**
 * cluster-config-replication.test.ts — the settings that cross the network, and
 * the ones that must never.
 *
 * The first describe block is the important one. A replicated port would give
 * every machine in the group the same port and the second one to start would
 * fail to bind — so the policy is asserted exhaustively rather than by example,
 * and a daemon-owned domain nobody has ruled on fails the test rather than
 * quietly defaulting either way.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import {
  addGroupNode,
  advanceStepped,
  createGroupWorld,
  destroyGroupWorld,
  resolveWithClock,
  settle,
  stopGroupWorld,
  wireText,
  type GroupTestWorld,
} from './cluster-group-harness.js';
import { createGroup, groupStatus, joinGroup } from '../packages/sdk/src/platform/cluster/group-operations.js';
import {
  classifyDaemonConfigPath,
  isPortConfigKey,
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listDaemonConfigClassifications,
  listReplicatedConfigPaths,
  NODE_LOCAL_CONFIG_DOMAINS,
  replicatedSecretKeyFor,
  REPLICATED_CONFIG_DOMAINS,
} from '../packages/sdk/src/platform/cluster/config-replication-policy.js';
import {
  createConfigReplicaDocument,
  deleteReplicaEntry,
  findReplicaEntry,
  mergeConfigReplica,
  putReplicaEntry,
  readConfigReplicaDocument,
  sweepConfigReplica,
  CONFIG_TOMBSTONE_MAX_AGE_MS,
  MAX_REPLICATED_TOMBSTONES,
  MAX_REPLICATED_VALUE_BYTES,
} from '../packages/sdk/src/platform/cluster/config-replica.js';
import { listDaemonOwnedConfigPaths } from '../packages/sdk/src/platform/config/config-ownership.js';

/**
 * Real replicated paths, taken from the policy itself.
 *
 * Deliberately not literals: the policy is derived from CONFIG_SCHEMA, so a
 * made-up path is refused (correctly) and a test using one would prove nothing.
 */
const REPLICATED_PATHS = listReplicatedConfigPaths();
const PATH_A = REPLICATED_PATHS.find((path) => path.startsWith('conversationGate.')) ?? REPLICATED_PATHS[0] ?? '';
const PATH_B = REPLICATED_PATHS.find((path) => path.startsWith('automation.') && path !== PATH_A)
  ?? REPLICATED_PATHS[1] ?? '';
const SECRET_PATH = REPLICATED_PATHS.find((path) => path.startsWith('surfaces.')) ?? PATH_A;

let world: GroupTestWorld | null = null;

afterEach(async () => {
  if (world) {
    await stopGroupWorld(world);
    destroyGroupWorld(world);
    world = null;
  }
});

describe('what may cross the network', () => {
  test('every daemon-owned path is ruled on, one way or the other', () => {
    // The point of this test: a NEW daemon-owned domain must not slip in
    // unclassified. `classifyDaemonConfigPath` fails closed, so an unruled
    // domain lands as node-local with the "no ruling" reason — which this test
    // reports by name so it is fixed deliberately rather than discovered later.
    const unruled = listDaemonConfigClassifications()
      .filter((entry) => entry.reason.startsWith('no ruling'))
      .map((entry) => entry.path);
    expect(unruled, `these daemon-owned paths need a ruling in config-replication-policy.ts: ${unruled.join(', ')}`)
      .toEqual([]);
  });

  test('nothing outside the daemon-owned set can replicate, whatever the domain lists say', () => {
    const daemonOwned = new Set<string>(listDaemonOwnedConfigPaths());
    for (const path of listReplicatedConfigPaths()) expect(daemonOwned.has(path)).toBe(true);
    // Client and user preferences are unreachable by construction.
    expect(isReplicatedConfigPath('display.stream')).toBe(false);
    expect(isReplicatedConfigPath('provider.model')).toBe(false);
    expect(isReplicatedConfigPath('tts.voice')).toBe(false);
    expect(isReplicatedConfigPath('daemon.enabled')).toBe(false);
  });

  test('no port replicates, wherever it lives', () => {
    const ports = listDaemonOwnedConfigPaths().filter((path) => isPortConfigKey(path));
    expect(ports.length).toBeGreaterThan(0);
    for (const path of ports) {
      expect(isReplicatedConfigPath(path), `${path} is a port and must not replicate`).toBe(false);
      expect(classifyDaemonConfigPath(path).reason).toContain('port');
    }
    // The live case that motivated the rule.
    expect(isReplicatedConfigPath('controlPlane.port')).toBe(false);
  });

  test('machine-specific domains do not replicate', () => {
    for (const domain of NODE_LOCAL_CONFIG_DOMAINS) {
      const paths = listDaemonOwnedConfigPaths().filter((path) => path.startsWith(domain));
      for (const path of paths) {
        expect(isReplicatedConfigPath(path), `${path} is machine-specific`).toBe(false);
      }
    }
    // Cluster transport identity in particular: replicating any of it would
    // either partition the group or switch a machine on that was left off.
    expect(isReplicatedConfigPath('cluster.enabled')).toBe(false);
    expect(isReplicatedConfigPath('cluster.multicastGroup')).toBe(false);
    expect(isReplicatedConfigPath('cluster.peers')).toBe(false);
  });

  test('group-scoped domains do replicate, so failover is not theatre', () => {
    const replicated = listReplicatedConfigPaths();
    expect(replicated.length).toBeGreaterThan(0);
    for (const path of replicated) {
      expect(REPLICATED_CONFIG_DOMAINS.some((domain) => path.startsWith(domain))).toBe(true);
    }
    expect(replicated.some((path) => path.startsWith('surfaces.'))).toBe(true);
  });

  test('the only secrets that replicate are the ones a replicated path names', () => {
    for (const path of listReplicatedConfigPaths()) {
      expect(isReplicatedSecretKey(replicatedSecretKeyFor(path))).toBe(true);
    }
    // The group's own key material has no config path that derives it, so it
    // cannot be selected — which is the property that keeps it off the wire.
    expect(isReplicatedSecretKey('cluster.groupMaterial')).toBe(false);
    expect(isReplicatedSecretKey(replicatedSecretKeyFor('cluster.secret'))).toBe(false);
    expect(isReplicatedSecretKey('GOODVIBES_ANTHROPIC_API_KEY')).toBe(false);
  });

  test('the secret name derivation matches the platform-wide one', () => {
    // Same rule as buildGoodVibesSecretKey; a TUI-side test pins the other half.
    expect(replicatedSecretKeyFor('surfaces.slack.botToken')).toBe('GOODVIBES_SURFACES_SLACK_BOT_TOKEN');
    expect(replicatedSecretKeyFor('surfaces.ntfy.topic')).toBe('GOODVIBES_SURFACES_NTFY_TOPIC');
  });
});

describe('ordering without a clock', () => {
  const base = (): ReturnType<typeof createConfigReplicaDocument> => createConfigReplicaDocument('gTEST');

  test('the higher revision wins, even when its wall clock is older', () => {
    // The machine with the fast clock must not win: only the revision counts.
    let document = putReplicaEntry(base(), { path: 'surfaces.a', value: 1, origin: 'node-a', at: 9_000_000 });
    document = putReplicaEntry(document, { path: 'surfaces.a', value: 2, origin: 'node-b', at: 1 });
    expect(findReplicaEntry(document, 'surfaces.a')?.value).toBe(2);
  });

  test('a delete survives a merge with a copy that never heard about it', () => {
    const withEntry = putReplicaEntry(base(), { path: 'surfaces.a', value: 1, origin: 'node-a', at: 1_000 });
    const deleted = deleteReplicaEntry(withEntry, { path: 'surfaces.a', origin: 'node-a', at: 2_000 });
    // The other side of the partition still has the entry at its old revision.
    expect(mergeConfigReplica(deleted, withEntry).entries).toHaveLength(0);
    expect(mergeConfigReplica(withEntry, deleted).entries).toHaveLength(0);
    expect(mergeConfigReplica(withEntry, deleted).tombstones[0]?.path).toBe('surfaces.a');
  });

  test('a deliberate re-write after a delete wins, because it is at a higher revision', () => {
    const deleted = deleteReplicaEntry(
      putReplicaEntry(base(), { path: 'surfaces.a', value: 1, origin: 'node-a', at: 1_000 }),
      { path: 'surfaces.a', origin: 'node-a', at: 2_000 },
    );
    const rewritten = putReplicaEntry(deleted, { path: 'surfaces.a', value: 3, origin: 'node-a', at: 3_000 });
    expect(findReplicaEntry(mergeConfigReplica(rewritten, deleted), 'surfaces.a')?.value).toBe(3);
    expect(findReplicaEntry(mergeConfigReplica(deleted, rewritten), 'surfaces.a')?.value).toBe(3);
  });

  test('an equal revision is settled the same way on both sides', () => {
    // Only a two-master partition produces this. Whatever it resolves to, both
    // sides must resolve to the SAME thing or they never converge.
    const left = putReplicaEntry(base(), { path: 'surfaces.a', value: 'from-a', origin: 'node-a', at: 1 });
    const right = putReplicaEntry(base(), { path: 'surfaces.a', value: 'from-b', origin: 'node-b', at: 2 });
    const oneWay = mergeConfigReplica(left, right);
    const otherWay = mergeConfigReplica(right, left);
    expect(findReplicaEntry(oneWay, 'surfaces.a')?.value).toEqual(findReplicaEntry(otherWay, 'surfaces.a')?.value);
    expect(findReplicaEntry(oneWay, 'surfaces.a')?.origin).toBe('node-a');
  });

  test('a delete beats a write at the same revision', () => {
    const written = putReplicaEntry(base(), { path: 'surfaces.a', value: 1, origin: 'node-b', at: 1 });
    const removed = deleteReplicaEntry(base(), { path: 'surfaces.a', origin: 'node-a', at: 1 });
    expect(mergeConfigReplica(written, removed).entries).toHaveLength(0);
    expect(mergeConfigReplica(removed, written).entries).toHaveLength(0);
  });
});

describe('bounds and validation', () => {
  test('an unreplicable path in an incoming document is dropped on arrival', () => {
    // A peer running a modified build does not get to decide what this machine
    // applies to its own config, so the filter runs on the RECEIVE side too.
    const hostile = {
      version: 1,
      groupId: 'gTEST',
      revision: 5,
      entries: [
        { path: 'controlPlane.port', value: 3421, revision: 5, origin: 'node-b', at: 1, secret: false },
        { path: PATH_A, value: 'fine', revision: 5, origin: 'node-b', at: 1, secret: false },
      ],
      tombstones: [],
    };
    const parsed = readConfigReplicaDocument(hostile, isReplicatedConfigPath);
    expect(parsed).not.toBeNull();
    expect(parsed?.entries.map((entry) => entry.path)).toEqual([PATH_A]);
  });

  test('an oversized value is refused', () => {
    const parsed = readConfigReplicaDocument(
      {
        version: 1,
        groupId: 'gTEST',
        revision: 1,
        entries: [{
          path: PATH_A,
          value: 'x'.repeat(MAX_REPLICATED_VALUE_BYTES + 10),
          revision: 1,
          origin: 'n',
          at: 1,
          secret: false,
        }],
        tombstones: [],
      },
      () => true,
    );
    expect(parsed?.entries).toHaveLength(0);
  });

  test('deletions expire by age and are capped', () => {
    let document = createConfigReplicaDocument('gTEST');
    for (let index = 0; index < MAX_REPLICATED_TOMBSTONES + 25; index += 1) {
      document = deleteReplicaEntry(document, { path: `surfaces.gone${index}`, origin: 'n', at: 1_000_000 + index });
    }
    const capped = sweepConfigReplica(document, 1_000_000 + MAX_REPLICATED_TOMBSTONES + 25);
    expect(capped.document.tombstones.length).toBe(MAX_REPLICATED_TOMBSTONES);
    expect(capped.droppedTombstones).toBe(25);
    // Well past every tombstone's own timestamp plus the horizon.
    const aged = sweepConfigReplica(
      capped.document,
      1_000_000 + MAX_REPLICATED_TOMBSTONES + 25 + CONFIG_TOMBSTONE_MAX_AGE_MS + 1,
    );
    expect(aged.document.tombstones).toHaveLength(0);
  });
});

describe('replicating across a live group', () => {
  async function twoNodeGroup(): Promise<{
    world: GroupTestWorld;
    master: Awaited<ReturnType<typeof addGroupNode>>;
    standby: Awaited<ReturnType<typeof addGroupNode>>;
  }> {
    const created = createGroupWorld();
    world = created;
    const master = await addGroupNode(created, 'node-a', { isMaster: true });
    const group = await createGroup(master.context, { displayName: 'the workshop' });
    if (!group.ok) throw new Error(group.error);
    const standby = await addGroupNode(created, 'node-b', { isMaster: false });
    const joined = await joinGroup(standby.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    await settle();
    return { world: created, master, standby };
  }

  test('a joining machine is handed the group settings it will need to serve', async () => {
    const { world: w, master, standby } = await twoNodeGroup();
    master.config.set(PATH_A, 'workstream');
    master.config.set(PATH_B, 7);
    await advanceStepped(w, 40_000, 30_000);

    expect(standby.config.get(PATH_A)).toBe('workstream');
    expect(standby.config.get(PATH_B)).toBe(7);
    // And nothing machine-specific followed it across.
    expect(standby.config.get('controlPlane.port')).toBe(standby.localPort);
  });

  test('an edit on the standby is forwarded and comes back as a group change', async () => {
    const { world: w, master, standby } = await twoNodeGroup();
    await advanceStepped(w, 40_000, 30_000);

    standby.config.set(PATH_A, 'workstream');
    await standby.runtime.announceConfigChange(PATH_A);
    await advanceStepped(w, 40_000, 30_000);

    expect(master.config.get(PATH_A)).toBe('workstream');
    const status = groupStatus(master.context);
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.data.replication?.entries ?? 0).toBeGreaterThan(0);
  });

  test('a credential reaches the other machine, and never appears on the wire', async () => {
    const { world: w, master, standby } = await twoNodeGroup();
    const secretKey = replicatedSecretKeyFor(SECRET_PATH);
    await master.secrets.set(secretKey, 'a-real-looking-credential-value');
    await master.runtime.announceSecretChange(SECRET_PATH);
    await advanceStepped(w, 40_000, 30_000);

    expect(await standby.secrets.get(secretKey)).toBe('a-real-looking-credential-value');
    // Sealed for the journey: the value itself is never readable on the bus.
    expect(wireText(w)).not.toContain('a-real-looking-credential-value');
    // And it is not in the replicated document either, so it never lands in a
    // file that is not individually sealed.
    expect(JSON.stringify(master.runtime.replicationStatus())).not.toContain('a-real-looking-credential-value');
  });

  test('a delete made on the master is not resurrected by a machine that missed it', async () => {
    const { world: w, master, standby } = await twoNodeGroup();
    master.config.set(PATH_A, 'workstream');
    await advanceStepped(w, 40_000, 30_000);
    expect(standby.config.get(PATH_A)).toBe('workstream');

    // The standby is cut off, the operator deletes, and the standby comes back
    // still carrying the value at its old revision.
    w.bus.partition(standby.transport, 'away');
    await master.runtime.announceConfigDelete(PATH_A);
    await advanceStepped(w, 40_000, 30_000);
    w.bus.heal();
    await advanceStepped(w, 60_000, 30_000);

    // The deletion survived the heal on both sides.
    expect(findReplicaEntry(master.runtime.replicaDocument()!, PATH_A)).toBeNull();
    expect(master.runtime.replicaDocument()!.tombstones.some((entry) => entry.path === PATH_A)).toBe(true);
    expect(findReplicaEntry(standby.runtime.replicaDocument()!, PATH_A)).toBeNull();
  });

  test('status reports replication as counts and provenance, never as values', async () => {
    const { world: w, master, standby } = await twoNodeGroup();
    master.config.set(PATH_A, 'workstream');
    await advanceStepped(w, 40_000, 30_000);

    const status = groupStatus(standby.context);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.replication).not.toBeNull();
    expect(status.data.replication?.revision).toBeGreaterThan(0);
    expect(status.data.replication?.lastAppliedFrom).toBe('node-a');
    const rendered = JSON.stringify(status.data.replication);
    expect(rendered).not.toContain('workstream');
  });
});
