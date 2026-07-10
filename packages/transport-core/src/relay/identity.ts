// relay/identity.ts
//
// The daemon's persistent relay identity key pair. The codebase had no existing
// asymmetric daemon identity (identities were random UUIDs and shared-secret
// tokens), so this mints one, modelled on the existing VapidManager pattern:
// generate once, persist the whole key pair through the daemon's SecretsManager
// (custody is the caller's responsibility — this module only (de)serializes),
// and expose the public half for pinning in pairing payloads.
//
// The private key never leaves the daemon process. Its public key is what a
// surface pins to authenticate the daemon during the E2E handshake, so the
// security of the whole relay path rests on the pairing payload being delivered
// out-of-band (QR / trusted LAN), exactly like an SSH host key fingerprint.

import {
  exportRawPublicKey,
  generateEcdhKeyPair,
  toBase64Url,
  type RelayKeyPair,
} from './crypto.js';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

/** Serializable form of a relay identity, safe to hand to a secret store. */
export interface SerializedRelayIdentity {
  /** Format version. */
  readonly v: 1;
  /** Full private key in JWK form (contains the `d` scalar — treat as a secret). */
  readonly privateKeyJwk: JsonWebKey;
  /** Raw uncompressed public key, base64url — safe to publish in pairing payloads. */
  readonly publicKeyRaw: string;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || typeof c.subtle === 'undefined') {
    throw new GoodVibesSdkError('Web Crypto (crypto.subtle) is unavailable in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
    });
  }
  return c.subtle;
}

/** Generate a fresh daemon relay identity key pair. */
export async function generateRelayIdentity(): Promise<RelayKeyPair> {
  return generateEcdhKeyPair();
}

/** Serialize an identity for durable storage (JWK private + raw public). */
export async function serializeRelayIdentity(pair: RelayKeyPair): Promise<SerializedRelayIdentity> {
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  const publicKeyRaw = toBase64Url(await exportRawPublicKey(pair.publicKey));
  return { v: 1, privateKeyJwk: jwk, publicKeyRaw };
}

/** Reconstruct an identity key pair from its serialized form. */
export async function deserializeRelayIdentity(serialized: SerializedRelayIdentity): Promise<RelayKeyPair> {
  if (serialized.v !== 1) {
    throw new GoodVibesSdkError('Unsupported relay identity format version.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  const jwk = serialized.privateKeyJwk;
  const privateKey = await subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  // Derive a public-only JWK by dropping the private scalar `d`.
  const publicJwk: JsonWebKey = { ...jwk };
  delete (publicJwk as Record<string, unknown>)['d'];
  publicJwk.key_ops = [];
  const publicKey = await subtle().importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { publicKey, privateKey };
}

/** The base64url raw public key for a pairing payload. */
export async function relayIdentityPublicKeyBase64Url(pair: RelayKeyPair): Promise<string> {
  return toBase64Url(await exportRawPublicKey(pair.publicKey));
}
