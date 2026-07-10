// relay/pairing.ts
//
// The pairing payload is the out-of-band bootstrap for a relay connection: it
// carries everything a surface needs to reach a daemon and authenticate it —
// the relay URL, the unguessable rendezvous id, and the daemon's pinned static
// public key. It is deliberately compact and QR-encodable (base64url of a small
// JSON object, prefixed with a self-describing scheme tag) because the intended
// delivery is a QR code scanned from the daemon's screen, the same trust model
// as pairing a phone by scanning a code.
//
// Delivering this payload over a trusted channel (QR on the same LAN, a copied
// string) is what bootstraps trust. Whoever holds a valid pairing payload can
// reach the daemon through the relay; treat it like a credential.

import { fromBase64Url, toBase64Url, decodeUtf8, encodeUtf8 } from './crypto.js';
import { RELAY_PROTOCOL_VERSION, type RendezvousId } from './protocol.js';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

/** Self-describing prefix so a scanner can recognize a relay pairing string. */
export const PAIRING_SCHEME = 'gvrelay1';

/** The decoded contents of a pairing payload. */
export interface RelayPairingPayload {
  /** Pairing format / protocol version. */
  readonly protocol: number;
  /** Public relay URL the surface should dial (wss://…). */
  readonly relayUrl: string;
  /** Unguessable rendezvous id the daemon registered under. */
  readonly rid: RendezvousId;
  /** Daemon static public key (raw uncompressed P-256), base64url. */
  readonly daemonPublicKey: string;
  /** Optional human-facing label for the daemon (shown in the surface UI). */
  readonly label?: string;
}

interface WirePairing {
  readonly p: number;
  readonly u: string;
  readonly r: string;
  readonly k: string;
  readonly l?: string;
}

/** Mint a pairing payload object from its parts. */
export function createRelayPairingPayload(input: {
  readonly relayUrl: string;
  readonly rid: RendezvousId;
  readonly daemonPublicKey: string;
  readonly label?: string;
}): RelayPairingPayload {
  return {
    protocol: RELAY_PROTOCOL_VERSION,
    relayUrl: input.relayUrl,
    rid: input.rid,
    daemonPublicKey: input.daemonPublicKey,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}

/** Encode a pairing payload to a compact, QR-friendly string. */
export function encodeRelayPairingString(payload: RelayPairingPayload): string {
  const wire: WirePairing = {
    p: payload.protocol,
    u: payload.relayUrl,
    r: payload.rid,
    k: payload.daemonPublicKey,
    ...(payload.label !== undefined ? { l: payload.label } : {}),
  };
  return `${PAIRING_SCHEME}.${toBase64Url(encodeUtf8(JSON.stringify(wire)))}`;
}

/** Decode a pairing string back into a payload. Throws on malformed input. */
export function decodeRelayPairingString(text: string): RelayPairingPayload {
  const trimmed = text.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 0 || trimmed.slice(0, dot) !== PAIRING_SCHEME) {
    throw new GoodVibesSdkError('Not a recognizable relay pairing string.', {
      category: 'bad_request',
      source: 'transport',
      recoverable: false,
      hint: `Expected a "${PAIRING_SCHEME}." prefixed pairing code.`,
    });
  }
  let wire: unknown;
  try {
    wire = JSON.parse(decodeUtf8(fromBase64Url(trimmed.slice(dot + 1))));
  } catch {
    throw new GoodVibesSdkError('Corrupt relay pairing string.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  if (
    typeof wire !== 'object' ||
    wire === null ||
    typeof (wire as WirePairing).p !== 'number' ||
    typeof (wire as WirePairing).u !== 'string' ||
    typeof (wire as WirePairing).r !== 'string' ||
    typeof (wire as WirePairing).k !== 'string'
  ) {
    throw new GoodVibesSdkError('Relay pairing string is missing required fields.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  const w = wire as WirePairing;
  return {
    protocol: w.p,
    relayUrl: w.u,
    rid: w.r,
    daemonPublicKey: w.k,
    ...(typeof w.l === 'string' ? { label: w.l } : {}),
  };
}
