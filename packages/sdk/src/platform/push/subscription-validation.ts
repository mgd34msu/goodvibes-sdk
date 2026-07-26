/**
 * push/subscription-validation.ts
 *
 * The ONE place a push subscription's endpoint and key material are judged
 * well-formed. Two callers share it and must never disagree:
 *
 *  - Registration (`routes/push.ts`, `routes/pairing-handoff.ts`,
 *    `PushSubscriptionStore.reconcile`) — junk is refused with a plain reason at
 *    the moment it is offered, so a record that could never receive a push is
 *    never written to disk in the first place.
 *  - Delivery (`push/encryption.ts`) — the same predicates, with the same
 *    wording, guard the encryption path.
 *
 * Sharing the predicates is the point: before this module, registration checked
 * only that the strings were non-empty while delivery checked the byte lengths,
 * so `p256dh: "not-base64!!!!"` was accepted at 200 and only failed weeks later
 * as a delivery error. The two now fail on exactly the same inputs with exactly
 * the same message.
 */

/** RFC 8291: the receiver's public key is an uncompressed P-256 point. */
export const P256DH_POINT_BYTES = 65;
/** RFC 8291: the receiver's authentication secret is 16 bytes. */
export const AUTH_SECRET_BYTES = 16;
/**
 * Upper bound on a stored endpoint. Real push endpoints (FCM, Mozilla, WNS) are
 * a few hundred characters; anything past this is not an endpoint the daemon
 * should be persisting, and an unbounded one is a way to grow the store on disk
 * without registering anything usable.
 */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/** The uncompressed-point marker the 65-byte p256dh must start with. */
const UNCOMPRESSED_POINT_MARKER = 0x04;

/**
 * The delivery path's wording, kept verbatim so registration and delivery
 * report the same failure in the same words.
 */
export const P256DH_INVALID_MESSAGE =
  'Push subscription p256dh key is not a 65-byte uncompressed P-256 point';
export const AUTH_SECRET_INVALID_MESSAGE = 'Push subscription auth secret is not 16 bytes';

/**
 * Characters a base64 / base64url encoding may contain. Both alphabets are
 * accepted (browsers differ) — what is rejected is a string that is not an
 * encoding at all, which would otherwise decode to a silently truncated buffer.
 */
const BASE64_ANY_ALPHABET = /^[A-Za-z0-9_\-+/]+={0,2}$/;

function decodedByteLength(value: string): number | null {
  if (!BASE64_ANY_ALPHABET.test(value)) return null;
  return Buffer.from(value, 'base64url').length;
}

/** The field a validation problem belongs to, as the caller names it on the wire. */
export type PushSubscriptionField = 'endpoint' | 'keys.p256dh' | 'keys.auth';

/** A refused subscription: which field, and why, in plain language. */
export interface PushSubscriptionProblem {
  readonly field: PushSubscriptionField;
  readonly reason: string;
}

/** Thrown when a subscription is offered for storage with unusable content. */
export class PushSubscriptionValidationError extends Error {
  readonly field: PushSubscriptionField;

  constructor(problem: PushSubscriptionProblem) {
    super(problem.reason);
    this.name = 'PushSubscriptionValidationError';
    this.field = problem.field;
  }
}

/** Why this p256dh cannot be used, or null when it is a valid point. */
export function describeP256dhProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return P256DH_INVALID_MESSAGE;
  const length = decodedByteLength(value);
  if (length !== P256DH_POINT_BYTES) return P256DH_INVALID_MESSAGE;
  if (Buffer.from(value, 'base64url')[0] !== UNCOMPRESSED_POINT_MARKER) return P256DH_INVALID_MESSAGE;
  return null;
}

/** Why this auth secret cannot be used, or null when it is 16 bytes. */
export function describeAuthSecretProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return AUTH_SECRET_INVALID_MESSAGE;
  return decodedByteLength(value) === AUTH_SECRET_BYTES ? null : AUTH_SECRET_INVALID_MESSAGE;
}

/** Why this endpoint cannot be used, or null when it is a bounded http(s) URL. */
export function describeEndpointProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Push endpoint is missing';
  if (value.length > MAX_PUSH_ENDPOINT_LENGTH) {
    return `Push endpoint is longer than ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
  }
  if (/\s/.test(value)) return 'Push endpoint contains whitespace';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Push endpoint is not a valid URL';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Push endpoint must be an http(s) URL';
  }
  if (parsed.hostname.length === 0) return 'Push endpoint has no host';
  return null;
}

/** The structural slice validated — the wire shape of a subscription offer. */
export interface PushSubscriptionCandidate {
  readonly endpoint: unknown;
  readonly keys?: { readonly p256dh?: unknown; readonly auth?: unknown } | undefined;
}

/**
 * The first problem with a candidate subscription, or null when every field is
 * usable. Endpoint first, then the key material, so the caller reports the most
 * structural failure rather than a downstream one.
 */
export function describeSubscriptionProblem(
  candidate: PushSubscriptionCandidate,
): PushSubscriptionProblem | null {
  const endpoint = describeEndpointProblem(candidate.endpoint);
  if (endpoint) return { field: 'endpoint', reason: endpoint };
  const p256dh = describeP256dhProblem(candidate.keys?.p256dh);
  if (p256dh) return { field: 'keys.p256dh', reason: p256dh };
  const auth = describeAuthSecretProblem(candidate.keys?.auth);
  if (auth) return { field: 'keys.auth', reason: auth };
  return null;
}

/** Throwing form of {@link describeSubscriptionProblem}. */
export function assertUsableSubscription(candidate: PushSubscriptionCandidate): void {
  const problem = describeSubscriptionProblem(candidate);
  if (problem) throw new PushSubscriptionValidationError(problem);
}
