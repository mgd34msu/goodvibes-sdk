/**
 * group-membership.ts — the datagrams that get a machine into the group, and
 * the rule that decides whether it may come in.
 *
 * There are exactly two ways in, and they are not variations of each other:
 *
 *   JOIN    a machine the group has never seen proves it holds the CURRENT
 *           join key. This is the only path that can grow the roster.
 *
 *   REJOIN  a machine ALREADY ON THE ROSTER proves it is itself, with a
 *           long-lived key that no rotation and no join-key change touches.
 *           This path cannot grow the roster; it can only re-key a member the
 *           group already agreed to.
 *
 * Read the comment on `decideAdmission` before changing anything here. The rule
 * looks like it could be collapsed into one branch and it cannot.
 */
import { createHmac } from 'node:crypto';
import {
  isWrappedKeyEnvelope,
  openSealedEnvelope,
  sealForMember,
  secretsMatch,
  signWithIdentity,
  verifyWithIdentity,
  type NodeKeyMaterial,
  type NodeKeyPairMaterial,
  type WrappedKeyEnvelope,
} from './group-crypto.js';
import {
  findTombstone,
  isCurrentMember,
  readGroupStateDocument,
  type GroupStateDocument,
} from './group-state.js';
import {
  readGroupSigningMaterial,
  readKeyRecord,
  type GroupKeyRecord,
  type GroupSigningMaterial,
} from './group-store.js';
import {
  canonicalizeEnvelope,
  encodeEnvelopeWith,
  readUnverifiedEnvelope,
  type ClusterEnvelope,
  type EnvelopeDraft,
} from './protocol-envelope.js';

/** Every message type this layer speaks. */
export const GROUP_MESSAGE_TYPES = {
  beacon: 'BEACON',
  roster: 'ROSTER',
  rekey: 'REKEY',
  join: 'JOIN',
  joinAccept: 'JOIN_ACCEPT',
  joinRefuse: 'JOIN_REFUSE',
  rejoin: 'REJOIN',
  rejoinAccept: 'REJOIN_ACCEPT',
  /**
   * An explicit "no" to a returning machine.
   *
   * Signed with the REFUSER'S identity key, not the group key. A machine that
   * was away across a removal cannot verify the current group key by
   * definition, but it can verify any member that was on the roster it stored
   * before it left — which is exactly who is answering. Without this message a
   * refused return is simply silence, and the returning machine waits out its
   * whole timeout only to be told, wrongly, that nobody answered.
   */
  rejoinRefuse: 'REJOIN_REFUSE',
} as const;

/** Message classes authenticated with the join verifier rather than a group key. */
const JOIN_CLASS: ReadonlySet<string> = new Set([
  GROUP_MESSAGE_TYPES.join,
  GROUP_MESSAGE_TYPES.joinAccept,
  GROUP_MESSAGE_TYPES.joinRefuse,
]);

/** Message classes authenticated with the sender's long-lived identity key. */
const IDENTITY_CLASS: ReadonlySet<string> = new Set([
  GROUP_MESSAGE_TYPES.rejoinRefuse,
  GROUP_MESSAGE_TYPES.rejoin,
  GROUP_MESSAGE_TYPES.rejoinAccept,
]);

/** True when this type is authenticated by something other than the group key. */
export function isOutOfBandMessageType(type: string): boolean {
  return JOIN_CLASS.has(type) || IDENTITY_CLASS.has(type);
}

/**
 * How stale an admission request may be.
 *
 * Bounds replay: a JOIN captured off the wire cannot be re-sent tomorrow. Wide
 * enough that two homelab machines whose clocks have drifted by a minute still
 * talk to each other, since neither is running NTP as a precondition.
 */
export const ADMISSION_FRESHNESS_MS = 5 * 60 * 1_000;

const SEAL_CONTEXT_JOIN = 'goodvibes-cluster-join-v1';
const SEAL_CONTEXT_REJOIN = 'goodvibes-cluster-rekey-v1';

/** HMAC-SHA256, hex, over an already-canonicalized envelope. */
function authenticateWithSharedKey(canonical: string, key: string): string {
  return createHmac('sha256', key).update(canonical).digest('hex');
}

// ── the admission rule ──────────────────────────────────────────────────────

