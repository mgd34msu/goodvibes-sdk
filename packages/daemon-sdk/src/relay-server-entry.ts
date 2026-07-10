#!/usr/bin/env bun
// relay-server-entry.ts
//
// The Bun.serve adapter and standalone entry point for the rendezvous relay.
// This is what you deploy on a VPS:
//
//     bun packages/daemon-sdk/dist/relay-server-entry.js
//   or, once published:
//     bunx --bun @pellux/goodvibes-daemon-sdk-relay
//
// It binds a WebSocket endpoint and drives the runtime-neutral RelayHub. All the
// zero-knowledge properties live in the hub and the transport-core relay crypto;
// this file is only glue.

import {
  DEFAULT_RELAY_LIMITS,
  RelayHub,
  type RelayConnection,
  type RelayServerLimits,
  type RelayServerLogger,
} from './relay-server.js';

interface RelayConnectionData {
  conn: RelayConnection | null;
  readonly addr: string;
}

/** Options for {@link createBunRelayServer}. */
export interface BunRelayServerOptions {
  /** TCP port to listen on (default 8787). */
  readonly port?: number;
  /** Hostname/interface to bind (default all interfaces). */
  readonly hostname?: string;
  /** Caps and rate limits (merged over DEFAULT_RELAY_LIMITS). */
  readonly limits?: Partial<RelayServerLimits>;
  /** Structured logger (default console). */
  readonly logger?: RelayServerLogger;
}

const consoleLogger: RelayServerLogger = {
  info: (m, f) => console.log(`[relay] ${m}`, f ?? ''),
  warn: (m, f) => console.warn(`[relay] ${m}`, f ?? ''),
  error: (m, f) => console.error(`[relay] ${m}`, f ?? ''),
};

function toArrayBufferBytes(message: ArrayBufferView | ArrayBuffer): Uint8Array<ArrayBuffer> {
  if (message instanceof ArrayBuffer) return new Uint8Array(message.slice(0));
  return new Uint8Array(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
}

/**
 * Start the relay on Bun. Returns the Bun server handle (call `.stop()` to shut
 * down). The health endpoint `GET /` reports occupancy; everything else is the
 * WebSocket upgrade path.
 */
export function createBunRelayServer(options: BunRelayServerOptions = {}) {
  const hub = new RelayHub({
    ...(options.limits ? { limits: options.limits } : {}),
    logger: options.logger ?? consoleLogger,
  });
  const port = options.port ?? 8787;

  const server = Bun.serve<RelayConnectionData>({
    port,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const addr = srv.requestIP(req)?.address ?? 'unknown';
        const data: RelayConnectionData = { conn: null, addr };
        if (srv.upgrade(req, { data })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/healthz') {
        return Response.json({ ok: true, protocol: 1, ...hub.stats() });
      }
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      maxPayloadLength: (options.limits?.maxMessageBytes ?? DEFAULT_RELAY_LIMITS.maxMessageBytes) + 1024,
      open(ws) {
        ws.data.conn = hub.accept(
          {
            send: (data) => {
              ws.send(data);
            },
            close: (code, reason) => {
              ws.close(code, reason);
            },
          },
          ws.data.addr,
        );
      },
      message(ws, message) {
        const conn = ws.data.conn;
        if (!conn) return;
        if (typeof message === 'string') {
          conn.handleText(message);
        } else {
          conn.handleBinary(toArrayBufferBytes(message));
        }
      },
      close(ws) {
        ws.data.conn?.handleClose();
      },
    },
  });

  return server;
}

if (import.meta.main) {
  const port = Number(process.env['GOODVIBES_RELAY_PORT'] ?? 8787);
  const hostname = process.env['GOODVIBES_RELAY_HOST'];
  const server = createBunRelayServer({
    port,
    ...(hostname ? { hostname } : {}),
  });
  console.log(`[relay] listening on ${server.hostname}:${server.port} (protocol 1)`);
}
