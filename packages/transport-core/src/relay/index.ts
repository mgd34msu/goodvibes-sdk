// relay/index.ts
//
// Runtime-neutral building blocks for the zero-knowledge, self-hostable relay:
// the hop protocol the relay operator can read, and the end-to-end crypto it
// cannot. Consumed by the relay server (daemon-sdk), the client relay transport
// (transport-realtime), and the daemon-side termination. Kept off the main
// transport-core barrel so it stays an explicit, opt-in subpath import.

export {
  RELAY_CURVE,
  RELAY_PUBLIC_KEY_BYTES,
  RELAY_NONCE_BYTES,
  RELAY_KEY_BYTES,
  randomBytes,
  toBase64Url,
  fromBase64Url,
  bytesEqual,
  concatBytes,
  encodeUtf8,
  decodeUtf8,
  generateEcdhKeyPair,
  exportRawPublicKey,
  importRawPublicKey,
  deriveSharedSecret,
  sha256,
  hkdf,
  importAeadKey,
  aeadSeal,
  aeadOpen,
  type RelayKeyPair,
} from './crypto.js';

export {
  RELAY_PROTOCOL_VERSION,
  RELAY_PIPE_ID_BYTES,
  encodeControlFrame,
  decodeControlFrame,
  framePipePayload,
  unframePipePayload,
  type RendezvousId,
  type PipeId,
  type RelayRole,
  type RelayErrorCode,
  type RelayControlFrame,
  type RelayRegisterFrame,
  type RelayRegisteredFrame,
  type RelayConnectFrame,
  type RelayConnectedFrame,
  type RelayPipeOpenFrame,
  type RelayPipeCloseFrame,
  type RelayErrorFrame,
} from './protocol.js';

export {
  startInitiatorHandshake,
  finishInitiatorHandshake,
  respondToHandshake,
  type RelayHandshakeKeys,
  type RelayInitiatorState,
} from './handshake.js';

export { RelaySecureChannel } from './secure-channel.js';

export {
  generateRelayIdentity,
  serializeRelayIdentity,
  deserializeRelayIdentity,
  relayIdentityPublicKeyBase64Url,
  type SerializedRelayIdentity,
} from './identity.js';

export {
  PAIRING_SCHEME,
  createRelayPairingPayload,
  encodeRelayPairingString,
  decodeRelayPairingString,
  type RelayPairingPayload,
} from './pairing.js';

export {
  encodeTunnelFrame,
  decodeTunnelFrame,
  type TunnelHeader,
  type TunnelRequestHeader,
  type TunnelResponseHeader,
  type TunnelStreamOpenHeader,
  type TunnelStreamDataHeader,
  type TunnelStreamOverflowHeader,
  type TunnelStreamCloseHeader,
} from './tunnel.js';
