/**
 * group-state.ts — the replicated membership document, and how two copies of it
 * are reconciled.
 *
 * Every member holds the whole document and every member may edit it, so the
 * merge has to be a function of the two inputs alone: no "who asked first", no
 * clock comparison, nothing that depends on which node ran the merge. That is
 * what makes a partition heal into one answer instead of two.
 *
 * The document is PUBLIC to the group. It holds public keys and display names
 * and nothing else — no join key, no group key, no surface, no hostname. The
 * secret half lives in the encrypted key store (group-store.ts) and is never
 * written here.
 */

/** One machine in the group. */
export interface GroupMember {
  readonly nodeId: string;
  /** Operator-facing label for this machine. Never a hostname unless typed as one. */
  readonly displayName: string;
  /** ed25519 public key — how this node proves it is itself, forever. */
  readonly identityKey: string;
  /** x25519 public key — where a new group key is sealed to. */
  readonly agreementKey: string;
  readonly admittedAt: number;
  readonly lastSeenAt: number;
  /**
   * Membership generation for this node id. Monotonic per node: an add sets
   * it, a later removal sets it higher, a later re-add higher still.
   */
  readonly gen: number;
}

/**
 * A removal. Not the absence of a member — the PRESENCE of a refusal.
 *
 * An absent member is indistinguishable from a member this copy has not
 * learned about yet, so a merge that treated absence as removal would let a
 * node that had never heard of the removal re-add the removed machine. A
 * tombstone is a positive fact that survives the merge.
 */
export interface GroupTombstone {
  readonly nodeId: string;
  readonly gen: number;
  readonly at: number;
  /** Short plain-language reason, shown in `cluster nodes`. Never a hostname. */
  readonly reason: string;
}

/** The whole replicated document. */
export interface GroupStateDocument {
  /** Schema version — a document from a future build is refused, not guessed at. */
  readonly version: 1;
  readonly groupId: string;
  /**
   * The name shown in the discovery beacon, so it is visible to anything on
   * this network that is listening. Replicated: renaming on any member renames
   * everywhere.
   */
  readonly displayName: string;
  /** Last-writer-wins counter for `displayName`. */
  readonly displayNameGen: number;
  readonly members: readonly GroupMember[];
  readonly tombstones: readonly GroupTombstone[];
  /**
   * The public half of the GROUP's signing key, and its generation.
   *
   * Replicated because a machine that has been away has to be able to check a
   * reply against the group rather than against whichever member answered — and
   * its own copy of this is the one it stored the day it joined. Higher
   * generation wins, exactly like every other record here.
   */
  readonly groupSigning: GroupSigningPublicKey;
}

/** The group's signing public key at one generation. */
export interface GroupSigningPublicKey {
  readonly publicKey: string;
  readonly generation: number;
}

/** The neutral name a group gets when the operator does not choose one. */
export const DEFAULT_GROUP_DISPLAY_NAME = 'goodvibes group';

/**
 * Bounds. Persisted state that can only grow is a slow leak, so both lists are
 * capped and swept — see `sweepGroupState`.
 *
 * 64 members is far past any homelab and still a trivial document to gossip.
 * 256 tombstones at 180 days is likewise generous; the reasoning for why
 * expiring a tombstone is SAFE is on `sweepGroupState`.
 */
export const MAX_GROUP_MEMBERS = 64;
export const MAX_GROUP_TOMBSTONES = 256;
export const GROUP_TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
/** Longest a display name may be. Long enough to be descriptive, short enough to fit a beacon. */
export const MAX_GROUP_DISPLAY_NAME_LENGTH = 48;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Trim and cap a display name; empty input falls back to the neutral default. */
export function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return fallback;
  return collapsed.slice(0, MAX_GROUP_DISPLAY_NAME_LENGTH);
}

// ── validation ──────────────────────────────────────────────────────────────

function readMember(value: unknown): GroupMember | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['nodeId'], 128)) return null;
  if (!isNonEmptyString(candidate['identityKey'], 128)) return null;
  if (!isNonEmptyString(candidate['agreementKey'], 128)) return null;
  if (!isFiniteNumber(candidate['admittedAt']) || !isFiniteNumber(candidate['gen'])) return null;
  const lastSeenAt = isFiniteNumber(candidate['lastSeenAt']) ? candidate['lastSeenAt'] : candidate['admittedAt'];
  return {
    nodeId: candidate['nodeId'],
    displayName: normalizeDisplayName(candidate['displayName'], candidate['nodeId'].slice(0, 8)),
    identityKey: candidate['identityKey'],
    agreementKey: candidate['agreementKey'],
    admittedAt: Math.trunc(candidate['admittedAt']),
    lastSeenAt: Math.trunc(lastSeenAt),
    gen: Math.max(0, Math.trunc(candidate['gen'])),
  };
}

