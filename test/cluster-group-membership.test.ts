/**
 * cluster-group-membership.test.ts, getting in, staying in, and being kept out.
 *
 * These run the real runtimes over an in-memory bus: real scrypt, real x25519
 * seals, real envelopes. Nothing here models the protocol; it exercises it.
 */
import { GROUP_MATERIAL_SECRET_KEY } from '../packages/sdk/src/platform/cluster/group-store.js';
import { describe, expect, test, afterEach } from 'bun:test';
import {
  addGroupNode,
  advance,
  createGroupWorld,
  destroyGroupWorld,
  memorySecrets,
  resolveWithClock,
  settle,
  stopGroupWorld,
  wireText,
  type GroupTestWorld,
} from './cluster-group-harness.js';
import {
  createGroup,
  forgetNode,
  groupNodes,
  groupStatus,
  joinGroup,
  joinKeyForGroup,
  leaveGroup,
  rejoinGroup,
} from '../packages/sdk/src/platform/cluster/group-operations.js';
import {
  decideAdmission,
  encodeIdentityClassMessage,
  GROUP_MESSAGE_TYPES,
} from '../packages/sdk/src/platform/cluster/group-membership.js';
import {
  admitMember,
  createGroupStateDocument,
  mergeGroupState,
  readmitMember,
  removeMember,
  sweepGroupState,
  GROUP_TOMBSTONE_MAX_AGE_MS,
  MAX_GROUP_TOMBSTONES,
} from '../packages/sdk/src/platform/cluster/group-state.js';
import {
  deriveGroupId,
  generateGroupRoot,
  generateNodeKeyMaterial,
} from '../packages/sdk/src/platform/cluster/group-crypto.js';

let world: GroupTestWorld | null = null;

afterEach(async () => {
  if (world) {
    await stopGroupWorld(world);
    destroyGroupWorld(world);
    world = null;
  }
});

async function makeGroupOfOne(): Promise<{
  world: GroupTestWorld;
  first: Awaited<ReturnType<typeof addGroupNode>>;
  groupId: string;
  joinKey: string;
}> {
  const created = createGroupWorld();
  world = created;
  const first = await addGroupNode(created, 'node-a');
  const result = await createGroup(first.context, { displayName: 'the workshop' });
  if (!result.ok) throw new Error(result.error);
  await settle();
  return { world: created, first, groupId: result.data.groupId, joinKey: result.data.joinKey };
}

describe('creating and joining a group', () => {
  test('a second machine joins with the join key and lands on both rosters', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');

    const joined = await joinGroup(second.context, { groupId, joinKey });
    await settle();

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.data.groupId).toBe(groupId);
    expect(joined.data.groupName).toBe('the workshop');

    const roster = groupNodes(first.context);
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    expect(roster.data.members.map((member) => member.nodeId).sort()).toEqual(['node-a', 'node-b']);

    const secondRoster = groupNodes(second.context);
    expect(secondRoster.ok).toBe(true);
    if (!secondRoster.ok) return;
    expect(secondRoster.data.members).toHaveLength(2);
  });

  test('the wrong join key is refused with a message that names the fix', async () => {
    const { world: w, groupId } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');

    const joined = await resolveWithClock(
      w,
      joinGroup(second.context, { groupId, joinKey: 'gvj1-WRON-GKEY-0000-0000-0000' }),
    );

    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.error.toLowerCase()).toContain('join key');
    expect(joined.fix).toContain('cluster key');
    expect(second.runtime.membership).toBe('no-group');
  });

  test('the join key is shown on demand, repeatedly, from any member', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();

    for (const node of [first, second]) {
      const once = joinKeyForGroup(node.context);
      const twice = joinKeyForGroup(node.context);
      expect(once.ok).toBe(true);
      expect(twice.ok).toBe(true);
      if (!once.ok || !twice.ok) return;
      expect(once.data.joinKey).toBe(joinKey);
      expect(twice.data.joinKey).toBe(joinKey);
    }
  });

  test('a user passphrase is accepted, and a short one is refused', async () => {
    const created = createGroupWorld();
    world = created;
    const node = await addGroupNode(created, 'node-a');

    const tooShort = await createGroup(node.context, { passphrase: 'short' });
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.fix).toContain('12 characters');

    const good = await createGroup(node.context, { passphrase: 'correct horse battery staple' });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.data.joinKey).toBe('correct horse battery staple');
    expect(good.data.generatedKey).toBe(false);
  });
});

