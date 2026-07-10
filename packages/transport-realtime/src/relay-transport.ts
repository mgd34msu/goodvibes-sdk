// relay-transport.ts
//
// The client half of the relay path. Its whole job is to produce a `fetch`
// implementation backed by the end-to-end secure channel, so the EXISTING typed
// operator/peer client works completely unchanged over the relay: you build the
// SDK with `fetchImpl: relayClient.fetch` instead of the default, and every
// contract call is serialized to an HTTP request, tunneled as ciphertext to the
// daemon, replayed there, and its response tunneled back. The relay operator
// never sees any of it.
//
// Scope note (honest): this tunnels unary request/response calls — the bulk of
// the operator surface. Server-Sent-Event streaming over the relay is not yet
// bridged (see the relay docs); event streaming keeps using the direct realtime
// connectors on the LAN. A streaming bridge is deferred, not faked.

import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import { createUuidV4 } from '@pellux/goodvibes-transport-core';
import {
  RelaySecureChannel,
  decodeControlFrame,
  decodeRelayPairingString,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  finishInitiatorHandshake,
  fromBase64Url,
  startInitiatorHandshake,
  type RelayInitiatorState,
  type RelayPairingPayload,
} from '@pellux/goodvibes-transport-core/relay';

/** Minimal structural WebSocket shape the relay client needs (browser/Bun/Node). */
export interface RelayWebSocketLike {
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** Options for {@link createRelayClient}. */
export interface RelayClientOptions {
  /** Pairing payload (object or the `gvrelay1.` encoded string) identifying the daemon. */
  readonly pairing: RelayPairingPayload | string;
  /** WebSocket constructor override (defaults to `globalThis.WebSocket`). */
  readonly webSocketImpl?: (url: string) => RelayWebSocketLike;
  /** Milliseconds to wait for the pipe + handshake before failing connect (default 15000). */
  readonly connectTimeoutMs?: number;
  /** Per-request timeout in milliseconds (default 30000). */
  readonly requestTimeoutMs?: number;
}

/** A live relay client: a relay-backed `fetch` plus explicit lifecycle. */
export interface RelayClient {
  /** A `fetch` implementation to hand to the SDK as `fetchImpl`. */
  readonly fetch: typeof fetch;
  /** Establish the pipe + E2E handshake. Idempotent; the fetch auto-connects too. */
  connect(): Promise<void>;
  /** Tear down the relay connection. */
  close(): void;
  /** True once the E2E channel is ready. */
  readonly ready: boolean;
}

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

function resolvePairing(pairing: RelayPairingPayload | string): RelayPairingPayload {
  return typeof pairing === 'string' ? decodeRelayPairingString(pairing) : pairing;
}

function defaultWebSocket(url: string): RelayWebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => RelayWebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new GoodVibesSdkError('No WebSocket implementation is available in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Provide options.webSocketImpl, or run where globalThis.WebSocket exists.',
    });
  }
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  throw new GoodVibesSdkError('Relay received a non-binary data frame.', { category: 'protocol', source: 'transport', recoverable: false });
}