function readGroupSigningPublicKey(value: unknown): GroupSigningPublicKey | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['publicKey'], 128)) return null;
  if (!isFiniteNumber(candidate['generation']) || candidate['generation'] < 0) return null;
  return { publicKey: candidate['publicKey'], generation: Math.trunc(candidate['generation']) };
}

function readTombstone(value: unknown): GroupTombstone | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate['nodeId'], 128)) return null;
  if (!isFiniteNumber(candidate['gen']) || !isFiniteNumber(candidate['at'])) return null;
  return {
    nodeId: candidate['nodeId'],
    gen: Math.max(0, Math.trunc(candidate['gen'])),
    at: Math.trunc(candidate['at']),
    reason: normalizeDisplayName(candidate['reason'], 'removed'),
  };
}

/**
 * Parse an untrusted document — from disk after a crash, or off the wire from a
 * peer running a different build.
 *
 * Malformed ENTRIES are dropped individually rather than failing the whole
 * document: one corrupt member record should cost that record, not the group.
 * A malformed DOCUMENT returns null, and the caller decides what that means
 * (on disk: start over and say so; on the wire: drop the datagram).
 */
export function readGroupStateDocument(value: unknown): GroupStateDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['version'] !== 1) return null;
  if (!isNonEmptyString(candidate['groupId'], 64)) return null;
  const rawMembers = Array.isArray(candidate['members']) ? candidate['members'] : [];
  const rawTombstones = Array.isArray(candidate['tombstones']) ? candidate['tombstones'] : [];
  const members = rawMembers.map(readMember).filter((entry): entry is GroupMember => entry !== null);
  const tombstones = rawTombstones
    .map(readTombstone)
    .filter((entry): entry is GroupTombstone => entry !== null);
  return normalizeGroupState({
    version: 1,
    groupId: candidate['groupId'],
    displayName: normalizeDisplayName(candidate['displayName'], DEFAULT_GROUP_DISPLAY_NAME),
    displayNameGen: isFiniteNumber(candidate['displayNameGen'])
      ? Math.max(0, Math.trunc(candidate['displayNameGen']))
      : 0,
    members,
    tombstones,
    groupSigning: readGroupSigningPublicKey(candidate['groupSigning']) ?? { publicKey: '', generation: -1 },
  });
}

/** An empty document for a group that has just been created. */
export function createGroupStateDocument(
  groupId: string,
  displayName: string,
  groupSigning: GroupSigningPublicKey = { publicKey: '', generation: -1 },
): GroupStateDocument {
  return {
    version: 1,
    groupId,
    displayName: normalizeDisplayName(displayName, DEFAULT_GROUP_DISPLAY_NAME),
    displayNameGen: 1,
    members: [],
    tombstones: [],
    groupSigning,
  };
}

/** Publish a newly minted group signing public key into the replicated document. */
export function withGroupSigningKey(
  state: GroupStateDocument,
  groupSigning: GroupSigningPublicKey,
): GroupStateDocument {
  if (groupSigning.generation <= state.groupSigning.generation) return state;
  return { ...state, groupSigning };
}

// ── merge ───────────────────────────────────────────────────────────────────

/**
 * Deduplicate and order a document so two copies holding the same facts
 * serialize identically. Ordering by node id (not by time) keeps the
 * comparison stable regardless of what order updates arrived in.
 */
