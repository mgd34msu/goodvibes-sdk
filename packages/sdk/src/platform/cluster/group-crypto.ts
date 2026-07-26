/**
 * group-crypto.ts — the primitives the group-key layer is built from.
 *
 * Everything here is a pure function over strings and buffers. No file I/O, no
 * sockets, no config: that keeps the parts a reviewer has to be sure about in
 * one small place, and lets every one of them be tested directly.
 *
 * The layout of the trust:
 *
 *   joinKey      the only thing a human ever handles. Typed on a second
 *                machine to get it into the group. Stable — it changes only
 *                when the operator deliberately changes it.
 *   joinVerifier scrypt(joinKey, joinSalt). Replicated to every member so any
 *                member can admit a newcomer. Deliberately expensive to derive
 *                so that a JOIN KEY THE OPERATOR CHOSE AS A PASSPHRASE cannot
 *                be brute-forced cheaply from a captured verifier.
 *   groupRoot    32 random bytes minted once at create. Never rotates, never
 *                leaves the creating node, never on the wire. Its ONLY job is
 *                to name the group (see deriveGroupId) — which is why losing
 *                it costs nothing: the id it produced is already stored.
 *   groupKey     32 random bytes per GENERATION. Signs every datagram. Rotates
 *                on a schedule and immediately on any removal.
 *   identity     a per-node ed25519 key pair. The public half lives in the
 *                roster; the private half never leaves the node. This is what
 *                lets a machine that has been off for months prove it is
 *                itself after every group key it ever held has expired.
 *   agreement    a per-node x25519 key pair. The public half lives in the
 *                roster; a new group key is wrapped to each member with it, so
 *                a REMOVED member — absent from the roster — is simply not
 *                sent the new key and cannot derive it either.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
  sign as signWithKey,
  timingSafeEqual,
  verify as verifyWithKey,
  type KeyObject,
} from 'node:crypto';
import { isSurfaceId } from './surface-id.js';

/** Bytes of key material everywhere in this module. */
const KEY_BYTES = 32;

/**
 * scrypt cost. N=2^15/r=8/p=1 is ~32 MiB and ~100 ms on a modern CPU — high
 * enough that guessing a human-chosen passphrase from a captured verifier is
 * expensive, low enough that a Raspberry Pi joining a group does not appear to
 * hang. `maxmem` has to be raised explicitly: 128*N*r is exactly Node's 32 MiB
 * default ceiling, so the default would reject these parameters.
 */
export const JOIN_SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

/** Crockford base32 — no I, L, O or U, so nothing reads as a digit by mistake. */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base64url of raw bytes — the encoding every stored key uses. */
export function encodeKeyBytes(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** Inverse of {@link encodeKeyBytes}, rejecting anything that is not the right length. */
export function decodeKeyBytes(value: string, expectedLength = KEY_BYTES): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (decoded.length !== expectedLength) return null;
  return decoded;
}

/** Constant-time equality for two strings that may not be the same length. */
export function secretsMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── join key ────────────────────────────────────────────────────────────────

/**
 * A fresh join key: 20 random bytes (160 bits) rendered in Crockford base32 and
 * grouped for reading aloud. Prefixed `gvj1` so a key pasted into the wrong box
 * is recognisable, and so the format can change later without ambiguity.
 *
 * Groups of four, because a human retyping this over SSH from a phone screen is
 * the actual use case.
 */
export function generateJoinKey(): string {
  const raw = toBase32(randomBytes(20));
  const groups = raw.match(/.{1,4}/g) ?? [raw];
  return `gvj1-${groups.join('-')}`;
}

/**
 * Normalize a join key for comparison.
 *
 * A key the operator retyped with different case, with spaces instead of
 * dashes, or with a trailing newline from a shell heredoc is the same key. A
 * PASSPHRASE, however, is whatever the operator typed — normalizing it would
 * quietly shrink its keyspace — so normalization is applied only to keys in the
 * generated `gvj1-` shape.
 */
export function normalizeJoinKey(value: string): string {
  const trimmed = value.trim();
  if (!/^gvj1[-\s]/i.test(trimmed)) return trimmed;
  return trimmed.toUpperCase().replace(/[\s-]+/g, '-').replace(/^GVJ1/, 'gvj1');
}

/**
 * The scrypt salt for one group, derived from its id.
 *
 * A salt's job is to be DIFFERENT per group, so that work spent guessing one
 * group's passphrase buys nothing against another. It does not need to be
 * secret and it does not need to be random — deriving it from the group id gets
 * uniqueness for free, and means a machine that has been given a join key and a
 * group id has everything it needs to attempt a join without the group first
 * having to advertise a salt on the network.
 *
 * It is deliberately independent of the join key, so changing the join key
 * leaves the salt alone and a joiner's derivation keeps working.
 */
