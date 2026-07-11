// relay/step-up-webauthn.ts
//
// The WebAuthn (passkey) assertion-verification core for relay step-up. This is
// pure crypto over node/Web Crypto (`crypto.subtle`) and a tiny CBOR reader for
// the COSE public key — NO third-party WebAuthn library. It verifies exactly the
// thing a mutating relay call must prove: that a registered authenticator signed
// a fresh, server-issued challenge for this relying party and origin, with the
// presence/verification flags the policy requires, and without its signature
// counter going backwards (a cloned-authenticator signal).
//
// It deliberately does NOT do attestation verification at registration: a
// self-hosted deployment registers the credential's COSE public key directly
// ('none' attestation), so there is no attestation certificate chain to check.
// That choice is documented in docs/relay-zero-knowledge.md (threat model).

import { decodeUtf8, fromBase64Url, toBase64Url } from '@pellux/goodvibes-transport-core/relay';

/** A stored step-up credential: what the daemon persists per registered passkey. */
export interface StoredStepUpCredential {
  /** base64url credential id (the authenticator's credentialId). */
  readonly credentialId: string;
  /** base64url COSE_Key (EC2 P-256) public key, exactly as WebAuthn registration yields. */
  readonly publicKeyCose: string;
  /** The last observed signature counter; regression below this is refused. */
  readonly signCount: number;
  /** Optional operator-facing label. */
  readonly label?: string;
  /** Registration time (ms epoch). */
  readonly createdAt: number;
}

/** The assertion envelope a surface sends in the step-up header (all base64url). */
export interface StepUpAssertionEnvelope {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  /** ASN.1 DER ECDSA signature, exactly as WebAuthn's `assertion.response.signature` yields. */
  readonly signature: string;
}

/** Parameters a single assertion verification binds against. */
export interface StepUpVerifyParams {
  readonly envelope: StepUpAssertionEnvelope;
  readonly credential: StoredStepUpCredential;
  /** base64url of the server-issued challenge bytes the assertion must echo. */
  readonly expectedChallenge: string;
  /** The relying-party id (effective domain) whose SHA-256 must equal authData.rpIdHash. */
  readonly rpId: string;
  /** Allowed clientData origins (exact-match). */
  readonly allowedOrigins: readonly string[];
  /** Require the user-verification flag (default true = required). */
  readonly requireUserVerification: boolean;
}

/** A machine-readable verification refusal reason. Never a generic boolean. */
export type StepUpVerifyFailure =
  | 'malformed-envelope'
  | 'malformed-client-data'
  | 'wrong-type'
  | 'challenge-mismatch'
  | 'origin-not-allowed'
  | 'rpid-mismatch'
  | 'user-presence-missing'
  | 'user-verification-missing'
  | 'bad-public-key'
  | 'bad-signature'
  | 'signature-invalid'
  | 'sign-count-regression';

/** The outcome of verifying one assertion. On success, the fresh counter to persist. */
export type StepUpVerifyResult =
  | { readonly ok: true; readonly signCount: number }
  | { readonly ok: false; readonly reason: StepUpVerifyFailure };

interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array<ArrayBuffer>;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly signCount: number;
}

/** Parse the fixed 37-byte prefix of authenticatorData (rpIdHash, flags, signCount). */
export function parseAuthenticatorData(bytes: Uint8Array<ArrayBuffer>): ParsedAuthenticatorData | null {
  if (bytes.length < 37) return null;
  const flags = bytes[32]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset + 33, 4);
  return {
    rpIdHash: bytes.subarray(0, 32).slice(),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: view.getUint32(0, false),
  };
}

// ── Minimal CBOR reader (only what a COSE_Key EC2 map needs) ──────────────────

interface CborCursor { readonly bytes: Uint8Array<ArrayBuffer>; offset: number; }

function readCborLength(cur: CborCursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) return cur.bytes[cur.offset++]!;
  if (info === 25) { const v = (cur.bytes[cur.offset]! << 8) | cur.bytes[cur.offset + 1]!; cur.offset += 2; return v; }
  if (info === 26) {
    const v = new DataView(cur.bytes.buffer, cur.bytes.byteOffset + cur.offset, 4).getUint32(0, false);
    cur.offset += 4;
    return v;
  }
  throw new Error('unsupported CBOR length');
}

type CborValue = number | Uint8Array<ArrayBuffer> | Map<number, CborValue>;

