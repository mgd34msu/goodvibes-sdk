/**
 * relay-e2e-channel.test.ts
 *
 * Exercises the zero-knowledge relay's end-to-end cryptographic core: the
 * NK-style handshake (crypto.ts + handshake.ts), the AEAD record layer
 * (secure-channel.ts), the daemon identity (de)serialization (identity.ts), and
 * the pairing payload codec (pairing.ts).
 *
 * These are behavioral tests: two independent parties (a "client" and a
 * "daemon") each run only their own half of the handshake and must arrive at a
 * working, mutually-decryptable channel — and a third party that lacks the
 * daemon's static private key must NOT be able to impersonate it. That last
 * property is what makes the relay operator unable to read or forge traffic.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRelayPairingPayload,
  decodeRelayPairingString,
  deserializeRelayIdentity,
  encodeRelayPairingString,
  encodeUtf8,
  decodeUtf8,
  exportRawPublicKey,
  finishInitiatorHandshake,
  fromBase64Url,
  generateRelayIdentity,
  relayIdentityPublicKeyBase64Url,
  respondToHandshake,
  RelaySecureChannel,
  serializeRelayIdentity,
  startInitiatorHandshake,
  toBase64Url,
} from '../packages/transport-core/src/relay/index.js';

const RID = 'rid_test_rendezvous_0001';

async function completeHandshake(daemonStaticPubRaw: Uint8Array, daemonPair: { publicKey: CryptoKey; privateKey: CryptoKey }) {
  const ridBytes = encodeUtf8(RID);
  const { state, message1 } = await startInitiatorHandshake(daemonStaticPubRaw, ridBytes);
  const { keys: daemonKeys, message2 } = await respondToHandshake(daemonPair, ridBytes, message1);
  const clientKeys = await finishInitiatorHandshake(state, message2);
  return { clientKeys, daemonKeys };
}

describe('relay E2E handshake + secure channel', () => {
  test('client and daemon derive a working bidirectional channel', async () => {
    const daemon = await generateRelayIdentity();
    const daemonPubRaw = await exportRawPublicKey(daemon.publicKey);
    const { clientKeys, daemonKeys } = await completeHandshake(daemonPubRaw, daemon);

    const client = new RelaySecureChannel(clientKeys, 'client');
    const server = new RelaySecureChannel(daemonKeys, 'daemon');

    // client -> daemon
    const req = encodeUtf8('GET /api/operator/sessions');
    const sealed = await client.seal(req);
    expect(decodeUtf8(await server.open(sealed))).toBe('GET /api/operator/sessions');

    // daemon -> client
    const res = encodeUtf8('{"sessions":[]}');
    const sealedRes = await server.seal(res);
    expect(decodeUtf8(await client.open(sealedRes))).toBe('{"sessions":[]}');
  });

  test('channel enforces strictly increasing counters (replay rejected)', async () => {
    const daemon = await generateRelayIdentity();
    const daemonPubRaw = await exportRawPublicKey(daemon.publicKey);
    const { clientKeys, daemonKeys } = await completeHandshake(daemonPubRaw, daemon);
    const client = new RelaySecureChannel(clientKeys, 'client');
    const server = new RelaySecureChannel(daemonKeys, 'daemon');

    const frame = await client.seal(encodeUtf8('once'));
    expect(decodeUtf8(await server.open(frame))).toBe('once');
    // Replaying the exact same frame must be rejected.
    await expect(server.open(frame)).rejects.toThrow();
  });

  test('tampered ciphertext fails AEAD authentication', async () => {
    const daemon = await generateRelayIdentity();
    const daemonPubRaw = await exportRawPublicKey(daemon.publicKey);
    const { clientKeys, daemonKeys } = await completeHandshake(daemonPubRaw, daemon);
    const client = new RelaySecureChannel(clientKeys, 'client');
    const server = new RelaySecureChannel(daemonKeys, 'daemon');

    const frame = await client.seal(encodeUtf8('sensitive'));
    frame[frame.length - 1] ^= 0xff; // flip a ciphertext/tag byte
    await expect(server.open(frame)).rejects.toThrow();
  });

  test('a party without the daemon static private key cannot impersonate the daemon', async () => {
    // The real daemon publishes its static public key in the pairing payload.
    const realDaemon = await generateRelayIdentity();
    const realPubRaw = await exportRawPublicKey(realDaemon.publicKey);
    // A malicious relay generates its OWN identity and tries to answer the
    // handshake in the daemon's place — but the client pinned realPubRaw.
    const attacker = await generateRelayIdentity();

    const ridBytes = encodeUtf8(RID);
    const { state, message1 } = await startInitiatorHandshake(realPubRaw, ridBytes);
    const { message2 } = await respondToHandshake(attacker, ridBytes, message1);

    // The client computes dh_se against the PINNED real key, which will not
    // match the attacker's derivation, so the confirmation must fail.
    await expect(finishInitiatorHandshake(state, message2)).rejects.toThrow();
  });
});

describe('relay identity serialization', () => {
  test('round-trips through serialize/deserialize and still agrees on keys', async () => {
    const original = await generateRelayIdentity();
    const pubRaw = await exportRawPublicKey(original.publicKey);
    const serialized = await serializeRelayIdentity(original);
    expect(serialized.v).toBe(1);
    expect(serialized.publicKeyRaw).toBe(await relayIdentityPublicKeyBase64Url(original));

    const restored = await deserializeRelayIdentity(serialized);
    // The restored identity must still complete a handshake for a client that
    // pinned the original public key.
    const { clientKeys, daemonKeys } = await completeHandshake(pubRaw, restored);
    const client = new RelaySecureChannel(clientKeys, 'client');
    const server = new RelaySecureChannel(daemonKeys, 'daemon');
    const sealed = await client.seal(encodeUtf8('ping'));
    expect(decodeUtf8(await server.open(sealed))).toBe('ping');
  });
});

describe('relay pairing payload codec', () => {
  test('encodes and decodes a pairing string losslessly', () => {
    const payload = createRelayPairingPayload({
      relayUrl: 'wss://relay.example.com',
      rid: RID,
      daemonPublicKey: 'AABBCC_public_key_base64url',
      label: 'Studio daemon',
    });
    const str = encodeRelayPairingString(payload);
    expect(str.startsWith('gvrelay1.')).toBe(true);
    const decoded = decodeRelayPairingString(str);
    expect(decoded).toEqual(payload);
  });

  test('rejects a non-relay string', () => {
    expect(() => decodeRelayPairingString('https://example.com/not-a-pairing')).toThrow();
  });
});

describe('relay base64url codec', () => {
  test('round-trips arbitrary byte lengths', () => {
    for (let len = 0; len < 40; len += 1) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });
});