function normalizeGroupState(state: GroupStateDocument): GroupStateDocument {
  const members = new Map<string, GroupMember>();
  for (const member of state.members) {
    const existing = members.get(member.nodeId);
    if (!existing || member.gen > existing.gen) members.set(member.nodeId, member);
  }
  const tombstones = new Map<string, GroupTombstone>();
  for (const tombstone of state.tombstones) {
    const existing = tombstones.get(tombstone.nodeId);
    if (!existing || tombstone.gen > existing.gen) tombstones.set(tombstone.nodeId, tombstone);
  }
  // A tombstone at or above a member's generation removes it. Equal generations
  // resolve to REMOVED deliberately: see mergeGroupState.
  for (const [nodeId, tombstone] of tombstones) {
    const member = members.get(nodeId);
    if (member && tombstone.gen >= member.gen) members.delete(nodeId);
  }
  return {
    ...state,
    members: [...members.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
    tombstones: [...tombstones.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
  };
}

/**
 * Reconcile two copies of the document.
 *
 * The rules, in full:
 *
 *  - per node id, the HIGHEST membership generation wins, whether that record
 *    is an add or a tombstone;
 *  - at EQUAL generation a tombstone beats an add. Removal is always written
 *    at a generation above any add the writer has seen, so an equal generation
 *    means two copies disagree about the same step — and resolving that toward
 *    "removed" is the only direction that cannot resurrect a machine the
 *    operator deliberately ejected. The reverse rule would mean a node that
 *    was partitioned away during the removal could re-add it on heal;
 *  - `lastSeenAt` takes the later of the two, since both are true observations;
 *  - the display name takes the higher `displayNameGen`, and at equal
 *    generation the lexicographically smaller name, so the tie resolves the
 *    same way on every node rather than flapping between them.
 *
 * Do not "simplify" the equal-generation tombstone rule into a plain
 * generation comparison. It is the partition case, and it is tested.
 */
export function mergeGroupState(local: GroupStateDocument, remote: GroupStateDocument): GroupStateDocument {
  if (local.groupId !== remote.groupId) return local;

  const members = new Map<string, GroupMember>();
  for (const member of [...local.members, ...remote.members]) {
    const existing = members.get(member.nodeId);
    if (!existing) {
      members.set(member.nodeId, member);
      continue;
    }
    const winner = member.gen > existing.gen ? member : existing;
    members.set(member.nodeId, {
      ...winner,
      lastSeenAt: Math.max(existing.lastSeenAt, member.lastSeenAt),
    });
  }

  const tombstones = new Map<string, GroupTombstone>();
  for (const tombstone of [...local.tombstones, ...remote.tombstones]) {
    const existing = tombstones.get(tombstone.nodeId);
    if (!existing || tombstone.gen > existing.gen) tombstones.set(tombstone.nodeId, tombstone);
  }

  const nameWins = remote.displayNameGen > local.displayNameGen
    || (remote.displayNameGen === local.displayNameGen && remote.displayName < local.displayName);

  return normalizeGroupState({
    version: 1,
    groupId: local.groupId,
    displayName: nameWins ? remote.displayName : local.displayName,
    displayNameGen: Math.max(local.displayNameGen, remote.displayNameGen),
    members: [...members.values()],
    tombstones: [...tombstones.values()],
    // The signing key rotates only on a removal, so the higher generation is by
    // construction the one written after the more recent removal.
    groupSigning: remote.groupSigning.generation > local.groupSigning.generation
      ? remote.groupSigning
      : local.groupSigning,
  });
}

// ── edits ───────────────────────────────────────────────────────────────────

/** The next membership generation to write for `nodeId`, above every record held. */
export function nextMembershipGeneration(state: GroupStateDocument, nodeId: string): number {
  const member = state.members.find((entry) => entry.nodeId === nodeId);
  const tombstone = state.tombstones.find((entry) => entry.nodeId === nodeId);
  return Math.max(member?.gen ?? 0, tombstone?.gen ?? 0) + 1;
}

/** True when `nodeId` is currently a member (present, and not tombstoned above it). */
export function isCurrentMember(state: GroupStateDocument, nodeId: string): boolean {
  return state.members.some((entry) => entry.nodeId === nodeId);
}

/** The removal record for `nodeId`, if the group holds one. */
export function findTombstone(state: GroupStateDocument, nodeId: string): GroupTombstone | null {
  return state.tombstones.find((entry) => entry.nodeId === nodeId) ?? null;
}

export interface AdmitMemberInput {
  readonly nodeId: string;
  readonly displayName: string;
  readonly identityKey: string;
  readonly agreementKey: string;
  readonly now: number;
}

/** Why an admission was refused, in words that name the fix. */
export type AdmitRefusal = 'group-is-full' | 'node-was-removed';

export interface AdmitOutcome {
  readonly state: GroupStateDocument;
  readonly refused: AdmitRefusal | null;
}

/**
 * Add (or re-add) a member.
 *
 * A tombstoned node is refused here rather than silently re-added: undoing a
 * removal is an operator decision. `readmitMember` is the deliberate path, and
 * it is reached only by a request that proved the CURRENT join key.
 */
export function admitMember(state: GroupStateDocument, input: AdmitMemberInput): AdmitOutcome {
  if (findTombstone(state, input.nodeId)) return { state, refused: 'node-was-removed' };
  if (!isCurrentMember(state, input.nodeId) && state.members.length >= MAX_GROUP_MEMBERS) {
    return { state, refused: 'group-is-full' };
  }
  const gen = nextMembershipGeneration(state, input.nodeId);
  const existing = state.members.find((entry) => entry.nodeId === input.nodeId);
  const member: GroupMember = {
    nodeId: input.nodeId,
    displayName: normalizeDisplayName(input.displayName, input.nodeId.slice(0, 8)),
    identityKey: input.identityKey,
    agreementKey: input.agreementKey,
    admittedAt: existing?.admittedAt ?? Math.trunc(input.now),
    lastSeenAt: Math.trunc(input.now),
    gen,
  };
  return {
    state: normalizeGroupState({
      ...state,
      members: [...state.members.filter((entry) => entry.nodeId !== input.nodeId), member],
    }),
    refused: null,
  };
}

/**
 * Put a removed machine back.
 *
 * Clears the tombstone and admits at a generation above it, so the add wins
 * every subsequent merge. Reached ONLY from a request that proved the current
 * join key — see rule 3 of `decideAdmission`. A stale add arriving from a
 * partitioned peer still loses to the tombstone, because a stale add is not a
 * join and never reaches here.
 */
export function readmitMember(state: GroupStateDocument, input: AdmitMemberInput): AdmitOutcome {
  const cleared = normalizeGroupState({
    ...state,
    tombstones: state.tombstones.filter((entry) => entry.nodeId !== input.nodeId),
  });
  const gen = Math.max(
    nextMembershipGeneration(cleared, input.nodeId),
    (findTombstone(state, input.nodeId)?.gen ?? 0) + 1,
  );
  if (!isCurrentMember(cleared, input.nodeId) && cleared.members.length >= MAX_GROUP_MEMBERS) {
    return { state, refused: 'group-is-full' };
  }
  return {
    state: normalizeGroupState({
      ...cleared,
      members: [...cleared.members.filter((entry) => entry.nodeId !== input.nodeId), {
        nodeId: input.nodeId,
        displayName: normalizeDisplayName(input.displayName, input.nodeId.slice(0, 8)),
        identityKey: input.identityKey,
        agreementKey: input.agreementKey,
        admittedAt: Math.trunc(input.now),
        lastSeenAt: Math.trunc(input.now),
        gen,
      }],
    }),
    refused: null,
  };
}

/**
 * Remove a member and write the tombstone that keeps it removed.
 *
 * The generation is taken ABOVE every record this copy holds for that node, so
 * a peer that only learns of the removal later cannot have an add that outranks
 * it. Rotating the group key alongside this is what makes the removal bite —
 * that is the caller's job, and group-runtime.ts does it in the same step.
 */
export function removeMember(
  state: GroupStateDocument,
  nodeId: string,
  reason: string,
  now: number,
): GroupStateDocument {
  const gen = nextMembershipGeneration(state, nodeId);
  return normalizeGroupState({
    ...state,
    tombstones: [
      ...state.tombstones.filter((entry) => entry.nodeId !== nodeId),
      { nodeId, gen, at: Math.trunc(now), reason: normalizeDisplayName(reason, 'removed') },
    ],
  });
}

/** Record that a member was heard from. */
export function touchMember(state: GroupStateDocument, nodeId: string, now: number): GroupStateDocument {
  if (!isCurrentMember(state, nodeId)) return state;
  return {
    ...state,
    members: state.members.map((entry) => (
      entry.nodeId === nodeId ? { ...entry, lastSeenAt: Math.max(entry.lastSeenAt, Math.trunc(now)) } : entry
    )),
  };
}

/** Rename the group everywhere. The new name is replicated on the next gossip. */
export function renameGroup(state: GroupStateDocument, displayName: string): GroupStateDocument {
  return {
    ...state,
    displayName: normalizeDisplayName(displayName, DEFAULT_GROUP_DISPLAY_NAME),
    displayNameGen: state.displayNameGen + 1,
  };
}

// ── sweep ───────────────────────────────────────────────────────────────────

export interface GroupStateSweepResult {
  readonly state: GroupStateDocument;
  readonly droppedTombstones: number;
}

/**
 * Bound the document. Called on load and periodically thereafter.
 *
 * Tombstones expire after {@link GROUP_TOMBSTONE_MAX_AGE_MS} and are capped at
 * {@link MAX_GROUP_TOMBSTONES}, oldest dropped first. Expiring a removal sounds
 * dangerous and is not, for one specific reason: a removed machine is refused
 * because its node id IS NOT ON THE ROSTER, and dropping the tombstone does not
 * put it back. The tombstone's only job is to beat a stale add during the
 * window when some peer might still be carrying one, and 180 days is far longer
 * than any partition that ends in a heal rather than a rebuild.
 *
 * Members are NOT swept by age. A machine that has been off all winter is still
 * a member, and reaping it would mean the operator has to re-join it by hand —
 * exactly the zero-touch return this design exists to provide.
 */
export function sweepGroupState(state: GroupStateDocument, now: number): GroupStateSweepResult {
  const cutoff = now - GROUP_TOMBSTONE_MAX_AGE_MS;
  const fresh = state.tombstones.filter((entry) => entry.at >= cutoff);
  const kept = fresh.length <= MAX_GROUP_TOMBSTONES
    ? fresh
    : [...fresh].sort((a, b) => b.at - a.at).slice(0, MAX_GROUP_TOMBSTONES);
  if (kept.length === state.tombstones.length) return { state, droppedTombstones: 0 };
  return {
    state: normalizeGroupState({ ...state, tombstones: kept }),
    droppedTombstones: state.tombstones.length - kept.length,
  };
}
