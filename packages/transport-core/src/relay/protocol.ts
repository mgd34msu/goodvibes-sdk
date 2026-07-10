// relay/protocol.ts
//
// The relay-hop wire protocol. This is the ONLY part of the traffic the relay
// operator can read: connection-control frames (who is a daemon, who is a
// client, which rendezvous id, which multiplexed pipe) plus opaque binary
// payloads it forwards verbatim. The relay never sees the end-to-end keys or
// plaintext — every binary payload is ciphertext produced by secure-channel.ts.
//
// Two message shapes travel over each relay WebSocket:
//   1. Control frames  — JSON text messages (this module encodes/decodes them).
//   2. Data frames     — binary messages: on the daemon<->relay leg they carry a
//      16-byte pipe-id prefix (relay-hop routing metadata) followed by opaque
//      ciphertext; on the client<->relay leg they are bare opaque ciphertext
//      (a client owns exactly one pipe).
//
// Keeping the framing tiny and explicit is deliberate: a public relay instance
// must be auditable at a glance for exactly what it can observe.

/** Wire protocol version. Bumped only on incompatible control-frame changes. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Length in bytes of a multiplexed pipe identifier. */
export const RELAY_PIPE_ID_BYTES = 16;

/** Rendezvous id: unguessable string a daemon registers under and a client dials. */
export type RendezvousId = string;

/** Opaque multiplexed pipe id (one client<->daemon tunnel through the relay). */
export type PipeId = string;

/** Endpoint role on a relay connection. */
export type RelayRole = 'daemon' | 'client';

/** Machine-readable relay failure codes (surfaced to callers as honest errors). */
export type RelayErrorCode =
  | 'daemon-offline' // client dialed a rendezvous id with no registered daemon
  | 'rid-taken' // a second daemon tried to register an already-claimed rendezvous id
  | 'capacity' // the relay instance hit a configured cap (daemons/pipes/rate)
  | 'protocol-version' // incompatible RELAY_PROTOCOL_VERSION
  | 'malformed' // unparseable or invalid control frame
  | 'rate-limited' // per-connection or per-ip rate limit tripped
  | 'unauthorized' // reserved: relay-level access control (public instances: unused)
  | 'internal';

// ─── Control frames (JSON over WebSocket text) ────────────────────────────────

/** Daemon → relay: claim a rendezvous id and accept client pipes for it. */
export interface RelayRegisterFrame {
  readonly t: 'register';
  readonly role: 'daemon';
  readonly protocol: number;
  readonly rid: RendezvousId;
}

/** Relay → daemon: the rendezvous id is claimed; the daemon is now reachable. */
export interface RelayRegisteredFrame {
  readonly t: 'registered';
  readonly rid: RendezvousId;
}

/** Client → relay: dial a rendezvous id. */
export interface RelayConnectFrame {
  readonly t: 'connect';
  readonly role: 'client';
  readonly protocol: number;
  readonly rid: RendezvousId;
}

/** Relay → client: a pipe to the daemon is open; begin the E2E handshake. */
export interface RelayConnectedFrame {
  readonly t: 'connected';
  readonly pipe: PipeId;
}

/** Relay → daemon: a new client pipe opened for this daemon's rendezvous id. */
export interface RelayPipeOpenFrame {
  readonly t: 'pipe-open';
  readonly pipe: PipeId;
}

/** Relay → daemon/client: a pipe closed (peer gone or torn down). */
export interface RelayPipeCloseFrame {
  readonly t: 'pipe-close';
  readonly pipe: PipeId;
  readonly reason?: string;
}

/** Relay → endpoint: an error occurred. `code` is machine-readable. */
export interface RelayErrorFrame {
  readonly t: 'error';
  readonly code: RelayErrorCode;
  readonly message: string;
  readonly pipe?: PipeId;
}

