/**
 * group-operations.ts — the seven things an operator can do to a group.
 *
 * Every one of them returns STRUCTURED DATA. Nothing here formats a table,
 * pads a column or decides on a colour. That is deliberate and it is the rule
 * for the whole feature: the CLI renders human text from these results, `--json`
 * prints the same results verbatim, and the TUI and web UI render them their own
 * way. One implementation, three renderings — never a second code path that
 * drifts from the first.
 *
 * These are also exactly the daemon verbs. The CLI does not reach past them,
 * which is what makes `cluster status` against a remote daemon behave
 * identically to running it on the machine itself.
 */
import {
  deriveGroupId,
  deriveJoinSalt,
  deriveJoinVerifier,
  generateGroupRoot,
  generateJoinKey,
  normalizeJoinKey,
} from './group-crypto.js';
import type { ClusterGroupRuntime, DiscoveredGroup, SurfaceHolding } from './group-runtime.js';
import {
  admitMember,
  createGroupStateDocument,
  DEFAULT_GROUP_DISPLAY_NAME,
  isCurrentMember,
  normalizeDisplayName,
  removeMember,
  renameGroup,
  type GroupStateDocument,
} from './group-state.js';
import {
  createGroupKeyMaterial,
  clearGroupKeyMaterial,
  joiningGroupKeyMaterial,
  MAX_KEY_GENERATIONS,
  type ClusterSecretStore,
} from './group-store.js';
import { keyRotationGraceMs, type ClusterGroupSettings } from './group-settings.js';
import type { AdmissionFailure } from './group-admissions.js';

/** How long a join or a rejoin waits for the group to answer. */
export const ADMISSION_TIMEOUT_MS = 15_000;

/** Every operation returns one of these. `ok: false` always names the fix. */
export type GroupOperationResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
    readonly ok: false;
    readonly error: string;
    readonly fix: string;
    /**
     * True when this machine is out of the group and waiting will not change
     * it — as opposed to the ordinary "nobody answered yet", which resolves on
     * its own the moment another machine comes up.
     *
     * An automatic caller must not swallow this one. It is the difference
     * between a machine that will rejoin by itself and a machine that needs
     * the operator, and both look identical from the outside otherwise: a
     * healthy daemon that is simply never given any work.
     */
    readonly terminal?: boolean;
    /**
     * The admission layer's own classification, when this failure came from
     * one. Lets an automatic caller tell "nobody answered yet" (ordinary,
     * self-resolving) from "replies arrived that I could not verify" (worth
     * telling the operator, but not proof of anything).
     */
    readonly failure?: AdmissionFailure;
  };

function failed(
  error: string,
  fix: string,
  options: { readonly terminal?: boolean; readonly failure?: AdmissionFailure } = {},
): GroupOperationResult<never> {
  return {
    ok: false,
    error,
    fix,
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
  };
}

/** One machine, as `cluster nodes` reports it. */
export interface NodeReport {
  readonly nodeId: string;
  readonly displayName: string;
  readonly admittedAt: number;
  readonly lastSeenAt: number;
  readonly isThisMachine: boolean;
}

/** One removal, as `cluster nodes` reports it. */
export interface RemovedNodeReport {
  readonly nodeId: string;
  readonly removedAt: number;
  readonly reason: string;
}

/** What `cluster status` reports. Contains no key material of any kind. */
export interface GroupStatusReport {
  readonly membership: 'no-group' | 'member' | 'unreadable-key-material';
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly version: string;
  readonly memberCount: number;
  /** Null when the per-surface layer has not supplied it — never a fabricated empty list. */
  readonly surfaces: readonly SurfaceHolding[] | null;
  readonly keyGeneration: number | null;
  readonly keyGenerationsHeld: number;
  readonly keyGenerationCap: number;
  readonly acceptedGenerations: readonly number[];
  readonly removedNodeCount: number;
  readonly rotationHours: number;
  /** Replicated settings: counts and provenance only, never a value. */
  readonly replication: {
    readonly revision: number;
    readonly entries: number;
    readonly secrets: number;
    readonly tombstones: number;
    readonly lastAppliedFrom: string | null;
    readonly lastAppliedAt: number | null;
    readonly pendingProposals: number;
  } | null;
  readonly wire: {
    readonly sent: number;
    readonly received: number;
    readonly droppedOtherGroup: number;
    readonly droppedBadSignature: number;
    readonly droppedMalformed: number;
    readonly droppedOldGeneration: number;
    readonly droppedNoGroup: number;
  } | null;
  /** One plain sentence naming what to do, when there is something to do. */
  readonly advice: string | null;
}

