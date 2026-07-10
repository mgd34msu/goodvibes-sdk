// relay/handshake.ts
//
// The end-to-end (E2E) authenticated key exchange that runs INSIDE a relay pipe
// before any application byte flows. It follows the Noise "NK" shape: the
// initiator (client/surface) already knows the responder's (daemon's) static
// public key — it was pinned from the pairing payload — and stays anonymous
// itself. This gives three properties that make the relay zero-knowledge:
//
//   * Daemon authentication: the derived keys mix a static-ephemeral DH
//     (dh_se) against the daemon's static key. Only the real daemon holds that
//     private key, so a malicious or curious relay that tried to sit in the
//     middle cannot derive the session keys — its forged confirmation fails and
//     the client tears the pipe down.
//   * Forward secrecy: an ephemeral-ephemeral DH (dh_ee) means recording the
//     ciphertext and later stealing the daemon's static key still does not
//     reveal past sessions.
//   * Confidentiality from the relay: every derived key comes from DH secrets
//     the relay never sees. It only forwards the two public ephemerals and
//     ciphertext.
//
// Primitives (all from crypto.ts / Web Crypto): ECDH P-256 for DH, HKDF-SHA-256
// for key derivation, AES-256-GCM for the confirmation tag and the channel.

import {
  aeadOpen,
  aeadSeal,
  concatBytes,
  deriveSharedSecret,
  encodeUtf8,
  exportRawPublicKey,
  generateEcdhKeyPair,
  hkdf,
  importAeadKey,
  importRawPublicKey,
  RELAY_NONCE_BYTES,
  RELAY_PUBLIC_KEY_BYTES,
  sha256,
  type RelayKeyPair,
} from './crypto.js';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

const HANDSHAKE_LABEL = encodeUtf8('gv-relay-e2e/v1');
const CONFIRM_PLAINTEXT = encodeUtf8('gv-relay-confirm');
const ZERO_NONCE = new Uint8Array(RELAY_NONCE_BYTES);
const CONFIRM_TAG_BYTES = CONFIRM_PLAINTEXT.length + 16; // GCM tag is 16 bytes

/** Derived per-direction session keys plus the transcript binding. */
export interface RelayHandshakeKeys {
  /** AES-256-GCM key for client → daemon frames. */
  readonly clientToDaemonKey: CryptoKey;
  /** AES-256-GCM key for daemon → client frames. */
  readonly daemonToClientKey: CryptoKey;
  /** SHA-256 of the full handshake transcript (used as channel AAD prefix). */
  readonly transcriptHash: Uint8Array<ArrayBuffer>;
}

/** Initiator (client) state carried between the two handshake messages. */
export interface RelayInitiatorState {
  readonly ephemeral: RelayKeyPair;
  readonly ephemeralPublicRaw: Uint8Array<ArrayBuffer>;
  readonly daemonStaticPublicRaw: Uint8Array<ArrayBuffer>;
  readonly ridBytes: Uint8Array<ArrayBuffer>;
}

async function buildTranscript(
  ridBytes: Uint8Array<ArrayBuffer>,
  initiatorPub: Uint8Array<ArrayBuffer>,
  responderPub: Uint8Array<ArrayBuffer>,
  staticPub: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(concatBytes(HANDSHAKE_LABEL, ridBytes, initiatorPub, responderPub, staticPub));
}

async function deriveKeys(
  dhEe: Uint8Array<ArrayBuffer>,
  dhSe: Uint8Array<ArrayBuffer>,
  transcriptHash: Uint8Array<ArrayBuffer>,
): Promise<{ keys: RelayHandshakeKeys; confirmKey: CryptoKey }> {
  const ikm = concatBytes(dhEe, dhSe);
  const material = await hkdf(ikm, transcriptHash, HANDSHAKE_LABEL, 96);
  const clientToDaemonKey = await importAeadKey(material.subarray(0, 32));
  const daemonToClientKey = await importAeadKey(material.subarray(32, 64));
  const confirmKey = await importAeadKey(material.subarray(64, 96));
  return { keys: { clientToDaemonKey, daemonToClientKey, transcriptHash }, confirmKey };
}

// ─── Initiator (client / surface) ─────────────────────────────────────────────

/**
 * Begin the handshake. `daemonStaticPublicRaw` is the 65-byte pinned daemon key
 * from the pairing payload; `ridBytes` are the UTF-8 bytes of the rendezvous id.
 * Returns the state to keep and `message1` to send through the pipe.
 */
