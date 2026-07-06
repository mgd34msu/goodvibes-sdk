/**
 * push/encryption.ts
 *
 * Browser-push payload encryption, implemented with Node's built-in crypto
 * (node:crypto) — no third-party web-push dependency. This is the daemon-side
 * (Node/Bun) delivery path only; nothing here is imported by the runtime-neutral
 * or browser bundles (see scripts/browser-compat-check.ts).
 *
 * Two standards are combined here, exactly as a browser Push service expects:
 *
 *  - RFC 8291 (Message Encryption for Web Push): derive a shared secret from an
 *    ephemeral P-256 keypair and the subscription's public key + auth secret.
 *  - RFC 8188 (aes128gcm content encoding): expand that secret into a
 *    content-encryption key + nonce and encrypt one record, then frame it with
 *    the salt / record-size / sender-public-key header the receiver reads back.
 *
 * The output Buffer is the raw request body sent to the subscription endpoint
 * with `Content-Encoding: aes128gcm`.
 */

import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/** The subscription's own key material, base64url-encoded (browser PushSubscription shape). */
export interface SubscriptionKeyMaterial {
  /** The receiver's public key — 65-byte uncompressed P-256 point, base64url. */
  readonly p256dh: string;
  /** The receiver's 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface EncryptedPushPayload {
  /** The aes128gcm request body: header || ciphertext || GCM tag. */
  readonly body: Buffer;
  /** Always `aes128gcm` — the value for the Content-Encoding request header. */
  readonly contentEncoding: 'aes128gcm';
}

/**
 * Single fixed record size. Push payloads here (an approval summary, a
 * completion note) are far below this, so one aes128gcm record always
 * suffices; a payload that would not fit is rejected honestly rather than
 * silently truncated or split.
 */
const RECORD_SIZE = 4096;

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

/** HKDF (RFC 5869) specialized to a single output block (length <= 32). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return okm.subarray(0, length);
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * Encrypt `plaintext` for a subscription's key material.
 *
 * A fresh ephemeral sender keypair and salt are generated per call (RFC 8291
 * requires this — the same salt/key pair must never encrypt two messages), so
 * the result is non-deterministic by design.
 */
export function encryptPushPayload(
  keys: SubscriptionKeyMaterial,
  plaintext: Buffer,
): EncryptedPushPayload {
  const receiverPublic = base64UrlToBuffer(keys.p256dh);
  const authSecret = base64UrlToBuffer(keys.auth);
  if (receiverPublic.length !== 65) {
    throw new Error('Push subscription p256dh key is not a 65-byte uncompressed P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new Error('Push subscription auth secret is not 16 bytes');
  }

  // Ephemeral sender (application-server) keypair for this one message.
  const sender = createECDH('prime256v1');
  sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(receiverPublic);

  const salt = randomBytes(16);

  // RFC 8291: mix the shared secret with the auth secret and both public keys.
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, receiverPublic, senderPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // RFC 8188: expand into the content-encryption key and nonce.
  const contentEncryptionKey = hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = hkdf(salt, ikm, NONCE_INFO, 12);

  // One record: plaintext followed by the 0x02 last-record delimiter.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  if (record.length + 16 > RECORD_SIZE) {
    throw new Error(`Push payload too large for a single aes128gcm record (max ${RECORD_SIZE - 17} bytes)`);
  }

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | record-size(4, big-endian) | keyid-len(1) | keyid(=senderPublic).
  const header = Buffer.alloc(16 + 4 + 1 + senderPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  senderPublic.copy(header, 21);

  return { body: Buffer.concat([header, ciphertext]), contentEncoding: 'aes128gcm' };
}