export interface GroupOperationsContext {
  readonly runtime: ClusterGroupRuntime;
  readonly secrets: ClusterSecretStore;
  readonly settings: ClusterGroupSettings;
  readonly nodeId: string;
  readonly nodeDisplayName: string;
  readonly version: string;
  readonly now: () => number;
}

/**
 * Read-only view of the group.
 *
 * Deliberately says `no-group` rather than pretending to be a degraded member:
 * `cluster.enabled` with nothing stored is a real, nameable state, and the
 * advice line names the two commands that leave it.
 */
export function groupStatus(context: GroupOperationsContext): GroupOperationResult<GroupStatusReport> {
  const { runtime } = context;
  const state = runtime.groupState;
  const material = runtime.keyMaterial;
  const membership = runtime.membership;
  const advice = !context.settings.enabled
    ? 'sharing inbound work with your other machines is switched off here — turn it on with `config set cluster.enabled true`'
    : membership === 'no-group'
      ? 'this machine is not in a group yet — run `cluster create` here, or `cluster join` to join one that already exists'
      : membership === 'unreadable-key-material'
        ? 'the stored group key material could not be read — run `cluster join` to rejoin the group'
        : null;
  return {
    ok: true,
    data: {
      membership,
      groupId: material?.groupId ?? null,
      groupName: state?.displayName ?? null,
      nodeId: context.nodeId,
      nodeName: context.nodeDisplayName,
      version: context.version,
      memberCount: state?.members.length ?? 0,
      surfaces: runtime.surfaceHoldings(),
      keyGeneration: material?.currentGeneration ?? null,
      keyGenerationsHeld: material?.keys.length ?? 0,
      keyGenerationCap: MAX_KEY_GENERATIONS,
      acceptedGenerations: runtime.keyring().acceptedGenerations(),
      removedNodeCount: state?.tombstones.length ?? 0,
      rotationHours: context.settings.keyRotationHours,
      replication: runtime.replicationStatus(),
      wire: runtime.wireCounters ? { ...runtime.wireCounters } : null,
      advice,
    },
  };
}

export interface CreateGroupInput {
  readonly displayName?: string | undefined;
  /**
   * An operator-chosen join key instead of a generated one.
   *
   * Run through scrypt with the group's salt, because a phrase a human picked
   * has far less entropy than the generated key and the derivation is the only
   * thing standing between it and an offline guess.
   */
  readonly passphrase?: string | undefined;
}

export interface CreateGroupResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly joinKey: string;
  readonly generatedKey: boolean;
}

