/**
 * relay-step-up-webauthn.test.ts
 *
 * The real WebAuthn step-up ceremony, end to end, with NO mock crypto: each test
 * generates a P-256 keypair, encodes its public key as a COSE_Key exactly as a
 * real authenticator's 'none'-attestation registration yields, and signs a
 * genuine assertion over `authenticatorData || SHA-256(clientDataJSON)`. The
 * StepUpService then verifies it through the same path the relay gate uses.
 *
 * Covers: the happy path (a fresh, valid assertion passes), and every refusal
 * the ceremony must enforce — an unminted/tampered challenge, an expired
 * challenge, a replayed (consumed) challenge, a wrong origin, and a signature
 * counter that goes backwards (a cloned-authenticator signal).
 */
import { describe, expect, test } from 'bun:test';
import { fromBase64Url, toBase64Url } from '@pellux/goodvibes-transport-core/relay';
import {
  StepUpService,
  encodeAssertionHeader,
} from '../packages/sdk/src/platform/relay/step-up-service.ts';
import type { StepUpAssertionEnvelope } from '../packages/sdk/src/platform/relay/step-up-webauthn.ts';

const RP_ID = 'daemon.example';
const ORIGIN = 'https://daemon.example';

function u8(...bytes: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

/** Encode a byte string as a CBOR byte-string of length 32 (0x58 0x20 <bytes>). */
function cborByteString32(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2 + 32);
  out[0] = 0x58;
  out[1] = 0x20;
  out.set(bytes, 2);
  return out as Uint8Array<ArrayBuffer>;
}

/** Build a COSE_Key (EC2 / P-256 / ES256) from the raw 65-byte public point. */
function coseFromRawPoint(rawPoint: Uint8Array): Uint8Array<ArrayBuffer> {
  const x = rawPoint.subarray(1, 33);
  const y = rawPoint.subarray(33, 65);
  const parts: number[] = [
    0xa5, // map(5)
    0x01, 0x02, // 1 (kty) : 2 (EC2)
    0x03, 0x26, // 3 (alg) : -7 (ES256)
    0x20, 0x01, // -1 (crv): 1 (P-256)
    0x21, // -2 (x):
  ];
  const head = new Uint8Array(parts);
  const xTag = cborByteString32(x);
  const yHead = new Uint8Array([0x22]); // -3 (y):
  const yTag = cborByteString32(y);
  const total = new Uint8Array(head.length + xTag.length + yHead.length + yTag.length);
  let o = 0;
  total.set(head, o); o += head.length;
  total.set(xTag, o); o += xTag.length;
  total.set(yHead, o); o += yHead.length;
  total.set(yTag, o);
  return total as Uint8Array<ArrayBuffer>;
}

