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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { GROUP_MATERIAL_SECRET_KEY } from '../packages/sdk/src/platform/cluster/group-store.js';
import { isDaemonOwnedSecretKey } from '../packages/sdk/src/platform/config/daemon-secret-keys.js';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.js';

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
    // The group's own key material IS daemon-owned and IS derived — asserting
    // the bare literal here would pass for the wrong reason, because nothing
    // derives that string. What keeps it off the wire is the node-local ruling
    // on `cluster.`, not an absence of derivation.
    expect(isDaemonOwnedSecretKey(GROUP_MATERIAL_SECRET_KEY)).toBe(true);
    expect(isReplicatedSecretKey(GROUP_MATERIAL_SECRET_KEY)).toBe(false);
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

/**
 * The credential a machine needs after it takes a surface over.
 *
 * The blocks above prove CLASSIFICATION — which paths may cross. These prove
 * the rest of the sentence: that a daemon-owned credential actually arrives on
 * the other machine, that it lands in that machine's DAEMON tier (one home,
 * read back whatever directory the daemon starts in) rather than in whatever
 * project directory the process happened to be launched from, and that a
 * credential the group does not own does not travel with it.
 *
 * The secret stores here are real `SecretsManager` instances over real
 * directories, not the harness Map, because "which tier did it land in" is a
 * question a Map cannot answer and a test against a Map would only be
 * restating the classification constant.
 */