/** Create a group with this machine as its first member. */
export async function createGroup(
  context: GroupOperationsContext,
  input: CreateGroupInput,
): Promise<GroupOperationResult<CreateGroupResult>> {
  if (context.runtime.membership === 'member') {
    return failed(
      'this machine is already in a group',
      'leave it first with `cluster leave`, or use `cluster key` to add another machine to the group it is in',
    );
  }
  const passphrase = input.passphrase?.trim();
  if (passphrase !== undefined && passphrase.length > 0 && passphrase.length < 12) {
    return failed(
      'that join phrase is too short to be worth having',
      'use at least 12 characters, or leave it out and a strong key will be generated',
    );
  }
  const groupRoot = generateGroupRoot();
  const groupId = deriveGroupId(groupRoot);
  const joinSalt = deriveJoinSalt(groupId);
  const joinKey = passphrase && passphrase.length > 0 ? passphrase : generateJoinKey();
  const joinVerifier = await deriveJoinVerifier(joinKey, joinSalt);
  const now = context.now();

  const material = createGroupKeyMaterial({
    groupId,
    groupRoot,
    joinKey,
    joinSalt,
    joinVerifier,
    nodeId: context.nodeId,
    now,
  });
  const displayName = normalizeDisplayName(input.displayName, DEFAULT_GROUP_DISPLAY_NAME);
  // The group's signing public key goes into the replicated document from the
  // very first write, so every member that ever joins holds it.
  const document = createGroupStateDocument(groupId, displayName, {
    publicKey: material.groupSigning.publicKey,
    generation: material.groupSigning.generation,
  });
  const admitted = admitMember(document, {
    nodeId: context.nodeId,
    displayName: context.nodeDisplayName,
    identityKey: material.node.identity.publicKey,
    agreementKey: material.node.agreement.publicKey,
    now,
  });
  await context.runtime.adoptMembership(material, admitted.state);
  return {
    ok: true,
    data: {
      groupId,
      groupName: displayName,
      joinKey,
      generatedKey: !passphrase || passphrase.length === 0,
    },
  };
}

export interface JoinGroupInput {
  readonly groupId: string;
  readonly joinKey: string;
  readonly timeoutMs?: number | undefined;
}

export interface JoinGroupResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly memberCount: number;
}

/**
 * Join an existing group.
 *
 * The group id names WHICH group, and the join key proves the right to be in
 * it. Both are needed: the id alone is public (it is in every beacon) and the
 * key alone would not say which group it was for.
 */
export async function joinGroup(
  context: GroupOperationsContext,
  input: JoinGroupInput,
): Promise<GroupOperationResult<JoinGroupResult>> {
  if (!context.settings.enabled) {
    return failed(
      'sharing inbound work with your other machines is switched off on this machine',
      'turn it on first: `config set cluster.enabled true`, then restart the daemon',
    );
  }
  if (context.runtime.membership === 'member') {
    return failed(
      'this machine is already in a group',
      'run `cluster leave` first if you mean to move it to a different one',
    );
  }
  const joinKey = normalizeJoinKey(input.joinKey ?? '');
  if (joinKey.length === 0) {
    return failed('no join key was given', 'run `cluster key` on a machine already in the group to see it');
  }
  const groupId = input.groupId.trim();
  if (groupId.length === 0) {
    return failed(
      'no group was named',
      'run `cluster join` with no arguments to pick from the groups on this network, or pass --group',
    );
  }
  const outcome = await context.runtime.requestJoin({
    groupId,
    joinKey,
    joinSalt: deriveJoinSalt(groupId),
    timeoutMs: input.timeoutMs ?? ADMISSION_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    // A machine presenting the WRONG join key cannot tell a refusal apart from
    // silence: the refusal is authenticated with the real key, which by
    // definition it does not hold. So a timeout covers both cases and the
    // message says both rather than guessing at one and being wrong half the
    // time.
    const timedOut = outcome.reason.includes('answered in time');
    return failed(
      timedOut
        ? 'no machine in that group accepted the join key — either the join key is wrong, or no machine in that group is reachable on this network'
        : outcome.reason,
      'check the join key with `cluster key` on a machine already in the group, and that both machines are on the same network',
    );
  }
  const grant = outcome.grant;
  const now = context.now();
  const material = joiningGroupKeyMaterial({
    groupId,
    joinKey: grant.joinKey,
    joinSalt: grant.joinSalt,
    joinVerifier: grant.joinVerifier,
    keys: grant.keys,
    currentGeneration: grant.currentGeneration,
    node: outcome.node,
    groupSigning: grant.groupSigning,
    now,
    graceMs: keyRotationGraceMs(context.settings),
  });
  await context.runtime.adoptMembership(material, grant.state);
  // Ask for the group's settings straight away: a machine that has joined but
  // holds none of them cannot serve a surface it might win in a few seconds.
  await context.runtime.requestConfigSnapshot();
  return {
    ok: true,
    data: {
      groupId,
      groupName: grant.state.displayName,
      memberCount: grant.state.members.length,
    },
  };
}

export interface JoinKeyResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly joinKey: string;
}