/** Convert a raw 64-byte r||s ECDSA signature into ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const encodeInt = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;
    let slice = Array.from(bytes.subarray(start));
    if ((slice[0]! & 0x80) !== 0) slice = [0x00, ...slice];
    return [0x02, slice.length, ...slice];
  };
  const r = encodeInt(raw.subarray(0, 32));
  const s = encodeInt(raw.subarray(32, 64));
  const body = [...r, ...s];
  return new Uint8Array([0x30, body.length, ...body]) as Uint8Array<ArrayBuffer>;
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data)) as Uint8Array<ArrayBuffer>;
}

interface SyntheticCredential {
  readonly privateKey: CryptoKey;
  readonly credentialId: string;
  readonly publicKeyCose: string;
}

async function makeCredential(): Promise<SyntheticCredential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPoint = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    credentialId: toBase64Url(u8(1, 2, 3, 4, 5, 6, 7, 8)),
    publicKeyCose: toBase64Url(coseFromRawPoint(rawPoint)),
  };
}

interface SignOptions {
  readonly credential: SyntheticCredential;
  readonly challenge: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly signCount?: number;
  readonly flags?: number;
}

async function signAssertion(opts: SignOptions): Promise<StepUpAssertionEnvelope> {
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: opts.challenge,
    origin: opts.origin ?? ORIGIN,
  });
  const clientDataBytes = new TextEncoder().encode(clientData);
  const rpIdHash = await sha256(new TextEncoder().encode(opts.rpId ?? RP_ID));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = opts.flags ?? 0x05; // UP (0x01) | UV (0x04)
  new DataView(authData.buffer).setUint32(33, opts.signCount ?? 1, false);
  const clientDataHash = await sha256(clientDataBytes);
  const signatureBase = new Uint8Array(authData.length + clientDataHash.length);
  signatureBase.set(authData, 0);
  signatureBase.set(clientDataHash, authData.length);
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.credential.privateKey, signatureBase));
  return {
    credentialId: opts.credential.credentialId,
    authenticatorData: toBase64Url(authData as Uint8Array<ArrayBuffer>),
    clientDataJSON: toBase64Url(clientDataBytes as Uint8Array<ArrayBuffer>),
    signature: toBase64Url(rawToDer(rawSig)),
  };
}

function makeService(now: () => number = () => 1_000): { service: StepUpService; store: Map<string, string> } {
  const store = new Map<string, string>();
  const service = new StepUpService({
    secrets: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => { store.set(key, value); },
    },
    now,
  });
  return { service, store };
}

async function register(service: StepUpService, credential: SyntheticCredential): Promise<void> {
  await service.registerCredential({
    rpId: RP_ID,
    origin: ORIGIN,
    credentialId: credential.credentialId,
    publicKeyCose: credential.publicKeyCose,
    signCount: 0,
  });
}

describe('relay step-up WebAuthn ceremony', () => {
  test('happy path: a fresh, valid assertion over a minted challenge verifies', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge, signCount: 5 });
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result.ok).toBe(true);
  });

  test('registration rejects a public key that is not a valid P-256 COSE key', async () => {
    const { service } = makeService();
    await expect(service.registerCredential({
      rpId: RP_ID, origin: ORIGIN, credentialId: 'abc', publicKeyCose: toBase64Url(u8(0, 1, 2, 3)),
    })).rejects.toThrow(/COSE key/);
  });

  test('an unminted (tampered) challenge is refused as unknown', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    // Sign a challenge the server never issued.
    const envelope = await signAssertion({ credential, challenge: toBase64Url(u8(9, 9, 9, 9, 9, 9, 9, 9)) });
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result).toEqual({ ok: false, reason: 'unknown-challenge' });
  });

  test('an expired challenge is refused', async () => {
    let clock = 1_000;
    const { service } = makeService(() => clock);
    const credential = await makeCredential();
    await register(service, credential);
    const minted = service.mintChallenge({ ttlMs: 5_000 });
    const envelope = await signAssertion({ credential, challenge: minted.challenge });
    clock = 1_000 + 5_001; // advance past the freshness window
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result).toEqual({ ok: false, reason: 'challenge-expired' });
  });

  test('a replayed (already-consumed) challenge is refused the second time', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge, signCount: 2 });
    const header = encodeAssertionHeader(envelope);
    const first = await service.verify(header);
    expect(first.ok).toBe(true);
    const second = await service.verify(header);
    expect(second).toEqual({ ok: false, reason: 'unknown-challenge' });
  });

  test('a wrong origin is refused', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge, origin: 'https://evil.example' });
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result).toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  test('missing user-presence flag is refused', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge, flags: 0x04 }); // UV only, no UP
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result).toEqual({ ok: false, reason: 'user-presence-missing' });
  });

  test('a signature-counter regression is refused', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);

    // First assertion advances the stored counter to 10.
    const first = service.mintChallenge();
    const firstEnvelope = await signAssertion({ credential, challenge: first.challenge, signCount: 10 });
    expect((await service.verify(encodeAssertionHeader(firstEnvelope))).ok).toBe(true);

    // Second assertion reports a LOWER counter (a cloned authenticator).
    const second = service.mintChallenge();
    const secondEnvelope = await signAssertion({ credential, challenge: second.challenge, signCount: 4 });
    const result = await service.verify(encodeAssertionHeader(secondEnvelope));
    expect(result).toEqual({ ok: false, reason: 'sign-count-regression' });
  });

  test('the createVerifier() function is a real StepUpAssertionVerifier (true only on a valid assertion)', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    await register(service, credential);
    const verify = service.createVerifier();
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge });
    expect(await verify(encodeAssertionHeader(envelope), { method: 'POST', path: '/api/x' })).toBe(true);
    expect(await verify('not-a-real-assertion', { method: 'POST', path: '/api/x' })).toBe(false);
  });

  test('an assertion for an unregistered credential is refused', async () => {
    const { service } = makeService();
    const credential = await makeCredential();
    // NOTE: not registered.
    const minted = service.mintChallenge();
    const envelope = await signAssertion({ credential, challenge: minted.challenge });
    const result = await service.verify(encodeAssertionHeader(envelope));
    expect(result).toEqual({ ok: false, reason: 'no-credential' });
  });
});