/**
 * Create a relay client for a paired daemon. The returned `fetch` transparently
 * tunnels every request through the zero-knowledge channel.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const pairing = resolvePairing(options.pairing);
  const daemonPubRaw = fromBase64Url(pairing.daemonPublicKey);
  const ridBytes = encodeUtf8(pairing.rid);
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const makeSocket = options.webSocketImpl ?? defaultWebSocket;

  let socket: RelayWebSocketLike | null = null;
  let channel: RelaySecureChannel | null = null;
  let initiatorState: RelayInitiatorState | null = null;
  let connectPromise: Promise<void> | null = null;
  const pending = new Map<string, PendingRequest>();

  function failAll(error: unknown): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }

  function teardown(error?: unknown): void {
    if (error) failAll(error);
    try {
      socket?.close();
    } catch {
      // ignore close errors
    }
    socket = null;
    channel = null;
    initiatorState = null;
    connectPromise = null;
  }

  async function onBinary(bytes: Uint8Array<ArrayBuffer>, markReady: () => void): Promise<void> {
    if (!channel) {
      // First binary is the handshake response (message2).
      if (!initiatorState) throw new GoodVibesSdkError('Unexpected relay frame before handshake start.', { category: 'protocol', source: 'transport', recoverable: false });
      const keys = await finishInitiatorHandshake(initiatorState, bytes);
      channel = new RelaySecureChannel(keys, 'client');
      markReady();
      return;
    }
    const framed = decodeTunnelFrame(await channel.open(bytes));
    if (!framed || framed.header.kind !== 'response') return;
    const waiting = pending.get(framed.header.id);
    if (!waiting) return;
    pending.delete(framed.header.id);
    clearTimeout(waiting.timer);
    waiting.resolve(new Response(framed.body.length > 0 ? framed.body : null, {
      status: framed.header.status,
      headers: framed.header.headers.map(([k, v]) => [k, v] as [string, string]),
    }));
  }

  function connect(): Promise<void> {
    if (channel) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          teardown(err);
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => done(new GoodVibesSdkError('Timed out establishing the relay connection.', {
        category: 'timeout',
        source: 'transport',
        recoverable: true,
        hint: 'The daemon may be offline or the relay unreachable.',
      })), connectTimeoutMs);

      const ws = makeSocket(pairing.relayUrl);
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.addEventListener('open', () => {
        ws.send(encodeControlFrame({ t: 'connect', role: 'client', protocol: 1, rid: pairing.rid }));
      });
      ws.addEventListener('message', (event) => {
        const data = (event as { data: unknown }).data;
        void (async () => {
          try {
            if (typeof data === 'string') {
              const frame = decodeControlFrame(data);
              if (!frame) return;
              if (frame.t === 'connected') {
                const started = await startInitiatorHandshake(daemonPubRaw, ridBytes);
                initiatorState = started.state;
                ws.send(started.message1);
              } else if (frame.t === 'error') {
                done(new GoodVibesSdkError(`Relay refused the connection: ${frame.message}`, {
                  category: frame.code === 'daemon-offline' ? 'not_found' : 'service',
                  source: 'transport',
                  recoverable: frame.code !== 'daemon-offline',
                  hint: frame.code === 'daemon-offline' ? 'The daemon is not registered on the relay (offline or wrong rendezvous id).' : undefined,
                }));
              } else if (frame.t === 'pipe-close') {
                teardown(new GoodVibesSdkError('Relay pipe closed.', { category: 'network', source: 'transport', recoverable: true }));
              }
              return;
            }
            await onBinary(toBytes(data), () => done());
          } catch (err) {
            done(err);
          }
        })();
      });
      ws.addEventListener('close', () => {
        teardown(new GoodVibesSdkError('Relay connection closed.', { category: 'network', source: 'transport', recoverable: true }));
      });
      ws.addEventListener('error', () => {
        done(new GoodVibesSdkError('Relay WebSocket error.', { category: 'network', source: 'transport', recoverable: true }));
      });
    });
    return connectPromise;
  }

  const relayFetch: typeof fetch = async (input, init) => {
    await connect();
    if (!channel || !socket) throw new GoodVibesSdkError('Relay channel is not ready.', { category: 'network', source: 'transport', recoverable: true });
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url, 'http://relay.local');
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, key) => headers.push([key, value]));
    const bodyText = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const id = createUuidV4();
    const frame = encodeTunnelFrame(
      { id, kind: 'request', method: request.method, path: `${url.pathname}${url.search}`, headers },
      bodyText ? encodeUtf8(bodyText) : new Uint8Array(0),
    );
    const sealed = await channel.seal(frame);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new GoodVibesSdkError('Relay request timed out.', { category: 'timeout', source: 'transport', recoverable: true }));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket!.send(sealed);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  };

  return {
    fetch: relayFetch,
    connect,
    close: () => teardown(),
    get ready(): boolean {
      return channel !== null;
    },
  };
}