describe('two groups on one network', () => {
  test('are mutually invisible — neither accepts the other traffic', async () => {
    const created = createGroupWorld();
    world = created;
    const alpha = await addGroupNode(created, 'alpha-1');
    const beta = await addGroupNode(created, 'beta-1');

    const a = await createGroup(alpha.context, { displayName: 'alpha' });
    const b = await createGroup(beta.context, { displayName: 'beta' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.groupId).not.toBe(b.data.groupId);

    await advance(created, 30_000);

    // Each holds only itself, having refused everything from the other group.
    expect(groupNodes(alpha.context).ok).toBe(true);
    const alphaRoster = groupNodes(alpha.context);
    const betaRoster = groupNodes(beta.context);
    if (!alphaRoster.ok || !betaRoster.ok) return;
    expect(alphaRoster.data.members.map((m) => m.nodeId)).toEqual(['alpha-1']);
    expect(betaRoster.data.members.map((m) => m.nodeId)).toEqual(['beta-1']);

    const counters = alpha.runtime.wireCounters;
    expect(counters).not.toBeNull();
    expect(counters?.droppedOtherGroup ?? 0).toBeGreaterThan(0);
    expect(counters?.droppedBadSignature ?? 0).toBe(0);

    // And each SAW the other as a group it could join, without accepting it.
    const seen = alpha.runtime.groupsOnTheNetwork();
    expect(seen.map((group) => group.groupId)).toContain(b.data.groupId);
    expect(seen.find((group) => group.groupId === b.data.groupId)?.displayName).toBe('beta');
  });
});

describe('coming back after being away', () => {
  test('a roster member returning after many rotations is admitted and re-keyed', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();

    // The returning machine goes away while the group rotates repeatedly.
    await second.runtime.stop();
    const staleGeneration = second.runtime.keyMaterial?.currentGeneration ?? -1;
    for (let index = 0; index < 4; index += 1) {
      await first.runtime.rotate('scheduled', 'test rotation');
      await settle();
    }
    const currentGeneration = first.runtime.keyMaterial?.currentGeneration ?? -1;
    expect(currentGeneration).toBeGreaterThan(staleGeneration + 3);

    // It comes back with key material several generations behind.
    const returned = await addGroupNode(w, 'node-b-restarted', { reuse: second });
    const rejoined = await resolveWithClock(w, rejoinGroup(returned.context));

    expect(rejoined.ok).toBe(true);
    expect(returned.runtime.keyMaterial?.currentGeneration).toBe(currentGeneration);
  });

  test('a roster member returning after the join key changed is still admitted', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();
    await second.runtime.stop();

    // The operator changes the join key on the machine that stayed up. The
    // returning machine has no idea, and must not need to.
    const material = first.runtime.keyMaterial;
    expect(material).not.toBeNull();
    if (!material) return;
    const { deriveJoinVerifier, generateJoinKey } = await import(
      '../packages/sdk/src/platform/cluster/group-crypto.js'
    );
    const newJoinKey = generateJoinKey();
    await first.runtime.commitMaterial({
      ...material,
      joinKey: newJoinKey,
      joinVerifier: await deriveJoinVerifier(newJoinKey, material.joinSalt),
    });
    await first.runtime.rotate('scheduled', 'test rotation');
    await settle();

    const returned = await addGroupNode(w, 'node-b-restarted', { reuse: second });
    const rejoined = await resolveWithClock(w, rejoinGroup(returned.context));

    expect(rejoined.ok).toBe(true);
    expect(returned.runtime.keyMaterial?.joinKey).toBe(newJoinKey);
  });

  test('a machine that is NOT on the roster is refused even holding a valid old key', () => {
    const state = admitMember(createGroupStateDocument('gTESTTESTTESTTEST', 'group'), {
      nodeId: 'known',
      displayName: 'known',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 1_000,
    }).state;

    // The intruder's proof is genuine, it holds a real historical key. The
    // only thing it lacks is a place on the roster, and that alone refuses it.
    const decision = decideAdmission(
      state,
      { nodeId: 'stranger', ts: 1_000, now: 1_000, provedCurrentJoinKey: false, provedHistoricalKey: true },
      64,
    );
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.reason).toBe('not-on-the-roster');

    // The same proof from a node that IS on the roster comes straight in.
    const allowed = decideAdmission(
      state,
      { nodeId: 'known', ts: 1_000, now: 1_000, provedCurrentJoinKey: false, provedHistoricalKey: true },
      64,
    );
    expect(allowed).toEqual({ admit: true, path: 'rejoin' });
  });

  test('a removed machine can be put back by the operator with the current join key', () => {
    let state = admitMember(createGroupStateDocument('gTESTTESTTESTTEST', 'group'), {
      nodeId: 'ejected',
      displayName: 'ejected',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 1_000,
    }).state;
    state = removeMember(state, 'ejected', 'removed by the operator', 2_000);

    // The historical-key path stays shut: an old disk cannot undo a removal.
    expect(decideAdmission(
      state,
      { nodeId: 'ejected', ts: 3_000, now: 3_000, provedCurrentJoinKey: false, provedHistoricalKey: true },
      64,
    )).toEqual({ admit: false, reason: 'removed-from-the-group' });

    // The current join key does, because that is the operator doing it.
    expect(decideAdmission(
      state,
      { nodeId: 'ejected', ts: 3_000, now: 3_000, provedCurrentJoinKey: true, provedHistoricalKey: false },
      64,
    )).toEqual({ admit: true, path: 'join' });

    const back = readmitMember(state, {
      nodeId: 'ejected',
      displayName: 'ejected',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 3_000,
    });
    expect(back.refused).toBeNull();
    expect(back.state.members.map((member) => member.nodeId)).toEqual(['ejected']);
    expect(back.state.tombstones).toHaveLength(0);

    // And the re-add still beats a stale copy of the tombstone on a heal.
    expect(mergeGroupState(back.state, state).members.map((m) => m.nodeId)).toEqual(['ejected']);
    expect(mergeGroupState(state, back.state).members.map((m) => m.nodeId)).toEqual(['ejected']);
  });

  test('a stale request is refused however good its proof', () => {
    const state = createGroupStateDocument('gTESTTESTTESTTEST', 'group');
    const decision = decideAdmission(
      state,
      { nodeId: 'x', ts: 0, now: 60 * 60 * 1_000, provedCurrentJoinKey: true, provedHistoricalKey: true },
      64,
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toBe('request-is-stale');
  });
});