export type AdmissionRefusal =
  | 'join-key-did-not-match'
  | 'identity-did-not-match'
  | 'not-on-the-roster'
  | 'removed-from-the-group'
  | 'request-is-stale'
  | 'group-is-full';

export type AdmissionDecision =
  | { readonly admit: true; readonly path: 'join' | 'rejoin' }
  | { readonly admit: false; readonly reason: AdmissionRefusal };

export interface AdmissionRequest {
  readonly nodeId: string;
  readonly ts: number;
  readonly now: number;
  /** True when the request carried a valid proof of the CURRENT join key. */
  readonly provedCurrentJoinKey: boolean;
  /**
   * True when the request carried a valid proof of a HISTORICAL key — the
   * node's own long-lived identity key, or a group key from an earlier
   * generation. Both mean the same thing: "this machine was in this group
   * before".
   */
  readonly provedHistoricalKey: boolean;
}

/**
 * Decide whether a machine may come in.
 *
 * THE RULE, and the reasoning, which must survive anybody later deciding this
 * is more complicated than it needs to be:
 *
 *  1. A valid proof of the CURRENT join key admits anyone. That is what the
 *     join key is for, and it is the only way a machine the group has never
 *     seen can be added.
 *
 *  2. A valid proof of ANY HISTORICAL key admits a node IF AND ONLY IF its node
 *     id is already on the roster. The machine is then re-keyed to the current
 *     generation immediately.
 *
 *     Why the roster condition is not optional: an old group key is a secret
 *     that leaks with time. It sat on a disk that was retired, in a backup, on
 *     a machine that was sold. If an old key ALONE were sufficient, then every
 *     key the group has ever used would remain a permanent way in and rotating
 *     would accomplish nothing. Requiring roster presence means an old key can
 *     only ever re-admit a machine the operator ALREADY decided belongs — it
 *     grants no new membership, so its leak grants no access.
 *
 *     Why it is worth having at all: it is what makes a machine that has been
 *     off for six months — through dozens of group-key rotations and a join-key
 *     change — come back by itself, with the operator doing nothing. Without
 *     it, every power cut on a homelab node ends in an SSH session.
 *
 *  3. A REMOVED node — one with a tombstone — is refused on the historical-key
 *     path, always. That is the path a partitioned peer or an old disk takes,
 *     and neither may bring back a machine the operator ejected.
 *
 *     It is NOT refused on the current-join-key path. Presenting the current
 *     join key is the operator deliberately putting the machine back, using a
 *     secret only members hold, and refusing that would mean a removal made by
 *     mistake permanently bans that node id with no way back short of deleting
 *     its identity file. The re-admission writes an add ABOVE the tombstone and
 *     clears it, so the partition property in rule 3's first paragraph is
 *     untouched: a stale add still loses, because a stale add is not a join.
 *
 *  Do not merge cases 1 and 2 into "any valid proof admits". That single change
 *  would turn every retired disk in the house into a permanent group
 *  credential.
 */
export function decideAdmission(
  state: GroupStateDocument,
  request: AdmissionRequest,
  maxMembers: number,
): AdmissionDecision {
  if (Math.abs(request.now - request.ts) > ADMISSION_FRESHNESS_MS) {
    return { admit: false, reason: 'request-is-stale' };
  }
  if (request.provedCurrentJoinKey) {
    if (!isCurrentMember(state, request.nodeId) && state.members.length >= maxMembers) {
      return { admit: false, reason: 'group-is-full' };
    }
    return { admit: true, path: 'join' };
  }
  if (findTombstone(state, request.nodeId)) {
    return { admit: false, reason: 'removed-from-the-group' };
  }
  if (!request.provedHistoricalKey) {
    return { admit: false, reason: 'identity-did-not-match' };
  }
  // Rule 2. The roster check is the whole safety property — see above.
  if (!isCurrentMember(state, request.nodeId)) {
    return { admit: false, reason: 'not-on-the-roster' };
  }
  return { admit: true, path: 'rejoin' };
}