/**
 * Show the join key.
 *
 * On demand and repeatable, from any member — not a one-shot reveal at create
 * time. A key you can only see once is a key that gets written on a sticky
 * note, and the operator adding a fourth machine six months later has every
 * right to just ask for it again.
 */
export function joinKeyForGroup(context: GroupOperationsContext): GroupOperationResult<JoinKeyResult> {
  const material = context.runtime.keyMaterial;
  const state = context.runtime.groupState;
  if (!material || !state) {
    return failed(
      'this machine is not in a group, so it has no join key to show',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  return {
    ok: true,
    data: { groupId: material.groupId, groupName: state.displayName, joinKey: material.joinKey },
  };
}

export interface NodesResult {
  readonly groupId: string;
  readonly groupName: string;
  readonly members: readonly NodeReport[];
  readonly removed: readonly RemovedNodeReport[];
}

/** The roster. */
export function groupNodes(context: GroupOperationsContext): GroupOperationResult<NodesResult> {
  const state = context.runtime.groupState;
  const material = context.runtime.keyMaterial;
  if (!state || !material) {
    return failed(
      'this machine is not in a group, so there is no member list',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      groupName: state.displayName,
      members: state.members.map((member) => ({
        nodeId: member.nodeId,
        displayName: member.displayName,
        admittedAt: member.admittedAt,
        lastSeenAt: member.lastSeenAt,
        isThisMachine: member.nodeId === context.nodeId,
      })),
      removed: state.tombstones.map((entry) => ({
        nodeId: entry.nodeId,
        removedAt: entry.at,
        reason: entry.reason,
      })),
    },
  };
}

export interface ForgetNodeResult {
  readonly nodeId: string;
  readonly displayName: string;
  readonly memberCount: number;
  readonly keyGeneration: number;
}

/**
 * Remove a machine from the group.
 *
 * Two things happen, and both are required. A TOMBSTONE is written, at a
 * generation above any add, so a peer that was partitioned during the removal
 * cannot bring the machine back when it reconnects. And the group key is
 * rotated IMMEDIATELY with no acceptance window, so the key still sitting on
 * that machine's disk stops being accepted by everyone who adopts the rotation.
 *
 * Members that have not yet adopted keep accepting the old key for the moments
 * it takes the announcement to reach them. That gap is inherent to a network
 * and is not papered over here: it closes as the rotation propagates, and the
 * tombstone — which is what governs re-entry — is effective immediately.
 */
export async function forgetNode(
  context: GroupOperationsContext,
  nodeId: string,
): Promise<GroupOperationResult<ForgetNodeResult>> {
  const state = context.runtime.groupState;
  if (!state) {
    return failed(
      'this machine is not in a group',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  if (nodeId === context.nodeId) {
    return failed(
      'a machine cannot remove itself from the group',
      'run `cluster leave` on this machine instead, or `cluster forget` from another machine in the group',
    );
  }
  const member = state.members.find((entry) => entry.nodeId === nodeId)
    ?? state.members.find((entry) => entry.displayName === nodeId)
    ?? state.members.find((entry) => entry.nodeId.startsWith(nodeId));
  if (!member) {
    return failed(
      `no machine called '${nodeId}' is in this group`,
      'run `cluster nodes` to see the member list',
    );
  }
  const removed = removeMember(state, member.nodeId, 'removed by the operator', context.now());
  await context.runtime.commitState(removed, true);
  const rotated = await context.runtime.rotate('revocation', `${member.nodeId} was removed from the group`);
  return {
    ok: true,
    data: {
      nodeId: member.nodeId,
      displayName: member.displayName,
      memberCount: removed.members.length,
      keyGeneration: rotated.currentGeneration,
    },
  };
}

export interface RotateKeyResult {
  readonly groupId: string;
  readonly keyGeneration: number;
  readonly memberCount: number;
  readonly immediate: boolean;
  readonly acceptedGenerations: readonly number[];
}

/**
 * Replace the group key now, because the operator said so.
 *
 * Two shapes, and the difference is what happens to the key being retired:
 *
 *   default — the outgoing generation stays accepted for the usual few minutes,
 *     so machines that have not yet picked up the new key keep being heard and
 *     nothing is interrupted. This is the right answer for routine hygiene.
 *
 *   --now — the outgoing generation stops being accepted immediately, and the
 *     group's SIGNING key is replaced as well. This is the answer when a key is
 *     believed to have leaked: whatever was taken stops working the moment each
 *     machine adopts the replacement, and the cost is that a machine which is
 *     asleep right now has to ask to come back when it wakes.
 */
export async function rotateGroupKey(
  context: GroupOperationsContext,
  input: { readonly immediate?: boolean | undefined } = {},
): Promise<GroupOperationResult<RotateKeyResult>> {
  const material = context.runtime.keyMaterial;
  if (!material) {
    return failed(
      'this machine is not in a group, so there is no group key to replace',
      'create a group with `cluster create`, or join one with `cluster join`',
    );
  }
  if (!context.settings.enabled) {
    return failed(
      'sharing inbound work with your other machines is switched off on this machine',
      'turn it on first: `config set cluster.enabled true`, then restart the daemon',
    );
  }
  const immediate = input.immediate === true;
  const rotated = await context.runtime.rotate(
    immediate ? 'revocation' : 'scheduled',
    immediate ? 'replaced immediately by the operator' : 'replaced by the operator',
  );
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      keyGeneration: rotated.currentGeneration,
      memberCount: context.runtime.groupState?.members.length ?? 0,
      immediate,
      acceptedGenerations: context.runtime.keyring().acceptedGenerations(),
    },
  };
}

export interface LeaveGroupResult {
  readonly groupId: string;
  readonly groupName: string;
}

/**
 * Leave the group, from this machine.
 *
 * This forgets the group HERE. It does not remove this machine from the other
 * members' rosters — they will simply stop hearing from it, and the operator
 * can tidy up with `cluster forget` on any of them. Making one machine's
 * decision to leave silently rewrite everyone else's membership would be a
 * strictly worse default.
 */
export async function leaveGroup(
  context: GroupOperationsContext,
): Promise<GroupOperationResult<LeaveGroupResult>> {
  const material = context.runtime.keyMaterial;
  const state = context.runtime.groupState;
  if (!material || !state) {
    return failed('this machine is not in a group', 'there is nothing to leave');
  }
  const result = { groupId: material.groupId, groupName: state.displayName };
  await clearGroupKeyMaterial(context.secrets);
  await context.runtime.forgetMembership();
  return { ok: true, data: result };
}

export interface RenameGroupResult {
  readonly groupId: string;
  readonly groupName: string;
}

/**
 * Rename the group.
 *
 * The name is replicated group state, so renaming on any machine renames it
 * everywhere. It is also what the discovery beacon advertises, which means it
 * is visible to anything on the network — the setting's description says so
 * plainly, and the default is neutral for that reason.
 */
export async function renameGroupTo(
  context: GroupOperationsContext,
  displayName: string,
): Promise<GroupOperationResult<RenameGroupResult>> {
  const state = context.runtime.groupState;
  const material = context.runtime.keyMaterial;
  if (!state || !material) {
    return failed('this machine is not in a group', 'create a group with `cluster create` first');
  }
  const renamed = renameGroup(state, displayName);
  await context.runtime.commitState(renamed, true);
  return { ok: true, data: { groupId: material.groupId, groupName: renamed.displayName } };
}

/** Groups seen advertising themselves on this network that this machine is not in. */
export function groupsOnTheNetwork(context: GroupOperationsContext): GroupOperationResult<readonly DiscoveredGroup[]> {
  return { ok: true, data: context.runtime.groupsOnTheNetwork() };
}

/**
 * Ask the group to take this machine back.
 *
 * Called on start by a machine that already has key material, and available by
 * hand when a return needs a nudge. Succeeds only if the node id is still on
 * the roster — see `decideAdmission`.
 */
export async function rejoinGroup(
  context: GroupOperationsContext,
): Promise<GroupOperationResult<JoinGroupResult>> {
  const material = context.runtime.keyMaterial;
  if (!material) {
    return failed('this machine is not in a group', 'join one with `cluster join`');
  }
  const outcome = await context.runtime.requestRejoin(ADMISSION_TIMEOUT_MS);
  if (!outcome.ok) {
    // Only an AUTHENTICATED refusal is final. Replies this machine could not
    // verify are reported honestly and left non-final, because a stranger on
    // the network can produce those and must not be able to convince a machine
    // it was removed from its own group.
    return failed(
      outcome.reason,
      'if this machine was removed from the group, join it again with `cluster join` and the current join key',
      { terminal: outcome.failure === 'refused', failure: outcome.failure },
    );
  }
  const now = context.now();
  await context.runtime.adoptMembership(
    joiningGroupKeyMaterial({
      groupId: material.groupId,
      joinKey: outcome.grant.joinKey,
      joinSalt: outcome.grant.joinSalt,
      joinVerifier: outcome.grant.joinVerifier,
      keys: outcome.grant.keys,
      currentGeneration: outcome.grant.currentGeneration,
      node: material.node,
      groupSigning: outcome.grant.groupSigning,
      now,
      graceMs: keyRotationGraceMs(context.settings),
    }),
    outcome.grant.state,
  );
  return {
    ok: true,
    data: {
      groupId: material.groupId,
      groupName: outcome.grant.state.displayName,
      memberCount: outcome.grant.state.members.length,
    },
  };
}

/** True when `state` still lists this machine. Used by the start-up rejoin decision. */
export function stillOnRoster(state: GroupStateDocument | null, nodeId: string): boolean {
  return state !== null && isCurrentMember(state, nodeId);
}

/** The verb surface the daemon serves on `/api/cluster/*`. One line per operation. */
export interface ClusterGroupVerbSurface {
  status(): GroupOperationResult<GroupStatusReport>;
  create(input: { name?: string; passphrase?: string }): Promise<GroupOperationResult<CreateGroupResult>>;
  join(input: { groupId: string; joinKey: string }): Promise<GroupOperationResult<JoinGroupResult>>;
  key(): GroupOperationResult<JoinKeyResult>;
  nodes(): GroupOperationResult<NodesResult>;
  groups(): GroupOperationResult<readonly DiscoveredGroup[]>;
  forget(nodeId: string): Promise<GroupOperationResult<ForgetNodeResult>>;
  rotate(input: { immediate?: boolean }): Promise<GroupOperationResult<RotateKeyResult>>;
  leave(): Promise<GroupOperationResult<LeaveGroupResult>>;
  rename(name: string): Promise<GroupOperationResult<RenameGroupResult>>;
}

/**
 * Bind the operations to one context.
 *
 * The daemon route module, the TUI command and any web UI all take this object
 * and nothing else, which is what keeps them renderings rather than
 * reimplementations.
 */
export function createClusterGroupVerbs(context: GroupOperationsContext): ClusterGroupVerbSurface {
  return {
    status: () => groupStatus(context),
    create: (input) => createGroup(context, {
      ...(input.name !== undefined ? { displayName: input.name } : {}),
      ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
    }),
    join: (input) => joinGroup(context, input),
    key: () => joinKeyForGroup(context),
    nodes: () => groupNodes(context),
    groups: () => groupsOnTheNetwork(context),
    forget: (nodeId) => forgetNode(context, nodeId),
    rotate: (input) => rotateGroupKey(context, input),
    leave: () => leaveGroup(context),
    rename: (name) => renameGroupTo(context, name),
  };
}
