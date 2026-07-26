/**
 * protocol-envelope.ts — the datagram every node on the group speaks.
 *
 * ONE shape, for every message type, group-level and surface-level alike:
 *
 *   { v, groupId, keyGen, surfaceId, type, nodeId, nodeVersion, seq, ts, body, sig }
 *
 * `sig` is an HMAC under the group key of the generation named by `keyGen`,
 * over a canonical serialization of everything else. A datagram that does not
 * verify never reaches any state machine — it is dropped at the edge, counted,
 * and mentioned at debug, because on a shared LAN an unverifiable packet is
 * usually a neighbour's traffic rather than an attack.
 *
 * What is deliberately NOT on the wire, ever: the join key, the group key, any
 * channel credential, any topic or chat id, any hostname or username. Surface
 * identities appear only as `surfaceId`, which is a digest — see
 * digestSurfaceId in group-crypto.ts.
 *
 * ── the dual-generation acceptance window ──────────────────────────────────
 *
 * Rotation is not atomic. For a few seconds around a cutover some members are
 * signing with generation N and some with N-1, and a node that accepted only
 * its own current generation would drop the others' heartbeats. Dropped
 * heartbeats look exactly like a dead leader: the watchdog fires, an election
 * runs, and a surface changes hands for no reason at all — every rotation,
 * forever. So a node accepts BOTH the current generation and the previous one,
 * and signs with the current. This is a correctness requirement, not a
 * convenience: see the rotation-under-traffic test.
 */
import { createHmac } from 'node:crypto';
import { secretsMatch } from './group-crypto.js';

/** Protocol version. Bumped only for a change that is not backward compatible. */
export const CLUSTER_ENVELOPE_VERSION = 1;

/**
 * Ceiling on one datagram.
 *
 * Larger than an Ethernet MTU on purpose: a roster gossip carrying every member
 * of a full group does not fit in 1500 bytes, and IP fragmentation on a local
 * network is a normal, reliable thing. Anything above this is refused rather
 * than fragmented into dozens of pieces — state that large is a bug, not a big
 * group.
 */
export const MAX_ENVELOPE_BYTES = 32_768;

/** A datagram before signing. `body` carries whatever the message type needs. */
export interface ClusterEnvelope {
  readonly v: number;
  readonly groupId: string;
  /** Which group-key generation `sig` was computed under. */
  readonly keyGen: number;
  /**
   * The surface this message concerns, as a digest, or null for a group-level
   * message such as the discovery beacon. Populated by the per-surface election
   * layer; this module only carries and authenticates it.
   */
  readonly surfaceId: string | null;
  readonly type: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly seq: number;
  readonly ts: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** An envelope as it appears on the wire. */
export interface SignedClusterEnvelope extends ClusterEnvelope {
  readonly sig: string;
}

/**
 * The group keys this node currently holds, and which of them it will accept.
 *
 * Implemented by the key store. Kept as an interface so the envelope codec has
 * no idea where keys are persisted and tests can hand it a literal.
 */
export interface ClusterKeyring {
  readonly groupId: string;
  /** The generation this node signs with. */
  readonly currentGeneration: number;
  /** The key for a generation, or null when this node does not hold it. */
  keyForGeneration(generation: number): string | null;
  /**
   * Generations whose signatures are accepted right now — the current one and,
   * during the cutover window, the one before it.
   */
  acceptedGenerations(): readonly number[];
}

/**
 * The bytes a signature covers.
 *
 * A fixed-order array rather than an object, because JSON.stringify of an
 * object serializes in insertion order: two nodes that built the same logical
 * message in a different order would produce different bytes and every
 * signature would fail across builds. `body` is canonicalized by sorting its
 * keys for the same reason.
 */
export function canonicalizeEnvelope(envelope: ClusterEnvelope): string {
  return JSON.stringify([
    envelope.v,
    envelope.groupId,
    Math.trunc(envelope.keyGen),
    envelope.surfaceId,
    envelope.type,
    envelope.nodeId,
    envelope.nodeVersion,
    Math.trunc(envelope.seq),
    Math.trunc(envelope.ts),
    canonicalizeBody(envelope.body),
  ]);
}

/** Deterministic serialization of an arbitrary JSON body, keys sorted at every depth. */
function canonicalizeBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeBody);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([key, entry]) => [key, canonicalizeBody(entry)]);
}