/** Plain-language refusal text, naming what the operator should do about it. */
export function describeRefusal(reason: AdmissionRefusal): string {
  switch (reason) {
    case 'join-key-did-not-match':
      return 'that join key does not match this group — check it with `cluster key` on a machine already in the group';
    case 'identity-did-not-match':
      return 'this machine could not prove it is the node id it claims';
    case 'not-on-the-roster':
      return 'this machine is not a member of the group — join it with the current join key';
    case 'removed-from-the-group':
      return 'this machine was removed from the group — join it again with the current join key to undo that';
    case 'request-is-stale':
      return 'the request was too old to accept — check that the clocks on both machines are roughly right';
    case 'group-is-full':
      return 'the group is at its member limit — remove a machine first with `cluster forget`';
  }
}

// ── message bodies ──────────────────────────────────────────────────────────

/** What a joining machine tells the group about itself. */
export interface JoinRequestBody {
  readonly displayName: string;
  readonly identityKey: string;
  readonly agreementKey: string;
}

/** What a returning member tells the group. */
export interface RejoinRequestBody extends JoinRequestBody {
  /** Group-key generations this node still holds, newest first. Advisory only. */
  readonly heldGenerations: readonly number[];
}

/** The secret half of an acceptance, sealed to exactly one recipient. */
export interface AdmissionGrant {
  readonly joinKey: string;
  readonly joinSalt: string;
  readonly joinVerifier: string;
  readonly keys: readonly GroupKeyRecord[];
  readonly currentGeneration: number;
  readonly state: GroupStateDocument;
  /**
   * The group's signing key pair. Handed over so this machine can answer a
   * returning member AS THE GROUP, and so it holds the public half to check
   * such an answer with if it is ever the one coming back.
   */
  readonly groupSigning: GroupSigningMaterial;
}

function readJoinRequestBody(body: Record<string, unknown>): JoinRequestBody | null {
  const displayName = body['displayName'];
  const identityKey = body['identityKey'];
  const agreementKey = body['agreementKey'];
  if (typeof identityKey !== 'string' || identityKey.length === 0) return null;
  if (typeof agreementKey !== 'string' || agreementKey.length === 0) return null;
  return {
    displayName: typeof displayName === 'string' ? displayName : '',
    identityKey,
    agreementKey,
  };
}

/** Parse and validate a JOIN body. */
export function parseJoinRequestBody(body: Record<string, unknown>): JoinRequestBody | null {
  return readJoinRequestBody(body);
}

/** Parse and validate a REJOIN body. */
export function parseRejoinRequestBody(body: Record<string, unknown>): RejoinRequestBody | null {
  const base = readJoinRequestBody(body);
  if (!base) return null;
  const held = Array.isArray(body['heldGenerations']) ? body['heldGenerations'] : [];
  return {
    ...base,
    heldGenerations: held.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)),
  };
}

function readKeyRecords(value: unknown): GroupKeyRecord[] {
  if (!Array.isArray(value)) return [];
  // Exactly the same validation the on-disk store uses: a key that arrives over
  // the wire and a key read back from disk must never be held to different
  // standards.
  return value.map(readKeyRecord).filter((entry): entry is GroupKeyRecord => entry !== null);
}

/** Validate a sealed grant that has already been opened and JSON-parsed. */
export function readAdmissionGrant(value: unknown): AdmissionGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['joinKey'] !== 'string' || candidate['joinKey'].length === 0) return null;
  if (typeof candidate['joinSalt'] !== 'string' || typeof candidate['joinVerifier'] !== 'string') return null;
  const currentGeneration = candidate['currentGeneration'];
  if (typeof currentGeneration !== 'number' || !Number.isFinite(currentGeneration)) return null;
  const state = readGroupStateDocument(candidate['state']);
  if (!state) return null;
  const keys = readKeyRecords(candidate['keys']);
  if (!keys.some((entry) => entry.generation === Math.trunc(currentGeneration))) return null;
  const groupSigning = readGroupSigningMaterial(candidate['groupSigning']);
  if (!groupSigning) return null;
  return {
    joinKey: candidate['joinKey'],
    joinSalt: candidate['joinSalt'],
    joinVerifier: candidate['joinVerifier'],
    keys,
    currentGeneration: Math.trunc(currentGeneration),
    state,
    groupSigning,
  };
}

// ── building out-of-band datagrams ──────────────────────────────────────────