describe('the reply to a returning machine', () => {
  test('is signed as the GROUP, so a member admitted while it was away can answer it', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();
    await second.runtime.stop();

    // A THIRD machine joins while the second is switched off, so it is not on
    // the roster the second machine has stored.
    const third = await addGroupNode(w, 'node-c');
    await joinGroup(third.context, { groupId, joinKey });
    await settle();

    // Now the only machine that can answer is the one it has never heard of.
    await first.runtime.stop();
    const returned = await addGroupNode(w, 'node-b-restarted', { reuse: second });
    expect(returned.runtime.groupState?.members.map((m) => m.nodeId)).not.toContain('node-c');

    const rejoined = await resolveWithClock(w, rejoinGroup(returned.context));
    expect(rejoined.ok).toBe(true);
    expect(returned.runtime.keyMaterial?.currentGeneration)
      .toBe(third.runtime.keyMaterial?.currentGeneration);
  });

  test('is refused when it is signed by neither the group nor a remembered member', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();
    await second.runtime.stop();

    // A stranger on the same network that holds NEITHER the group signing key
    // nor any identity on the returning machine's roster. Before the group
    // signing key existed, a sealed reply from something like this was accepted
    // on the seal alone and could keep a machine out of its own group.
    const stranger = await addGroupNode(w, 'stranger');
    const strangerGroup = await createGroup(stranger.context, { displayName: 'not yours' });
    expect(strangerGroup.ok).toBe(true);

    await first.runtime.stop();
    const returned = await addGroupNode(w, 'node-b-restarted', { reuse: second });
    const rejoined = await resolveWithClock(w, rejoinGroup(returned.context));

    expect(rejoined.ok).toBe(false);
    if (!rejoined.ok) expect(rejoined.fix).toContain('cluster join');
    // It kept the key material it already had rather than adopting anything.
    expect(returned.runtime.keyMaterial?.currentGeneration)
      .toBe(second.runtime.keyMaterial?.currentGeneration);
  });

  test('a REJOIN_REFUSE from a stranger cannot talk a machine out of its own group', async () => {
    // The refusal is a message this machine ACTS on, it gives up early and
    // tells its operator to re-join by hand, so it has to be authenticated to
    // exactly the standard the acceptance is. Otherwise anything on the LAN
    // could evict every machine on it by shouting, without holding a single key.
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();
    await second.runtime.stop();
    await first.runtime.stop();

    // A stranger with a perfectly good key pair that is on nobody's roster.
    const stranger = w.bus.createTransport('stranger-refuser');
    await stranger.start(() => {});
    const strangerKeys = generateNodeKeyMaterial();

    const returned = await addGroupNode(w, 'node-b-restarted', { reuse: second });
    const pending = rejoinGroup(returned.context);
    // Land the forgery while the return is in flight.
    await settle();
    await stranger.send(encodeIdentityClassMessage(
      {
        type: GROUP_MESSAGE_TYPES.rejoinRefuse,
        nodeId: 'node-b',
        nodeVersion: '9.9.9',
        seq: 1,
        ts: w.clock.now(),
        body: { forNodeId: returned.id, reason: 'removed-from-the-group', detail: 'you were removed' },
      },
      groupId,
      strangerKeys.identity,
    ));

    const rejoined = await resolveWithClock(w, pending);
    expect(rejoined.ok).toBe(false);
    if (!rejoined.ok) {
      // NOT final: the forgery was refused, so the machine is still a member
      // that simply has not heard from anyone it trusts.
      expect(rejoined.terminal).toBeFalsy();
      expect(rejoined.error).not.toContain('you were removed');
    }
    // And it still holds its own key material, nothing was given up.
    expect(returned.runtime.keyMaterial?.currentGeneration)
      .toBe(second.runtime.keyMaterial?.currentGeneration);
  });

  test('the group signing key rotates on a removal and not on a scheduled rotation', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();

    const before = first.runtime.keyMaterial?.groupSigning.publicKey;
    await first.runtime.rotate('scheduled', 'test rotation');
    await settle();
    expect(first.runtime.keyMaterial?.groupSigning.publicKey).toBe(before);

    await forgetNode(first.context, 'node-b');
    await settle();
    expect(first.runtime.keyMaterial?.groupSigning.publicKey).not.toBe(before);
    // And the new public half is published to the group.
    expect(first.runtime.groupState?.groupSigning.publicKey)
      .toBe(first.runtime.keyMaterial?.groupSigning.publicKey ?? '');
  });
});