export function deriveJoinSalt(groupId: string): string {
  return encodeKeyBytes(
    createHmac('sha256', 'goodvibes-join-salt-v1').update(groupId).digest().subarray(0, 16),
  );
}

/**
 * Derive the verifier a member checks a join proof against.
 *
 * Async on purpose: scrypt at these parameters takes long enough that doing it
 * synchronously would stall the daemon's event loop, and a daemon that stops
 * answering its control plane for a tenth of a second every time a neighbour
 * tries to join is a daemon that looks broken.
 */
export function deriveJoinVerifier(joinKey: string, joinSalt: string): Promise<string> {
  const salt = decodeKeyBytes(joinSalt, 16);
  if (!salt) return Promise.reject(new Error('the group join salt is not a 16-byte value'));
  return new Promise((resolve, reject) => {
    scrypt(normalizeJoinKey(joinKey), salt, KEY_BYTES, JOIN_SCRYPT_PARAMS, (error, derived) => {
      if (error) reject(error);
      else resolve(encodeKeyBytes(derived));
    });
  });
}

// ── group identity ──────────────────────────────────────────────────────────

/** A fresh group root secret. Minted once per group and never rotated. */
export function generateGroupRoot(): string {
  return encodeKeyBytes(randomBytes(KEY_BYTES));
}

/**
 * The group's public name on the wire.
 *
 * Derived from the ROOT secret and the fixed label 'group' — never from a group
 * key — which is the whole reason it survives rotation: rotating produces a new
 * signing key and touches nothing this depends on. Truncated to 10 bytes (80
 * bits) and rendered base32, which is short enough to read out over the phone
 * and far too long to collide with a neighbour's group by accident.
 *
 * It is a one-way function of a secret nobody transmits, so publishing it in a
 * discovery beacon reveals only that a goodvibes group exists here.
 */
export function deriveGroupId(groupRoot: string): string {
  const root = decodeKeyBytes(groupRoot);
  if (!root) throw new Error('the group root secret is not a 32-byte value');
  const digest = createHmac('sha256', root).update('group').digest().subarray(0, 10);
  return `g${toBase32(digest)}`;
}

/** True when `value` has the shape {@link deriveGroupId} produces. */
export function isValidGroupId(value: unknown): value is string {
  return typeof value === 'string' && /^g[0-9A-HJKMNP-TV-Z]{16}$/.test(value);
}

/** A fresh group key for one generation. */
export function generateGroupKey(): string {
  return encodeKeyBytes(randomBytes(KEY_BYTES));
}

/**
 * Hash a surface identity down to something safe to put on a LAN.
 *
 * An ntfy topic, a bot token's chat id, an account address — all of those name
 * a way to reach the operator, and none of them belong in a datagram any
 * neighbour can capture. A value that is ALREADY a digest of this shape passes
 * through unchanged so a caller that hashed upstream is not double-hashing.
 *
 * TWO digest shapes pass through, and the second one matters more than it
 * looks. The per-surface election layer derives its own surface ids in
 * surface-id.ts — 128 bits of a domain-separated SHA-256, bare hex with no
 * prefix — and those ids are what the election routes on, what the holdings
 * ledger is keyed by, and what the envelope carries. Re-hashing one here would
 * produce a value nothing can route and would break the election's own inner
 * signature, whose canonical form covers `surfaceId`. So a surface id that has
 * already been through surface-id.ts is returned as it stands.
 *
 * The cost of the pass-through is that a raw discriminator which happened to be
 * exactly 32 hex characters would go unhashed. No real topic, bot id or account
 * address has that shape, and the `s`-prefixed guard has always had the same
 * property; the routing correctness bought here is worth it.
 */
export function digestSurfaceId(value: string, groupId: string): string {
  if (/^s[0-9a-f]{32}$/.test(value)) return value;
  if (isSurfaceId(value)) return value;
  return `s${createHmac('sha256', `goodvibes-surface:${groupId}`).update(value).digest('hex').slice(0, 32)}`;
}

// ── per-node key pairs ──────────────────────────────────────────────────────

/** A node's long-lived key pair, stored as base64url raw components. */
export interface NodeKeyPairMaterial {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Both key pairs a node needs to be a member. */
export interface NodeKeyMaterial {
  /** ed25519 — proves "I am this node id" after every group key has expired. */
  readonly identity: NodeKeyPairMaterial;
  /** x25519 — the address a new group key is wrapped to. */
  readonly agreement: NodeKeyPairMaterial;
}

type OkpCurve = 'Ed25519' | 'X25519';

function exportPair(publicKey: KeyObject, privateKey: KeyObject): NodeKeyPairMaterial {
  const pub = publicKey.export({ format: 'jwk' }) as { x?: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!pub.x || !priv.d) throw new Error('generated key pair did not export as an OKP JWK');
  return { publicKey: pub.x, privateKey: priv.d };
}

function importPublic(curve: OkpCurve, x: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: curve, x }, format: 'jwk' });
}