/** Build a JOIN / JOIN_ACCEPT / JOIN_REFUSE datagram, signed with the join verifier. */
export function encodeJoinClassMessage(draft: EnvelopeDraft, groupId: string, joinVerifier: string): string {
  return encodeEnvelopeWith(draft, groupId, (canonical) => authenticateWithSharedKey(canonical, joinVerifier));
}

/**
 * Build a REJOIN / REJOIN_ACCEPT datagram, signed with an ed25519 key pair.
 *
 * A REJOIN is signed with the requesting node's own identity key, because the
 * roster is where the group looks it up. A REJOIN_ACCEPT is signed with the
 * GROUP's signing key, because the returning machine's roster is stale and the
 * only thing it can be sure of is what the group looked like when it left.
 */
export function encodeIdentityClassMessage(
  draft: EnvelopeDraft,
  groupId: string,
  signer: NodeKeyPairMaterial,
): string {
  return encodeEnvelopeWith(draft, groupId, (canonical) => signWithIdentity(signer, canonical));
}

// ── verifying out-of-band datagrams ────────────────────────────────────────

export interface OutOfBandCheck {
  readonly envelope: ClusterEnvelope;
  /** True when the join-verifier signature matched. */
  readonly joinKeyProved: boolean;
  /** True when the sender's identity signature matched the key supplied. */
  readonly identityProved: boolean;
}

/**
 * Check a join-class datagram against the group's CURRENT join verifier.
 *
 * Returns null when the datagram is not a join-class message at all. A
 * join-class datagram whose signature does not match comes back with
 * `joinKeyProved: false`, and the caller refuses it out loud rather than
 * silently — a mistyped join key is the single most likely thing to go wrong
 * here, and silence would leave the operator with no idea why nothing happened.
 */
export function checkJoinClassMessage(raw: string, joinVerifier: string): OutOfBandCheck | null {
  const read = readUnverifiedEnvelope(raw);
  if (!read || !JOIN_CLASS.has(read.envelope.type)) return null;
  const expected = authenticateWithSharedKey(canonicalizeEnvelope(read.envelope), joinVerifier);
  return { envelope: read.envelope, joinKeyProved: secretsMatch(read.sig, expected), identityProved: false };
}

/**
 * Check an identity-class datagram against a public key.
 *
 * The caller supplies the key, and where it got it IS the security property:
 * for a REJOIN it comes from the ROSTER, never from the datagram itself. A
 * datagram carrying its own identity key and being checked against that key
 * proves nothing whatsoever.
 */
export function checkIdentityClassMessage(raw: string, identityPublicKey: string): OutOfBandCheck | null {
  const read = readUnverifiedEnvelope(raw);
  if (!read || !IDENTITY_CLASS.has(read.envelope.type)) return null;
  return {
    envelope: read.envelope,
    joinKeyProved: false,
    identityProved: verifyWithIdentity(identityPublicKey, canonicalizeEnvelope(read.envelope), read.sig),
  };
}

/** Read an identity-class datagram's envelope without checking anything. */
export function peekIdentityClassMessage(raw: string): ClusterEnvelope | null {
  const read = readUnverifiedEnvelope(raw);
  if (!read || !IDENTITY_CLASS.has(read.envelope.type)) return null;
  return read.envelope;
}

// ── sealing ─────────────────────────────────────────────────────────────────

/** Seal a grant so only the holder of `recipientAgreementKey`'s private half reads it. */
export function sealGrant(
  grant: AdmissionGrant,
  recipientAgreementKey: string,
  path: 'join' | 'rejoin',
): WrappedKeyEnvelope {
  return sealForMember(
    recipientAgreementKey,
    JSON.stringify(grant),
    path === 'join' ? SEAL_CONTEXT_JOIN : SEAL_CONTEXT_REJOIN,
  );
}

/** Open a grant sealed by {@link sealGrant}. Null on any failure at all. */
export function openGrant(node: NodeKeyMaterial, sealed: unknown, path: 'join' | 'rejoin'): AdmissionGrant | null {
  if (!isWrappedKeyEnvelope(sealed)) return null;
  const opened = openSealedEnvelope(
    node.agreement,
    sealed,
    path === 'join' ? SEAL_CONTEXT_JOIN : SEAL_CONTEXT_REJOIN,
  );
  if (!opened) return null;
  try {
    return readAdmissionGrant(JSON.parse(opened));
  } catch {
    return null;
  }
}
