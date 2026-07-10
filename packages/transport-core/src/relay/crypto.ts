// relay/crypto.ts
//
// Runtime-neutral cryptographic primitives for the zero-knowledge relay
// end-to-end (E2E) channel. Every primitive here is a thin, honest wrapper over
// the Web Crypto API (`globalThis.crypto.subtle`) — the same interface exposed
// by browsers, Bun, and Node 22+. Nothing is hand-rolled: key agreement is
// ECDH over the NIST P-256 curve, key derivation is HKDF-SHA-256, and the AEAD
// is AES-256-GCM. P-256 is chosen over X25519 because it is universally
// available in Web Crypto across every surface that must terminate this channel
// (browser PWA, Bun daemon, Node), and it matches the curve the codebase
// already relies on for push-message encryption.
//
// This module intentionally holds ZERO relay-protocol knowledge — it only knows
// bytes and keys. Higher layers (handshake.ts, secure-channel.ts) compose these.

import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

/** Named curve used for all relay key agreement. */
export const RELAY_CURVE = 'P-256' as const;
/** Raw (uncompressed) P-256 public key length in bytes. */
export const RELAY_PUBLIC_KEY_BYTES = 65;
/** AEAD nonce length in bytes (AES-GCM standard 96-bit nonce). */
export const RELAY_NONCE_BYTES = 12;
/** Symmetric key length in bytes (AES-256). */
export const RELAY_KEY_BYTES = 32;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || typeof c.subtle === 'undefined') {
    throw new GoodVibesSdkError('Web Crypto (crypto.subtle) is unavailable in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Run the relay in a runtime that provides the Web Crypto API (browser, Bun, or Node 22+).',
    });
  }
  return c.subtle;
}

/** Fill `n` bytes from the platform CSPRNG. */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new GoodVibesSdkError('Secure random generation is unavailable in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Run the relay in a runtime that provides crypto.getRandomValues().',
    });
  }
  c.getRandomValues(out);
  return out;
}

// ─── base64url (no padding), binary-safe, no Buffer/atob dependency ───────────

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: ReadonlyArray<number> = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) table[B64URL_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Encode bytes to unpadded base64url. */
export function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]! + B64URL_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Decode unpadded (or padded) base64url to bytes. Throws on invalid input. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/=+$/, '');
  const len = clean.length;
  const fullGroups = Math.floor(len / 4);
  const remainder = len - fullGroups * 4;
  if (remainder === 1) {
    throw new GoodVibesSdkError('Invalid base64url string length.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  const outLen = fullGroups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  const at = (index: number): number => {
    const code = clean.charCodeAt(index);
    const v = code < 128 ? B64URL_LOOKUP[code]! : -1;
    if (v < 0) throw new GoodVibesSdkError('Invalid base64url character.', { category: 'bad_request', source: 'transport', recoverable: false });
    return v;
  };
  for (let g = 0; g < fullGroups; g += 1, i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (remainder === 2) {
    const n = (at(i) << 18) | (at(i + 1) << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (remainder === 3) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out;
}

/** Constant-time equality for two byte arrays (length is not secret). */
export function bytesEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Concatenate byte arrays into one. */
export function concatBytes(...parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ─── asymmetric key agreement (ECDH P-256) ───────────────────────────────────

/** A relay identity/ephemeral key pair. Private key is non-extractable. */
export interface RelayKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** Generate a fresh ECDH P-256 key pair for key agreement. */
export async function generateEcdhKeyPair(): Promise<RelayKeyPair> {
  const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: RELAY_CURVE }, true, ['deriveBits'])) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Export a public key to its 65-byte raw uncompressed form. */
export async function exportRawPublicKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await subtle().exportKey('raw', key);
  return new Uint8Array(raw);
}

/** Import a 65-byte raw uncompressed P-256 public key. */
export async function importRawPublicKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (bytes.length !== RELAY_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    throw new GoodVibesSdkError('Malformed P-256 public key (expected 65-byte uncompressed point).', {
      category: 'bad_request',
      source: 'transport',
      recoverable: false,
    });
  }
  return subtle().importKey('raw', bytes, { name: 'ECDH', namedCurve: RELAY_CURVE }, true, []);
}

/** Compute the raw ECDH shared secret (32-byte x-coordinate) between our private key and their public key. */
export async function deriveSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  return new Uint8Array(bits);
}

// ─── hashing + KDF ────────────────────────────────────────────────────────────

/** SHA-256 digest. */
export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await subtle().digest('SHA-256', data);
  return new Uint8Array(digest);
}

/**
 * HKDF-SHA-256 (extract + expand) producing `length` bytes of output key
 * material. `salt` and `info` bind the derivation to the handshake transcript.
 */
export async function hkdf(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ─── AEAD (AES-256-GCM) ────────────────────────────────────────────────────────

/** Import a 32-byte raw key as an AES-256-GCM key. */
export async function importAeadKey(rawKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (rawKey.length !== RELAY_KEY_BYTES) {
    throw new GoodVibesSdkError('AEAD key must be 32 bytes.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  return subtle().importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM seal. Returns ciphertext with the GCM tag appended. */
export async function aeadSeal(key: CryptoKey, nonce: Uint8Array<ArrayBuffer>, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

/** AES-256-GCM open. Throws (auth failure) if the ciphertext/tag/AAD do not verify. */
export async function aeadOpen(key: CryptoKey, nonce: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
    return new Uint8Array(pt);
  } catch {
    throw new GoodVibesSdkError('Relay AEAD authentication failed (tampered or out-of-order frame).', {
      category: 'bad_request',
      source: 'transport',
      recoverable: false,
      hint: 'The end-to-end channel integrity check failed. The connection must be torn down.',
    });
  }
}

const TEXT_ENCODER = /* @__PURE__ */ new TextEncoder();
const TEXT_DECODER = /* @__PURE__ */ new TextDecoder();

/** UTF-8 encode a string to bytes. */
export function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return TEXT_ENCODER.encode(text);
}

/** UTF-8 decode bytes to a string. */
export function decodeUtf8(bytes: Uint8Array<ArrayBuffer>): string {
  return TEXT_DECODER.decode(bytes);
}