describe('removal', () => {
  test('forget writes a tombstone, rotates the key, and refuses the machine afterwards', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b');
    await joinGroup(second.context, { groupId, joinKey });
    await settle();

    const beforeGeneration = first.runtime.keyMaterial?.currentGeneration ?? -1;
    const forgotten = await forgetNode(first.context, 'node-b');
    await settle();

    expect(forgotten.ok).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.data.keyGeneration).toBeGreaterThan(beforeGeneration);
    expect(forgotten.data.memberCount).toBe(1);

    // The removal rotation opens NO acceptance window: the key the removed
    // machine still holds stops verifying at once.
    expect(first.runtime.keyring().acceptedGenerations()).toEqual([forgotten.data.keyGeneration]);

    // And the removed machine cannot get back in on its identity.
    const rejoined = await resolveWithClock(w, rejoinGroup(second.context));
    expect(rejoined.ok).toBe(false);
    if (!rejoined.ok) expect(rejoined.fix).toContain('cluster join');
    // It is told the refusal is FINAL, not that nobody answered. The automatic
    // start-up path logs the ordinary "no answer yet" at debug and carries on,
    // because a machine that booted first resolves that by itself. This case
    // never resolves by itself, and a machine that swallowed it would look
    // healthy forever while silently being given no work at all.
    if (!rejoined.ok) {
      expect(rejoined.terminal).toBe(true);
      expect(rejoined.error).not.toContain('no machine in that group answered');
    }
  });

  test('a machine that is merely alone is NOT told it was removed', async () => {
    // The mirror of the case above, and the reason `terminal` exists rather
    // than treating every rejoin failure as final: this machine is a perfectly
    // good member that happened to boot before any of its peers. It must come
    // back on its own, so the failure it gets must not be the one that tells an
    // operator to re-join by hand.
    const { world: w, first } = await makeGroupOfOne();
    await settle();

    const rejoined = await resolveWithClock(w, rejoinGroup(first.context));
    expect(rejoined.ok).toBe(false);
    if (!rejoined.ok) {
      expect(rejoined.terminal).toBeFalsy();
      expect(rejoined.error).toContain('answered');
    }
  });

  test('a tombstone beats an add across a partition that heals', () => {
    const base = admitMember(createGroupStateDocument('gTESTTESTTESTTEST', 'group'), {
      nodeId: 'doomed',
      displayName: 'doomed',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 1_000,
    }).state;

    // One side of the split removes the machine.
    const removedSide = removeMember(base, 'doomed', 'removed by the operator', 2_000);
    expect(removedSide.members).toHaveLength(0);
    expect(removedSide.tombstones).toHaveLength(1);

    // The other side, which never heard about it, re-adds the machine.
    const readdedSide = admitMember(base, {
      nodeId: 'doomed',
      displayName: 'doomed',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 3_000,
    }).state;
    expect(readdedSide.members).toHaveLength(1);

    // The heal must resolve to REMOVED, in both merge directions.
    const healedA = mergeGroupState(removedSide, readdedSide);
    const healedB = mergeGroupState(readdedSide, removedSide);
    expect(healedA.members).toHaveLength(0);
    expect(healedB.members).toHaveLength(0);
    expect(healedA.tombstones[0]?.nodeId).toBe('doomed');
    expect(healedB.tombstones[0]?.nodeId).toBe('doomed');
  });

  test('a machine cannot remove itself', async () => {
    const { first } = await makeGroupOfOne();
    const result = await forgetNode(first.context, 'node-a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fix).toContain('cluster leave');
  });
});