/** Hex HMAC-SHA256 of the canonical form under one generation's key. */
export function signEnvelope(envelope: ClusterEnvelope, groupKey: string): string {
  return createHmac('sha256', groupKey).update(canonicalizeEnvelope(envelope)).digest('hex');
}

/** Fields the caller supplies; the codec fills in the rest from the keyring. */
export interface EnvelopeDraft {
  readonly type: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly seq: number;
  readonly ts: number;
  readonly surfaceId?: string | null | undefined;
  readonly body?: Readonly<Record<string, unknown>> | undefined;
}

/** Build and sign a datagram with the keyring's CURRENT generation. */
export function encodeEnvelope(draft: EnvelopeDraft, keyring: ClusterKeyring): string {
  const keyGen = keyring.currentGeneration;
  const groupKey = keyring.keyForGeneration(keyGen);
  if (!groupKey) {
    throw new Error(`cluster: no group key is held for generation ${keyGen}; nothing can be sent`);
  }
  const envelope: ClusterEnvelope = {
    v: CLUSTER_ENVELOPE_VERSION,
    groupId: keyring.groupId,
    keyGen,
    surfaceId: draft.surfaceId ?? null,
    type: draft.type,
    nodeId: draft.nodeId,
    nodeVersion: draft.nodeVersion,
    seq: Math.trunc(draft.seq),
    ts: Math.trunc(draft.ts),
    body: draft.body ?? {},
  };
  const signed: SignedClusterEnvelope = { ...envelope, sig: signEnvelope(envelope, groupKey) };
  return JSON.stringify(signed);
}

/**
 * Build a datagram signed with a key that is NOT a group key.
 *
 * Two message classes need this, and only two:
 *
 *   JOIN / JOIN_ACCEPT / JOIN_REFUSE are authenticated with the JOIN VERIFIER,
 *   because a machine that is trying to get into the group by definition does
 *   not hold a group key yet, and its admitter has no other shared secret with
 *   it. Their `keyGen` is 0 and carries no meaning — the class of the message
 *   determines the key, not the field.
 *
 *   REJOIN / REJOIN_ACCEPT are authenticated with the sender's long-lived
 *   ed25519 IDENTITY key, checked against the public half in the roster. That
 *   is what lets a machine that has missed every rotation AND a join-key change
 *   still prove it is itself.
 *
 * Everything else on the wire is signed with the current group key by
 * {@link encodeEnvelope}, and nothing here weakens that.
 */
export function encodeEnvelopeWith(
  draft: EnvelopeDraft,
  groupId: string,
  authenticate: (canonical: string) => string,
): string {
  const envelope: ClusterEnvelope = {
    v: CLUSTER_ENVELOPE_VERSION,
    groupId,
    keyGen: 0,
    surfaceId: draft.surfaceId ?? null,
    type: draft.type,
    nodeId: draft.nodeId,
    nodeVersion: draft.nodeVersion,
    seq: Math.trunc(draft.seq),
    ts: Math.trunc(draft.ts),
    body: draft.body ?? {},
  };
  const signed: SignedClusterEnvelope = { ...envelope, sig: authenticate(canonicalizeEnvelope(envelope)) };
  return JSON.stringify(signed);
}

/**
 * Parse a datagram into its envelope and its authenticator WITHOUT checking
 * anything.
 *
 * Only the two message classes above may use this, and each must immediately
 * check the authenticator with the key its class prescribes. A caller that
 * reads an envelope here and acts on it without verifying has removed the
 * entire trust boundary, so every call site is short and does the check on the
 * next line.
 */
export function readUnverifiedEnvelope(raw: string): { envelope: ClusterEnvelope; sig: string } | null {
  if (raw.length > MAX_ENVELOPE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate['v'] !== CLUSTER_ENVELOPE_VERSION) return null;
  const envelope = readEnvelopeFields(candidate);
  const sig = candidate['sig'];
  if (!envelope || typeof sig !== 'string' || sig.length === 0) return null;
  return { envelope, sig };
}

/** Why a datagram was not accepted. `null` means it verified. */
export type EnvelopeRejection =
  | 'oversized'
  | 'not-json'
  | 'not-an-object'
  | 'unsupported-version'
  | 'other-group'
  | 'malformed-field'
  | 'generation-not-accepted'
  | 'generation-not-held'
  | 'signature-did-not-verify';

