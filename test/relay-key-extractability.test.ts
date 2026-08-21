/**
 * relay-key-extractability.test.ts
 *
 * The relay has two kinds of ECDH key and exactly one of them may ever leave
 * the process. Ephemeral handshake keys back the channel's forward secrecy and
 * are only ever used for deriveBits, so their private half is generated
 * non-extractable: `exportKey` on one must throw rather than hand back the raw
 * scalar of a live session. The daemon's persistent identity key is the single
 * exception, it is serialized into the secret store to survive a restart.
 */
import { describe, expect, test } from 'bun:test';
import {
  deriveSharedSecret,
  exportRawPublicKey,
  generateEcdhKeyPair,
  RELAY_PUBLIC_KEY_BYTES,
} from '../packages/transport-core/src/relay/crypto.js';
import {
  generateRelayIdentity,
  serializeRelayIdentity,
  deserializeRelayIdentity,
} from '../packages/transport-core/src/relay/identity.js';

describe('relay key extractability', () => {
  test('an ephemeral private key refuses exportKey', async () => {
    const pair = await generateEcdhKeyPair();

    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });

  test('an ephemeral public key is still exportable and the pair still agrees', async () => {
    const a = await generateEcdhKeyPair();
    const b = await generateEcdhKeyPair();

    const rawA = await exportRawPublicKey(a.publicKey);
    expect(rawA.length).toBe(RELAY_PUBLIC_KEY_BYTES);

    const secretA = await deriveSharedSecret(a.privateKey, b.publicKey);
    const secretB = await deriveSharedSecret(b.privateKey, a.publicKey);
    expect(Array.from(secretA)).toEqual(Array.from(secretB));
  });

  test('the persistent identity key stays exportable and round-trips through storage', async () => {
    const identity = await generateRelayIdentity();

    expect(identity.privateKey.extractable).toBe(true);
    const serialized = await serializeRelayIdentity(identity);
    expect(serialized.privateKeyJwk.d).toBeTruthy();

    const restored = await deserializeRelayIdentity(serialized);
    const ephemeral = await generateEcdhKeyPair();
    const fromRestored = await deriveSharedSecret(restored.privateKey, ephemeral.publicKey);
    const fromEphemeral = await deriveSharedSecret(ephemeral.privateKey, identity.publicKey);
    expect(Array.from(fromRestored)).toEqual(Array.from(fromEphemeral));
  });
});