describe('leaving', () => {
  test('leave clears the key material so nothing more is signed for that group', async () => {
    const { first } = await makeGroupOfOne();
    const left = await leaveGroup(first.context);
    expect(left.ok).toBe(true);
    expect(first.runtime.membership).toBe('no-group');
    expect(first.runtime.keyring().acceptedGenerations()).toEqual([]);
    expect(memorySecrets(first).snapshot()[GROUP_MATERIAL_SECRET_KEY]).toBeUndefined();
  });
});

describe('bounds', () => {
  test('tombstones expire by age and are capped, and members never expire', () => {
    let state = createGroupStateDocument('gTESTTESTTESTTEST', 'group');
    state = admitMember(state, {
      nodeId: 'keeper',
      displayName: 'keeper',
      identityKey: 'k'.repeat(43),
      agreementKey: 'a'.repeat(43),
      now: 0,
    }).state;
    for (let index = 0; index < MAX_GROUP_TOMBSTONES + 40; index += 1) {
      state = removeMember(state, `gone-${index}`, 'removed by the operator', 1_000_000 + index);
    }
    const now = 1_000_000 + MAX_GROUP_TOMBSTONES + 40;
    const capped = sweepGroupState(state, now);
    expect(capped.state.tombstones.length).toBe(MAX_GROUP_TOMBSTONES);
    expect(capped.droppedTombstones).toBe(40);
    // A machine that has been off for years is still a member.
    expect(capped.state.members.map((member) => member.nodeId)).toEqual(['keeper']);

    const aged = sweepGroupState(capped.state, now + GROUP_TOMBSTONE_MAX_AGE_MS + 1);
    expect(aged.state.tombstones).toHaveLength(0);
    expect(aged.state.members).toHaveLength(1);
  });

  test('the group id does not change when the group key rotates', async () => {
    const { first } = await makeGroupOfOne();
    const before = first.runtime.keyMaterial?.groupId;
    await first.runtime.rotate('scheduled', 'test rotation');
    await first.runtime.rotate('scheduled', 'test rotation');
    expect(first.runtime.keyMaterial?.groupId).toBe(before);

    // And it is a pure function of the root secret, not of any key.
    const root = generateGroupRoot();
    expect(deriveGroupId(root)).toBe(deriveGroupId(root));
  });
});