export interface EnvelopeDecodeResult {
  readonly envelope: ClusterEnvelope | null;
  readonly rejected: EnvelopeRejection | null;
  /**
   * The group the datagram claimed, even when it was refused. Lets the beacon
   * listener enumerate OTHER groups on this network without accepting anything
   * from them.
   */
  readonly claimedGroupId: string | null;
}

const TYPE_PATTERN = /^[A-Z][A-Z_]{0,31}$/;

function readEnvelopeFields(candidate: Record<string, unknown>): ClusterEnvelope | null {
  const { type, nodeId, nodeVersion, surfaceId, keyGen, seq, ts, body, groupId } = candidate;
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) return null;
  if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) return null;
  if (typeof nodeVersion !== 'string' || nodeVersion.length === 0 || nodeVersion.length > 64) return null;
  if (surfaceId !== null && (typeof surfaceId !== 'string' || surfaceId.length > 128)) return null;
  if (typeof keyGen !== 'number' || !Number.isFinite(keyGen) || keyGen < 0) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  if (typeof groupId !== 'string') return null;
  return {
    v: CLUSTER_ENVELOPE_VERSION,
    groupId,
    keyGen: Math.trunc(keyGen),
    surfaceId: surfaceId ?? null,
    type,
    nodeId,
    nodeVersion,
    seq: Math.trunc(seq),
    ts: Math.trunc(ts),
    body: body as Record<string, unknown>,
  };
}

/**
 * Parse and authenticate a datagram.
 *
 * Order matters here. The group is checked BEFORE the signature so that two
 * unrelated groups sharing one multicast address spend nothing on each other's
 * traffic beyond a string compare — and so `claimedGroupId` comes back for the
 * beacon listener even though the datagram itself is refused.
 */
export function decodeEnvelope(raw: string, keyring: ClusterKeyring): EnvelopeDecodeResult {
  if (raw.length > MAX_ENVELOPE_BYTES) {
    return { envelope: null, rejected: 'oversized', claimedGroupId: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { envelope: null, rejected: 'not-json', claimedGroupId: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { envelope: null, rejected: 'not-an-object', claimedGroupId: null };
  }
  const candidate = parsed as Record<string, unknown>;
  const claimedGroupId = typeof candidate['groupId'] === 'string' ? candidate['groupId'] : null;
  if (candidate['v'] !== CLUSTER_ENVELOPE_VERSION) {
    return { envelope: null, rejected: 'unsupported-version', claimedGroupId };
  }
  if (claimedGroupId !== keyring.groupId) {
    return { envelope: null, rejected: 'other-group', claimedGroupId };
  }
  const envelope = readEnvelopeFields(candidate);
  if (!envelope) return { envelope: null, rejected: 'malformed-field', claimedGroupId };

  if (!keyring.acceptedGenerations().includes(envelope.keyGen)) {
    return { envelope: null, rejected: 'generation-not-accepted', claimedGroupId };
  }
  const groupKey = keyring.keyForGeneration(envelope.keyGen);
  if (!groupKey) return { envelope: null, rejected: 'generation-not-held', claimedGroupId };

  const sig = candidate['sig'];
  if (typeof sig !== 'string' || !secretsMatch(sig, signEnvelope(envelope, groupKey))) {
    return { envelope: null, rejected: 'signature-did-not-verify', claimedGroupId };
  }
  return { envelope, rejected: null, claimedGroupId };
}

/**
 * Read the group a datagram claims without holding any key at all.
 *
 * This is how a node with clustering switched on but no membership enumerates
 * the groups it can see. It authenticates NOTHING — a beacon read this way is
 * an advertisement, and is treated as one: it can populate a list the operator
 * chooses from, and it can never cause this node to act.
 */
export function peekEnvelope(raw: string): { groupId: string; type: string; body: Record<string, unknown> } | null {
  if (raw.length > MAX_ENVELOPE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate['v'] !== CLUSTER_ENVELOPE_VERSION) return null;
  const groupId = candidate['groupId'];
  const type = candidate['type'];
  const body = candidate['body'];
  if (typeof groupId !== 'string' || typeof type !== 'string') return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return { groupId, type, body: body as Record<string, unknown> };
}
