// relay/tunnel.ts
//
// The application framing that rides inside the E2E secure channel: whole HTTP
// request/response pairs, tunneled opaquely between a surface and the daemon.
// Because the operator protocol is contract-driven REST-over-JSON, tunneling
// HTTP is all it takes for the existing typed client to work unchanged over the
// relay — the client's transport just swaps its `fetch` for one that serializes
// the Request here, and the daemon replays it against its own route dispatcher.
//
// Frame layout (this is what the secure channel seals, never the relay's
// business):
//   [ headerLen : 4 bytes BE ][ header JSON (UTF-8) ][ raw body bytes ]
// Keeping the body as raw bytes (not base64 inside JSON) avoids inflating
// payloads and keeps binary bodies exact.

import { concatBytes, decodeUtf8, encodeUtf8 } from './crypto.js';

/** A tunneled HTTP request (surface → daemon). */
export interface TunnelRequestHeader {
  readonly id: string;
  readonly kind: 'request';
  readonly method: string;
  /** Path + query only (no host); the daemon resolves it against its local base. */
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** A tunneled HTTP response (daemon → surface). */
export interface TunnelResponseHeader {
  readonly id: string;
  readonly kind: 'response';
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** Any tunnel frame header. */
export type TunnelHeader = TunnelRequestHeader | TunnelResponseHeader;

/** Encode a tunnel header + body into a single frame for the secure channel. */
export function encodeTunnelFrame(header: TunnelHeader, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const headerBytes = encodeUtf8(JSON.stringify(header));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, headerBytes.length, false);
  return concatBytes(prefix, headerBytes, body);
}

/** Decode a tunnel frame into its header and raw body. Returns null if malformed. */
export function decodeTunnelFrame(
  frame: Uint8Array<ArrayBuffer>,
): { readonly header: TunnelHeader; readonly body: Uint8Array<ArrayBuffer> } | null {
  if (frame.length < 4) return null;
  const headerLen = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (frame.length < 4 + headerLen) return null;
  let header: unknown;
  try {
    header = JSON.parse(decodeUtf8(frame.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (!isTunnelHeader(header)) return null;
  return { header, body: frame.subarray(4 + headerLen).slice() };
}

function isTunnelHeader(value: unknown): value is TunnelHeader {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || !Array.isArray(v['headers'])) return false;
  if (v['kind'] === 'request') return typeof v['method'] === 'string' && typeof v['path'] === 'string';
  if (v['kind'] === 'response') return typeof v['status'] === 'number';
  return false;
}