describe('a daemon-owned credential after a handover', () => {
  const GROUP_CREDENTIAL = 'group-owned-credential-value';
  const PERSONAL_CREDENTIAL = 'this-operators-own-credential';
  const NODE_LOCAL_CREDENTIAL = 'this-machines-own-credential';
  /** Daemon-owned, and node-local: the group must not carry it. */
  const NODE_LOCAL_PATH = 'cluster.multicastGroup';
  /**
   * A name nothing derives, so nothing can select it.
   *
   * Deliberately not a real provider key name: `SecretsManager` resolves the
   * environment first, so a developer who happens to export `ANTHROPIC_API_KEY`
   * would satisfy the "did not replicate" assertion from their own shell and
   * the test would pass without proving anything. The assertion below pins that.
   */
  const PERSONAL_KEY = 'GV_TEST_OPERATOR_PERSONAL_KEY';

  interface NodeSecrets {
    readonly manager: SecretsManager;
    readonly home: string;
  }

  function secretsFor(current: GroupTestWorld, label: string): NodeSecrets {
    const home = join(current.tempRoot, `${label}-secrets`, 'home');
    const project = join(current.tempRoot, `${label}-secrets`, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    return {
      manager: new SecretsManager({ projectRoot: project, globalHome: home, surfaceRoot: 'goodvibes' }),
      home,
    };
  }

  async function storedScope(manager: SecretsManager, key: string): Promise<string | undefined> {
    const records = await manager.listDetailed();
    return records.find((record) => record.key === key && record.source !== 'env')?.scope;
  }

  test('every credential that may cross the network is one the daemon owns', () => {
    // The join between selection and storage: anything replication picks is
    // daemon-owned, so it has a daemon home to land in on the far side.
    for (const path of listReplicatedConfigPaths()) {
      expect(isDaemonOwnedSecretKey(replicatedSecretKeyFor(path)), `${path} has no daemon home`).toBe(true);
    }
    // And NOT the converse — the daemon tier is a storage location, not an
    // export list. A node-local daemon credential is daemon-owned and stays put.
    expect(isDaemonOwnedSecretKey(replicatedSecretKeyFor(NODE_LOCAL_PATH))).toBe(true);
    expect(isReplicatedSecretKey(replicatedSecretKeyFor(NODE_LOCAL_PATH))).toBe(false);
  });

  test('the credential reaches the other machine and lands in its daemon tier', async () => {
    const created = createGroupWorld();
    world = created;
    const masterSecrets = secretsFor(created, 'node-a');
    const standbySecrets = secretsFor(created, 'node-b');

    const master = await addGroupNode(created, 'node-a', { isMaster: true, secrets: masterSecrets.manager });
    const group = await createGroup(master.context, { displayName: 'the workshop' });
    if (!group.ok) throw new Error(group.error);
    const standby = await addGroupNode(created, 'node-b', { isMaster: false, secrets: standbySecrets.manager });
    const joined = await joinGroup(standby.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    await settle();

    const secretKey = replicatedSecretKeyFor(SECRET_PATH);
    // Nobody names a scope: the key is derived from a daemon-owned path, so the
    // daemon tier is where it belongs and where it goes.
    await masterSecrets.manager.set(secretKey, GROUP_CREDENTIAL);
    expect(await storedScope(masterSecrets.manager, secretKey)).toBe('daemon');

    await master.runtime.announceSecretChange(SECRET_PATH);
    await advanceStepped(created, 40_000, 30_000);

    expect(await standbySecrets.manager.get(secretKey)).toBe(GROUP_CREDENTIAL);
    expect(await storedScope(standbySecrets.manager, secretKey)).toBe('daemon');
    // On disk, in the receiving machine's own daemon home, encrypted under that
    // machine's own keyfile — not stored as the sender's ciphertext.
    const standbyStore = join(standbySecrets.home, '.goodvibes', 'daemon', 'secrets.enc');
    expect(existsSync(standbyStore)).toBe(true);
    expect(readFileSync(standbyStore, 'utf-8')).not.toContain(GROUP_CREDENTIAL);
    // And never readable on the bus at any point.
    expect(wireText(created)).not.toContain(GROUP_CREDENTIAL);
  });

  test('the Google refresh token survives a handover, so mail does not go quiet on failover', async () => {
    // The concrete case this whole mechanism exists for. Before the daemon
    // tier, a Google credential lived in whichever client silo the operator
    // pasted it into, so the node that won a handover came up unable to read
    // or send mail — and nothing said why. This asserts the actual path the
    // agent stores, not a stand-in.
    const GOOGLE_PATH = 'google.oauth.refreshToken';
    const GOOGLE_CREDENTIAL = 'refresh-token-standing-in-for-a-real-one';

    expect(isReplicatedConfigPath(GOOGLE_PATH)).toBe(true);
    expect(isDaemonOwnedSecretKey(replicatedSecretKeyFor(GOOGLE_PATH))).toBe(true);

    const created = createGroupWorld();
    world = created;
    const masterSecrets = secretsFor(created, 'node-a');
    const standbySecrets = secretsFor(created, 'node-b');

    const master = await addGroupNode(created, 'node-a', { isMaster: true, secrets: masterSecrets.manager });
    const group = await createGroup(master.context, { displayName: 'the workshop' });
    if (!group.ok) throw new Error(group.error);
    const standby = await addGroupNode(created, 'node-b', { isMaster: false, secrets: standbySecrets.manager });
    const joined = await joinGroup(standby.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    await settle();

    const secretKey = replicatedSecretKeyFor(GOOGLE_PATH);
    await masterSecrets.manager.set(secretKey, GOOGLE_CREDENTIAL);
    expect(await storedScope(masterSecrets.manager, secretKey)).toBe('daemon');

    await master.runtime.announceSecretChange(GOOGLE_PATH);
    await advanceStepped(created, 40_000, 30_000);

    // The node that would take over can actually use it.
    expect(await standbySecrets.manager.get(secretKey)).toBe(GOOGLE_CREDENTIAL);
    expect(await storedScope(standbySecrets.manager, secretKey)).toBe('daemon');
    // Re-encrypted under the receiving machine's own keyfile, and never
    // readable on the bus.
    const standbyStore = join(standbySecrets.home, '.goodvibes', 'daemon', 'secrets.enc');
    expect(readFileSync(standbyStore, 'utf-8')).not.toContain(GOOGLE_CREDENTIAL);
    expect(wireText(created)).not.toContain(GOOGLE_CREDENTIAL);
  });

  test('the group key material lands in the daemon tier and deliberately does NOT replicate', async () => {
    // Two separate claims, and the second is a security property rather than
    // an oversight:
    //
    //  1. It belongs in the daemon tier. Before the name was derived, it was
    //     written at project scope — into whichever directory the daemon
    //     happened to start in, outside the tier holding every other cluster
    //     secret.
    //
    //  2. It must NOT replicate. Group key material is what proves membership,
    //     so a node that does not have it is a node that is not in the group.
    //     Shipping it over the group bus would mean the bus distributes the key
    //     that authenticates the bus, and any machine that could hear traffic
    //     would obtain membership without ever completing the join handshake.
    //     A joining node gets this material through `joinGroup`, which proves
    //     identity first. That is the only path, on purpose.
    const created = createGroupWorld();
    world = created;
    const masterSecrets = secretsFor(created, 'node-a');
    const standbySecrets = secretsFor(created, 'node-b');

    const master = await addGroupNode(created, 'node-a', { isMaster: true, secrets: masterSecrets.manager });
    const group = await createGroup(master.context, { displayName: 'the workshop' });
    if (!group.ok) throw new Error(group.error);
    const standby = await addGroupNode(created, 'node-b', { isMaster: false, secrets: standbySecrets.manager });
    const joined = await joinGroup(standby.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    await settle();

    // Creating a group stores real material under the derived name...
    const stored = await masterSecrets.manager.get(GROUP_MATERIAL_SECRET_KEY);
    expect(stored).not.toBeNull();
    // ...in the daemon tier, not at project scope.
    expect(await storedScope(masterSecrets.manager, GROUP_MATERIAL_SECRET_KEY)).toBe('daemon');

    // The node that joined has its OWN material, obtained through the join
    // handshake — not a copy of the master's replicated to it.
    expect(await storedScope(standbySecrets.manager, GROUP_MATERIAL_SECRET_KEY)).toBe('daemon');
    expect(await standbySecrets.manager.get(GROUP_MATERIAL_SECRET_KEY)).not.toBe(stored);

    // And the master's material never appeared on the wire at any point.
    const material = stored ?? '';
    expect(material.length).toBeGreaterThan(0);
    expect(wireText(created)).not.toContain(material);
  });

  test('a machine that joins later is handed the credential in its snapshot, and nothing else', async () => {
    // Nothing in the ambient environment may answer for these, or the negative
    // assertions below would be satisfied without a single datagram.
    expect(process.env[PERSONAL_KEY]).toBeUndefined();
    expect(process.env[replicatedSecretKeyFor(NODE_LOCAL_PATH)]).toBeUndefined();

    const created = createGroupWorld();
    world = created;
    const masterSecrets = secretsFor(created, 'node-a');

    const master = await addGroupNode(created, 'node-a', { isMaster: true, secrets: masterSecrets.manager });
    const group = await createGroup(master.context, { displayName: 'the workshop' });
    if (!group.ok) throw new Error(group.error);

    const groupKey = replicatedSecretKeyFor(SECRET_PATH);
    const nodeLocalKey = replicatedSecretKeyFor(NODE_LOCAL_PATH);
    await masterSecrets.manager.set(groupKey, GROUP_CREDENTIAL);
    // Daemon-scoped, but named by a node-local path.
    await masterSecrets.manager.set(nodeLocalKey, NODE_LOCAL_CREDENTIAL);
    // This operator's own key: user-scoped, and nothing derives its name.
    await masterSecrets.manager.set(PERSONAL_KEY, PERSONAL_CREDENTIAL, { scope: 'user' });
    expect(await storedScope(masterSecrets.manager, nodeLocalKey)).toBe('daemon');
    expect(await storedScope(masterSecrets.manager, PERSONAL_KEY)).toBe('user');

    // The strongest push available for each: ask the group to replicate it.
    await master.runtime.announceSecretChange(SECRET_PATH);
    await master.runtime.announceSecretChange(NODE_LOCAL_PATH);

    // The second machine only now joins, so everything it gets arrives in the
    // snapshot the master sends a newcomer.
    const standbySecrets = secretsFor(created, 'node-b');
    const standby = await addGroupNode(created, 'node-b', { isMaster: false, secrets: standbySecrets.manager });
    const joined = await joinGroup(standby.context, { groupId: group.data.groupId, joinKey: group.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    await advanceStepped(created, 60_000, 30_000);

    expect(await standbySecrets.manager.get(groupKey)).toBe(GROUP_CREDENTIAL);
    // The two that must not travel, neither into the other machine's store...
    expect(await standbySecrets.manager.get(nodeLocalKey)).toBeNull();
    expect(await standbySecrets.manager.get(PERSONAL_KEY)).toBeNull();
    // ...nor onto the wire at all, sealed or otherwise.
    expect(wireText(created)).not.toContain(NODE_LOCAL_CREDENTIAL);
    expect(wireText(created)).not.toContain(PERSONAL_CREDENTIAL);
  });
});