function importPrivate(curve: OkpCurve, material: NodeKeyPairMaterial): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: curve, x: material.publicKey, d: material.privateKey },
    format: 'jwk',
  });
}

/** Mint the identity and agreement key pairs for this node. */
export function generateNodeKeyMaterial(): NodeKeyMaterial {
  const identity = generateKeyPairSync('ed25519');
  const agreement = generateKeyPairSync('x25519');
  return {
    identity: exportPair(identity.publicKey, identity.privateKey),
    agreement: exportPair(agreement.publicKey, agreement.privateKey),
  };
}

/**
 * Mint the GROUP's own signing key pair.
 *
 * Distinct from any node's identity key, and that distinction is the point.
 * When a machine that has been away asks to come back, the reply has to be
 * authenticated against something the returning machine ALREADY HELD when it
 * left. Its stored roster is stale by definition, so a reply signed by whichever
 * member happened to answer may be signed by a machine it has never heard of —
 * which previously left the seal as the only thing standing behind that reply.
 *
 * The group signing key fixes that: every member can sign as the GROUP, and the
 * returning machine verifies against the group public key it has held since the
 * day it joined. It is carried in the roster (public half) and handed out in
 * every admission grant (private half), and it rotates on removal alongside the
 * group key, so an ejected machine's copy stops being able to speak for the
 * group.
 */
export function generateGroupSigningKeyPair(): NodeKeyPairMaterial {
  const pair = generateKeyPairSync('ed25519');
  return exportPair(pair.publicKey, pair.privateKey);
}

/** True when `value` is a plausible raw 32-byte OKP public key. */
export function isValidPublicKey(value: unknown): value is string {
  return typeof value === 'string' && decodeKeyBytes(value) !== null;
}

// ── proofs ──────────────────────────────────────────────────────────────────

/**
 * Authenticate bytes with this node's long-lived identity key.
 *
 * This is the path a machine that has been switched off for months takes back
 * into the group. It depends on nothing that rotates and nothing the operator
 * can change: not the group-key generation it last held, not the join key. See
 * the admission rule in group-membership.ts for why that is safe, and for why
 * it is gated on roster presence rather than on the proof alone.
 */
export function signWithIdentity(identity: NodeKeyPairMaterial, bytes: string): string {
  return signWithKey(null, Buffer.from(bytes, 'utf8'), importPrivate('Ed25519', identity)).toString('base64url');
}

/** Check an identity signature against the public key the roster holds for that node. */
export function verifyWithIdentity(identityPublicKey: string, bytes: string, signature: string): boolean {
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;
  try {
    return verifyWithKey(
      null,
      Buffer.from(bytes, 'utf8'),
      importPublic('Ed25519', identityPublicKey),
      signatureBytes,
    );
  } catch {
    return false;
  }
}

// ── key wrapping ────────────────────────────────────────────────────────────

/** A group key sealed to exactly one member's agreement public key. */
export interface WrappedKeyEnvelope {
  /** Ephemeral x25519 public key of the sender, raw base64url. */
  readonly epk: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

function agreementSecret(privateKey: KeyObject, publicKey: KeyObject, context: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(context, 'utf8'), KEY_BYTES));
}

/**
 * Seal `plaintext` so only the holder of `recipientAgreementKey`'s private half
 * can read it.
 *
 * Ephemeral-static x25519 then AES-256-GCM. `context` is mixed into the key
 * derivation so a payload sealed for one purpose cannot be replayed as another.
 */
export function sealForMember(
  recipientAgreementKey: string,
  plaintext: string,
  context: string,
): WrappedKeyEnvelope {
  const ephemeral = generateKeyPairSync('x25519');
  const secret = agreementSecret(
    ephemeral.privateKey,
    importPublic('X25519', recipientAgreementKey),
    context,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const exported = ephemeral.publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!exported.x) throw new Error('the ephemeral key did not export as an OKP JWK');
  return {
    epk: exported.x,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

/** Open an envelope sealed by {@link sealForMember}. Returns null on any failure. */
export function openSealedEnvelope(
  agreement: NodeKeyPairMaterial,
  envelope: WrappedKeyEnvelope,
  context: string,
): string | null {
  try {
    const secret = agreementSecret(
      importPrivate('X25519', agreement),
      importPublic('X25519', envelope.epk),
      context,
    );
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const opened = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]);
    return opened.toString('utf8');
  } catch {
    return null;
  }
}

/** True when `value` has every field {@link openSealedEnvelope} needs. */
export function isWrappedKeyEnvelope(value: unknown): value is WrappedKeyEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['epk'] === 'string'
    && typeof candidate['iv'] === 'string'
    && typeof candidate['tag'] === 'string'
    && typeof candidate['data'] === 'string'
  );
}
