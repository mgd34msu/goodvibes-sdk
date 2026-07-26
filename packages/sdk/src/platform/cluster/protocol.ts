/**
 * protocol.ts — datagram encoding, and the optional shared-secret signature.
 *
 * The wire format is one JSON object per datagram. It is deliberately small
 * and deliberately boring: a node that cannot parse a datagram drops it and
 * says so at debug, because a malformed packet on a shared LAN port is a
 * neighbour's traffic, not an incident.
 *
 * Fields: `v`, `surfaceId`, `type`, `nodeId`, `nodeVersion`, `seq`, `ts`, and
 * `sig` when signing. `surfaceId` is a DIGEST and is the reason a topic name
 * never reaches the network — see surface-id.ts. It is null on a group-level
 * datagram, which this module never sends but must decode.
 *
 * Signing is opt-in. With `cluster.secret` empty the protocol runs unsigned,
 * which is the right default for a home LAN where the alternative is an
 * operator who never turns the feature on. With a secret set, EVERY inbound
 * datagram must carry a signature that verifies against it — an unsigned or
 * wrongly-signed datagram is dropped, so a stray process without the secret
 * can never take a surface.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSurfaceId } from './surface-id.js';
import { CLUSTER_PROTOCOL_VERSION, type ClusterMessage, type SignedClusterMessage } from './types.js';

/** Guards against a hostile or accidental oversized datagram. */
const MAX_DATAGRAM_BYTES = 4_096;

const MESSAGE_TYPES = new Set(['PROBE', 'CLAIM', 'HEARTBEAT', 'RESIGN']);

/**
 * The bytes a signature covers.
 *
 * Field order is fixed here rather than taken from JSON.stringify of the whole
 * object, so a signature computed on one node verifies on another regardless
 * of how either built the object. `surfaceId` is inside the signed form: an
 * unsigned surfaceId could be rewritten in flight to redirect a claim at a
 * different surface.
 */
export function canonicalizeMessage(message: ClusterMessage): string {
  return JSON.stringify([
    Math.trunc(message.v),
    message.type,
    message.surfaceId,
    message.nodeId,
    message.nodeVersion,
    Math.trunc(message.seq),
    Math.trunc(message.ts),
  ]);
}

/** Hex HMAC-SHA256 of the canonical form. */
export function signMessage(message: ClusterMessage, secret: string): string {
  return createHmac('sha256', secret).update(canonicalizeMessage(message)).digest('hex');
}

/** Serialize for the wire, signing when a secret is configured. */
export function encodeMessage(message: ClusterMessage, secret: string): string {
  const signed: SignedClusterMessage = secret
    ? { ...message, sig: signMessage(message, secret) }
    : message;
  return JSON.stringify(signed);
}

/** Why a datagram was not accepted. `null` reason means it decoded cleanly. */
export interface ClusterDecodeResult {
  readonly message: ClusterMessage | null;
  readonly rejected: string | null;
}

/**
 * Parse and authenticate a datagram.
 *
 * When `secret` is set the signature is required and compared in constant
 * time. When it is empty a `sig` field is simply ignored — a cluster that has
 * not been given a secret has no basis on which to judge one.
 */
export function decodeMessage(raw: string, secret: string): ClusterDecodeResult {
  if (raw.length > MAX_DATAGRAM_BYTES) {
    return { message: null, rejected: 'datagram exceeds the size limit' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { message: null, rejected: 'datagram is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { message: null, rejected: 'datagram is not a JSON object' };
  }
  const candidate = parsed as Record<string, unknown>;
  const validated = validateFields(candidate);
  if (!validated.message) return validated;
  const message = validated.message;

  if (!secret) return { message, rejected: null };

  const sig = candidate['sig'];
  if (typeof sig !== 'string' || sig.length === 0) {
    return { message: null, rejected: 'datagram is unsigned but cluster.secret is set' };
  }
  if (!signaturesMatch(sig, signMessage(message, secret))) {
    return { message: null, rejected: 'datagram signature did not verify' };
  }
  return { message, rejected: null };
}

function validateFields(candidate: Record<string, unknown>): ClusterDecodeResult {
  const v = candidate['v'];
  const type = candidate['type'];
  const surfaceId = candidate['surfaceId'];
  const nodeId = candidate['nodeId'];
  const nodeVersion = candidate['nodeVersion'];
  const seq = candidate['seq'];
  const ts = candidate['ts'];
  if (typeof v !== 'number' || Math.trunc(v) !== CLUSTER_PROTOCOL_VERSION) {
    return { message: null, rejected: 'unsupported protocol version' };
  }
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) {
    return { message: null, rejected: 'unknown message type' };
  }
  // Null is legal (a group-level datagram); a non-null value must be a digest,
  // which is also what stops a plaintext topic name being accepted as one.
  if (surfaceId !== null && !isSurfaceId(surfaceId)) {
    return { message: null, rejected: 'surfaceId is neither null nor a surface digest' };
  }
  if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) {
    return { message: null, rejected: 'missing or implausible nodeId' };
  }
  if (typeof nodeVersion !== 'string' || nodeVersion.length === 0 || nodeVersion.length > 64) {
    return { message: null, rejected: 'missing or implausible nodeVersion' };
  }
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) {
    return { message: null, rejected: 'missing or implausible seq' };
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
    return { message: null, rejected: 'missing or implausible ts' };
  }
  return {
    message: {
      v: CLUSTER_PROTOCOL_VERSION,
      type: type as ClusterMessage['type'],
      surfaceId: surfaceId as string | null,
      nodeId,
      nodeVersion,
      seq: Math.trunc(seq),
      ts: Math.trunc(ts),
    },
    rejected: null,
  };
}

function signaturesMatch(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (receivedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(receivedBytes, expectedBytes);
}