describe('what reaches the wire', () => {
  test('no join key, group key, roster private key or surface name is ever on it', async () => {
    const { world: w, first, groupId, joinKey } = await makeGroupOfOne();
    const second = await addGroupNode(w, 'node-b', {
      surfaceHoldings: () => [{ surfaceId: 'ntfy-topic-mikes-private-inbox', reason: 'elected' }],
    });
    await joinGroup(second.context, { groupId, joinKey });
    await advance(w, 30_000);
    await first.runtime.rotate('scheduled', 'test rotation');
    await settle();

    const text = wireText(w);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(joinKey);
    expect(text).not.toContain('ntfy-topic-mikes-private-inbox');
    for (const record of first.runtime.keyMaterial?.keys ?? []) {
      expect(text).not.toContain(record.key);
    }
    expect(text).not.toContain(first.runtime.keyMaterial?.joinVerifier ?? 'never-matches');
    expect(text).not.toContain(first.runtime.keyMaterial?.node.identity.privateKey ?? 'never-matches');
    expect(text).not.toContain(first.runtime.keyMaterial?.groupRoot ?? 'never-matches');

    // A surface reported through status is hashed, never carried in the clear.
    const holdings = second.runtime.surfaceHoldings();
    expect(holdings?.[0]?.surfaceId).toMatch(/^s[0-9a-f]{32}$/);
  });

  test('the beacon carries only the group id, its name, the member count and a version', async () => {
    const { world: w } = await makeGroupOfOne();
    await advance(w, 10_000);
    const beacons = w.wire
      .map((entry) => JSON.parse(entry.raw) as Record<string, unknown>)
      .filter((entry) => entry['type'] === GROUP_MESSAGE_TYPES.beacon);
    expect(beacons.length).toBeGreaterThan(0);
    const body = beacons[0]?.['body'] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['displayName', 'nodeCount']);
    expect(Object.keys(beacons[0] ?? {}).sort()).toEqual([
      'body', 'groupId', 'keyGen', 'nodeId', 'nodeVersion', 'seq', 'sig', 'surfaceId', 'ts', 'type', 'v',
    ]);
  });
});

describe('switched off', () => {
  test('opens no socket, sends nothing, and still reports the stored membership', async () => {
    const created = createGroupWorld();
    world = created;
    const on = await addGroupNode(created, 'node-a');
    const group = await createGroup(on.context, { displayName: 'the workshop' });
    expect(group.ok).toBe(true);
    if (!group.ok) return;
    await on.runtime.stop();

    // The same machine, same stores, with cluster.enabled off.
    const off = await addGroupNode(created, 'node-a-off', {
      reuse: on,
      settings: { enabled: false },
    });
    // Scoped to the machine under test rather than the whole bus: what is being
    // asserted is that THIS node emits nothing, and counting every datagram on
    // the segment would also be counting anything else still attached to it.
    const sentByThisNode = (): number => created.wire.filter((entry) => entry.from === 'node-a-off').length;
    expect(sentByThisNode()).toBe(0);
    await advance(created, 60_000);
    expect(sentByThisNode()).toBe(0);

    // It still knows what group it belongs to, and says why it is quiet.
    const status = groupStatus(off.context);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.membership).toBe('member');
    expect(status.data.groupId).toBe(group.data.groupId);
    expect(status.data.advice).toContain('cluster.enabled');

    // And `cluster key` still answers, because the key is stored, not networked.
    const key = joinKeyForGroup(off.context);
    expect(key.ok).toBe(true);
    if (key.ok) expect(key.data.joinKey).toBe(group.data.joinKey);

    // Joining is refused with the setting named, rather than silently hanging.
    const joined = await joinGroup(off.context, { groupId: 'gOTHEROTHEROTHER0', joinKey: 'x' });
    expect(joined.ok).toBe(false);
    if (!joined.ok) expect(joined.fix).toContain('cluster.enabled');
  });
});

describe('status', () => {
  test('reports no-group plainly and names the two commands that fix it', async () => {
    const created = createGroupWorld();
    world = created;
    const node = await addGroupNode(created, 'node-a');
    const status = groupStatus(node.context);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.membership).toBe('no-group');
    expect(status.data.groupId).toBeNull();
    expect(status.data.advice).toContain('cluster create');
    expect(status.data.advice).toContain('cluster join');
  });

  test('discloses key-history bounds and never the keys themselves', async () => {
    const { first } = await makeGroupOfOne();
    const status = groupStatus(first.context);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.keyGenerationsHeld).toBeGreaterThan(0);
    expect(status.data.keyGenerationCap).toBeGreaterThan(0);
    expect(JSON.stringify(status.data)).not.toContain(first.runtime.keyMaterial?.keys[0]?.key ?? 'never');
    expect(JSON.stringify(status.data)).not.toContain(first.runtime.keyMaterial?.joinKey ?? 'never');
  });

  test('reports surfaces as unavailable rather than empty when nothing supplies them', async () => {
    const { first } = await makeGroupOfOne();
    const status = groupStatus(first.context);
    if (!status.ok) return;
    expect(status.data.surfaces).toBeNull();
  });
});