export async function startInitiatorHandshake(
  daemonStaticPublicRaw: Uint8Array<ArrayBuffer>,
  ridBytes: Uint8Array<ArrayBuffer>,
): Promise<{ state: RelayInitiatorState; message1: Uint8Array<ArrayBuffer> }> {
  const ephemeral = await generateEcdhKeyPair();
  const ephemeralPublicRaw = await exportRawPublicKey(ephemeral.publicKey);
  return {
    state: { ephemeral, ephemeralPublicRaw, daemonStaticPublicRaw, ridBytes },
    message1: ephemeralPublicRaw,
  };
}

/**
 * Complete the handshake on the initiator side. `message2` is the daemon's
 * reply: its 65-byte ephemeral public key followed by an AEAD confirmation tag.
 * Throws if the confirmation fails to verify (daemon impersonation / MITM).
 */
export async function finishInitiatorHandshake(
  state: RelayInitiatorState,
  message2: Uint8Array<ArrayBuffer>,
): Promise<RelayHandshakeKeys> {
  if (message2.length !== RELAY_PUBLIC_KEY_BYTES + CONFIRM_TAG_BYTES) {
    throw new GoodVibesSdkError('Malformed relay handshake response.', { category: 'protocol', source: 'transport', recoverable: false });
  }
  const responderPub = message2.subarray(0, RELAY_PUBLIC_KEY_BYTES);
  const confirmTag = message2.subarray(RELAY_PUBLIC_KEY_BYTES);
  const responderKey = await importRawPublicKey(responderPub);
  const staticKey = await importRawPublicKey(state.daemonStaticPublicRaw);
  const dhEe = await deriveSharedSecret(state.ephemeral.privateKey, responderKey);
  const dhSe = await deriveSharedSecret(state.ephemeral.privateKey, staticKey);
  const transcriptHash = await buildTranscript(state.ridBytes, state.ephemeralPublicRaw, responderPub, state.daemonStaticPublicRaw);
  const { keys, confirmKey } = await deriveKeys(dhEe, dhSe, transcriptHash);
  // Verifying the daemon's confirmation authenticates it: only the holder of
  // the pinned static private key could have derived confirmKey.
  const opened = await aeadOpen(confirmKey, ZERO_NONCE, confirmTag, transcriptHash);
  if (opened.length !== CONFIRM_PLAINTEXT.length) {
    throw new GoodVibesSdkError('Relay handshake confirmation mismatch.', { category: 'protocol', source: 'transport', recoverable: false });
  }
  return keys;
}

// ─── Responder (daemon) ───────────────────────────────────────────────────────

/**
 * Complete the handshake on the responder (daemon) side. `staticKeyPair` is the
 * daemon's persistent identity key; `message1` is the initiator's ephemeral
 * public key. Returns the derived channel keys and `message2` to send back
 * (daemon ephemeral public key + AEAD confirmation tag).
 */
export async function respondToHandshake(
  staticKeyPair: RelayKeyPair,
  ridBytes: Uint8Array<ArrayBuffer>,
  message1: Uint8Array<ArrayBuffer>,
): Promise<{ keys: RelayHandshakeKeys; message2: Uint8Array<ArrayBuffer> }> {
  if (message1.length !== RELAY_PUBLIC_KEY_BYTES) {
    throw new GoodVibesSdkError('Malformed relay handshake initiation.', { category: 'protocol', source: 'transport', recoverable: false });
  }
  const initiatorKey = await importRawPublicKey(message1);
  const ephemeral = await generateEcdhKeyPair();
  const ephemeralPublicRaw = await exportRawPublicKey(ephemeral.publicKey);
  const staticPublicRaw = await exportRawPublicKey(staticKeyPair.publicKey);
  const dhEe = await deriveSharedSecret(ephemeral.privateKey, initiatorKey);
  const dhSe = await deriveSharedSecret(staticKeyPair.privateKey, initiatorKey);
  const transcriptHash = await buildTranscript(ridBytes, message1, ephemeralPublicRaw, staticPublicRaw);
  const { keys, confirmKey } = await deriveKeys(dhEe, dhSe, transcriptHash);
  const confirmTag = await aeadSeal(confirmKey, ZERO_NONCE, CONFIRM_PLAINTEXT, transcriptHash);
  return { keys, message2: concatBytes(ephemeralPublicRaw, confirmTag) };
}
