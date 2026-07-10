// relay/secure-channel.ts
//
// The AEAD record layer that rides on top of a completed handshake. It turns the
// two directional AES-256-GCM keys into an ordered, replay-resistant stream of
// sealed frames. This is what actually makes the bytes the relay forwards
// opaque: application payloads never touch the wire except as GCM ciphertext.
//
// Frame layout (all binary, forwarded verbatim by the relay):
//   [ counter : 8 bytes big-endian ][ AES-256-GCM ciphertext+tag ]
// The nonce is derived, never transmitted as free bytes: a 4-byte direction
// prefix plus the 8-byte counter. Counters strictly increase per direction, so
// a replayed or reordered frame is rejected — GCM never reuses a (key, nonce)
// pair, which is the one catastrophic failure mode for GCM.

import { aeadOpen, aeadSeal, RELAY_NONCE_BYTES } from './crypto.js';
import type { RelayHandshakeKeys } from './handshake.js';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

const COUNTER_BYTES = 8;
const DIRECTION_PREFIX_BYTES = RELAY_NONCE_BYTES - COUNTER_BYTES; // 4
const PREFIX_CLIENT_TO_DAEMON = new Uint8Array([0x63, 0x32, 0x64, 0x00]); // "c2d\0"
const PREFIX_DAEMON_TO_CLIENT = new Uint8Array([0x64, 0x32, 0x63, 0x00]); // "d2c\0"
// Guard against counter exhaustion far below the 2^64 ceiling. In practice a
// channel is torn down long before this; hitting it is a hard error, never a
// silent wrap (which would reuse a nonce).
const MAX_COUNTER = 0xffff_ffff_ffff_ff00;

function nonceFor(prefix: Uint8Array<ArrayBuffer>, counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(RELAY_NONCE_BYTES);
  nonce.set(prefix, 0);
  const view = new DataView(nonce.buffer);
  view.setBigUint64(DIRECTION_PREFIX_BYTES, BigInt(counter), false);
  return nonce;
}

/**
 * An authenticated, ordered channel between one client and one daemon,
 * established from a completed handshake. `role` selects which directional key
 * is used for sending vs receiving.
 */
export class RelaySecureChannel {
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private readonly sendPrefix: Uint8Array<ArrayBuffer>;
  private readonly recvPrefix: Uint8Array<ArrayBuffer>;
  private readonly aad: Uint8Array<ArrayBuffer>;
  private sendCounter = 0;
  private lastRecvCounter = -1;

  constructor(keys: RelayHandshakeKeys, role: 'client' | 'daemon') {
    if (role === 'client') {
      this.sendKey = keys.clientToDaemonKey;
      this.recvKey = keys.daemonToClientKey;
      this.sendPrefix = PREFIX_CLIENT_TO_DAEMON;
      this.recvPrefix = PREFIX_DAEMON_TO_CLIENT;
    } else {
      this.sendKey = keys.daemonToClientKey;
      this.recvKey = keys.clientToDaemonKey;
      this.sendPrefix = PREFIX_DAEMON_TO_CLIENT;
      this.recvPrefix = PREFIX_CLIENT_TO_DAEMON;
    }
    this.aad = keys.transcriptHash;
  }

  /** Seal an application payload into a wire frame (counter prefix + ciphertext). */
  async seal(plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.sendCounter >= MAX_COUNTER) {
      throw new GoodVibesSdkError('Relay secure channel counter exhausted; reconnect required.', {
        category: 'protocol',
        source: 'transport',
        recoverable: true,
        hint: 'Tear down and re-establish the relay pipe to rotate keys.',
      });
    }
    const counter = this.sendCounter;
    this.sendCounter += 1;
    const nonce = nonceFor(this.sendPrefix, counter);
    const ciphertext = await aeadSeal(this.sendKey, nonce, plaintext, this.aad);
    const frame = new Uint8Array(COUNTER_BYTES + ciphertext.length);
    new DataView(frame.buffer).setBigUint64(0, BigInt(counter), false);
    frame.set(ciphertext, COUNTER_BYTES);
    return frame;
  }

  /** Open a received wire frame, enforcing strictly-increasing counters. */
  async open(frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.length <= COUNTER_BYTES) {
      throw new GoodVibesSdkError('Truncated relay channel frame.', { category: 'protocol', source: 'transport', recoverable: false });
    }
    const counter = Number(new DataView(frame.buffer, frame.byteOffset, COUNTER_BYTES).getBigUint64(0, false));
    if (counter <= this.lastRecvCounter) {
      throw new GoodVibesSdkError('Relay channel frame replay or reorder detected.', {
        category: 'protocol',
        source: 'transport',
        recoverable: false,
        hint: 'Frame counter did not strictly increase; the channel integrity is compromised.',
      });
    }
    const nonce = nonceFor(this.recvPrefix, counter);
    const plaintext = await aeadOpen(this.recvKey, nonce, frame.subarray(COUNTER_BYTES), this.aad);
    this.lastRecvCounter = counter;
    return plaintext;
  }
}