/** Any endpoint ↔ relay control frame. */
export type RelayControlFrame =
  | RelayRegisterFrame
  | RelayRegisteredFrame
  | RelayConnectFrame
  | RelayConnectedFrame
  | RelayPipeOpenFrame
  | RelayPipeCloseFrame
  | RelayErrorFrame;

/** Serialize a control frame to a WebSocket text payload. */
export function encodeControlFrame(frame: RelayControlFrame): string {
  return JSON.stringify(frame);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a WebSocket text payload into a control frame, or return null if it is
 * not a recognizable, well-typed relay control frame. Callers treat null as a
 * `malformed` protocol violation.
 */
export function decodeControlFrame(text: string): RelayControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['t'] !== 'string') return null;
  const t = parsed['t'];
  switch (t) {
    case 'register':
      return isRid(parsed) && parsed['role'] === 'daemon' && typeof parsed['protocol'] === 'number'
        ? { t, role: 'daemon', protocol: parsed['protocol'], rid: parsed['rid'] as string }
        : null;
    case 'connect':
      return isRid(parsed) && parsed['role'] === 'client' && typeof parsed['protocol'] === 'number'
        ? { t, role: 'client', protocol: parsed['protocol'], rid: parsed['rid'] as string }
        : null;
    case 'registered':
      return isRid(parsed) ? { t, rid: parsed['rid'] as string } : null;
    case 'connected':
      return isPipe(parsed) ? { t, pipe: parsed['pipe'] as string } : null;
    case 'pipe-open':
      return isPipe(parsed) ? { t, pipe: parsed['pipe'] as string } : null;
    case 'pipe-close':
      return isPipe(parsed)
        ? { t, pipe: parsed['pipe'] as string, ...(typeof parsed['reason'] === 'string' ? { reason: parsed['reason'] } : {}) }
        : null;
    case 'error':
      return typeof parsed['code'] === 'string' && typeof parsed['message'] === 'string'
        ? {
            t,
            code: parsed['code'] as RelayErrorCode,
            message: parsed['message'] as string,
            ...(typeof parsed['pipe'] === 'string' ? { pipe: parsed['pipe'] as string } : {}),
          }
        : null;
    default:
      return null;
  }
}

function isRid(v: Record<string, unknown>): boolean {
  return typeof v['rid'] === 'string' && v['rid'].length > 0;
}

function isPipe(v: Record<string, unknown>): boolean {
  return typeof v['pipe'] === 'string' && v['pipe'].length > 0;
}

// ─── Data frames (binary, daemon<->relay leg carries a pipe-id prefix) ─────────

/**
 * Prefix an opaque ciphertext payload with its 16-byte pipe id, for the
 * daemon<->relay leg where a single socket multiplexes many client pipes.
 * `pipeIdBytes` is the raw 16-byte random pipe id; its base64url encoding is the
 * `PipeId` string carried in control frames (the daemon correlates the two by
 * base64url-encoding this prefix). The relay reads this prefix as routing
 * metadata and never inspects the payload that follows.
 */
export function framePipePayload(pipeIdBytes: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (pipeIdBytes.length !== RELAY_PIPE_ID_BYTES) {
    throw new Error(`pipe id must be ${RELAY_PIPE_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(RELAY_PIPE_ID_BYTES + payload.length);
  out.set(pipeIdBytes, 0);
  out.set(payload, RELAY_PIPE_ID_BYTES);
  return out;
}

/** Split a daemon<->relay binary frame into its pipe-id prefix and opaque payload. */
export function unframePipePayload(frame: Uint8Array<ArrayBuffer>): { readonly pipeId: Uint8Array<ArrayBuffer>; readonly payload: Uint8Array<ArrayBuffer> } | null {
  if (frame.length < RELAY_PIPE_ID_BYTES) return null;
  return {
    pipeId: frame.subarray(0, RELAY_PIPE_ID_BYTES),
    payload: frame.subarray(RELAY_PIPE_ID_BYTES),
  };
}