function readCborValue(cur: CborCursor): CborValue {
  const initial = cur.bytes[cur.offset++]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  switch (major) {
    case 0: // unsigned int
      return readCborLength(cur, info);
    case 1: // negative int
      return -1 - readCborLength(cur, info);
    case 2: { // byte string
      const len = readCborLength(cur, info);
      const out = cur.bytes.subarray(cur.offset, cur.offset + len).slice();
      cur.offset += len;
      return out;
    }
    case 5: { // map
      const pairs = readCborLength(cur, info);
      const map = new Map<number, CborValue>();
      for (let i = 0; i < pairs; i += 1) {
        const key = readCborValue(cur);
        const value = readCborValue(cur);
        if (typeof key === 'number') map.set(key, value);
      }
      return map;
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

/**
 * Parse a COSE_Key (EC2 / P-256) into the raw 65-byte uncompressed EC point
 * (0x04 || x || y) Web Crypto's `importKey('raw', …)` accepts. Returns null if
 * the key is not a well-formed P-256 ES256 EC2 key.
 */
export function coseP256ToRawPoint(cose: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  let map: CborValue;
  try {
    map = readCborValue({ bytes: cose, offset: 0 });
  } catch {
    return null;
  }
  if (!(map instanceof Map)) return null;
  const kty = map.get(1); // 2 = EC2
  const crv = map.get(-1); // 1 = P-256
  const x = map.get(-2);
  const y = map.get(-3);
  if (kty !== 2 || crv !== 1) return null;
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return null;
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return point;
}

/**
 * Convert an ASN.1 DER ECDSA signature (SEQUENCE of two INTEGERs) into the raw
 * 64-byte r||s IEEE-P1363 form Web Crypto's ECDSA verify expects. Returns null
 * on a malformed structure.
 */
export function derToRawEcdsaSignature(der: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let offset = 2;
  // The SEQUENCE length byte at [1] can be short-form; these signatures are tiny.
  if (der[1]! & 0x80) return null;
  const readInt = (): Uint8Array<ArrayBuffer> | null => {
    if (der[offset] !== 0x02) return null;
    const len = der[offset + 1]!;
    offset += 2;
    if (offset + len > der.length) return null;
    let value = der.subarray(offset, offset + len);
    offset += len;
    // Strip a leading 0x00 sign byte, then left-pad to 32.
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    if (value.length > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInt();
  const s = readInt();
  if (!r || !s) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ParsedClientData { readonly type: string; readonly challenge: string; readonly origin: string; }

function parseClientData(bytes: Uint8Array<ArrayBuffer>): ParsedClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record['type'] !== 'string' || typeof record['challenge'] !== 'string' || typeof record['origin'] !== 'string') {
    return null;
  }
  return { type: record['type'], challenge: record['challenge'], origin: record['origin'] };
}

/**
 * Verify a WebAuthn assertion against a stored credential and the expected
 * challenge/rpId/origin. The full ceremony, in order: clientData type +
 * challenge + origin, rpIdHash, user-presence (always) and user-verification
 * (when required) flags, the ECDSA-P256 signature over
 * `authenticatorData || SHA-256(clientDataJSON)`, then the signature-counter
 * regression check. Any failure returns a specific reason; nothing partial ever
 * reads as a pass.
 */
export async function verifyStepUpAssertion(params: StepUpVerifyParams): Promise<StepUpVerifyResult> {
  const { envelope, credential } = params;
  let authData: Uint8Array<ArrayBuffer>;
  let clientDataBytes: Uint8Array<ArrayBuffer>;
  let signatureDer: Uint8Array<ArrayBuffer>;
  try {
    if (envelope.credentialId !== credential.credentialId) return { ok: false, reason: 'malformed-envelope' };
    authData = fromBase64Url(envelope.authenticatorData);
    clientDataBytes = fromBase64Url(envelope.clientDataJSON);
    signatureDer = fromBase64Url(envelope.signature);
  } catch {
    return { ok: false, reason: 'malformed-envelope' };
  }

  const clientData = parseClientData(clientDataBytes);
  if (!clientData) return { ok: false, reason: 'malformed-client-data' };
  if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'wrong-type' };
  if (!timingSafeEqualStrings(clientData.challenge, params.expectedChallenge)) {
    return { ok: false, reason: 'challenge-mismatch' };
  }
  if (!params.allowedOrigins.includes(clientData.origin)) return { ok: false, reason: 'origin-not-allowed' };

  const parsedAuth = parseAuthenticatorData(authData);
  if (!parsedAuth) return { ok: false, reason: 'malformed-envelope' };
  const expectedRpIdHash = await sha256(new TextEncoder().encode(params.rpId) as Uint8Array<ArrayBuffer>);
  if (toBase64Url(parsedAuth.rpIdHash) !== toBase64Url(expectedRpIdHash)) return { ok: false, reason: 'rpid-mismatch' };
  if (!parsedAuth.userPresent) return { ok: false, reason: 'user-presence-missing' };
  if (params.requireUserVerification && !parsedAuth.userVerified) return { ok: false, reason: 'user-verification-missing' };

  const rawPoint = coseP256ToRawPoint(fromBase64Url(credential.publicKeyCose));
  if (!rawPoint) return { ok: false, reason: 'bad-public-key' };
  const rawSignature = derToRawEcdsaSignature(signatureDer);
  if (!rawSignature) return { ok: false, reason: 'bad-signature' };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', rawPoint, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return { ok: false, reason: 'bad-public-key' };
  }
  const clientDataHash = await sha256(clientDataBytes);
  const signatureBase = new Uint8Array(authData.length + clientDataHash.length);
  signatureBase.set(authData, 0);
  signatureBase.set(clientDataHash, authData.length);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    rawSignature,
    signatureBase,
  );
  if (!valid) return { ok: false, reason: 'signature-invalid' };

  // Signature-counter regression: when either side reports a nonzero counter the
  // new value must strictly exceed the stored one (a cloned authenticator or a
  // replay would not). When BOTH are zero the authenticator has no counter and
  // the check is skipped, per the WebAuthn spec.
  if ((parsedAuth.signCount !== 0 || credential.signCount !== 0) && parsedAuth.signCount <= credential.signCount) {
    return { ok: false, reason: 'sign-count-regression' };
  }
  return { ok: true, signCount: parsedAuth.signCount };
}
