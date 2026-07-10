// relay-server.ts
//
// A minimal, self-hostable, zero-knowledge rendezvous relay. Deploy one process
// on any VPS with `bun`, point daemons and surfaces at it, and it pairs them
// without ever being able to read their traffic. It does exactly three things:
//
//   1. Lets a daemon connect OUTBOUND and register under an unguessable
//      rendezvous id (no inbound port on the daemon's network required).
//   2. Lets a client dial that same rendezvous id and opens a multiplexed pipe
//      between the two.
//   3. Forwards OPAQUE bytes between the paired endpoints. The end-to-end
//      handshake (see @pellux/goodvibes-transport-core/relay) runs inside each
//      pipe before any application data, so the relay only ever sees ciphertext
//      plus connection metadata (who paired with whom, byte counts, timing).
//
// There are NO accounts and NO stored state — a public instance is protected
// only by caps and rate limits so it cannot be turned into a liability. The
// core `RelayHub` is runtime-neutral and socket-agnostic (testable without a
// real server); `createBunRelayServer` is the thin Bun.serve adapter.

import {
  RELAY_PROTOCOL_VERSION,
  RELAY_PIPE_ID_BYTES,
  decodeControlFrame,
  encodeControlFrame,
  framePipePayload,
  randomBytes,
  toBase64Url,
  unframePipePayload,
  type PipeId,
  type RelayErrorCode,
  type RendezvousId,
} from '@pellux/goodvibes-transport-core/relay';

/** The subset of a WebSocket the hub needs. Keeps the hub runtime-neutral. */
export interface RelayServerSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Optional structured logger; defaults to silent. */
export interface RelayServerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Caps and rate limits that keep a public instance from becoming a liability. */
export interface RelayServerLimits {
  /** Maximum concurrently-registered daemons. */
  readonly maxDaemons: number;
  /** Maximum concurrent client pipes across all daemons. */
  readonly maxPipes: number;
  /** Maximum concurrent client pipes for a single daemon. */
  readonly maxPipesPerDaemon: number;
  /** Maximum bytes in a single forwarded data frame. */
  readonly maxMessageBytes: number;
  /** Maximum register/connect attempts per remote address per rolling minute. */
  readonly maxHandshakesPerMinutePerAddr: number;
}

export const DEFAULT_RELAY_LIMITS: RelayServerLimits = {
  maxDaemons: 256,
  maxPipes: 4096,
  maxPipesPerDaemon: 64,
  maxMessageBytes: 4 * 1024 * 1024,
  maxHandshakesPerMinutePerAddr: 120,
};

const SILENT_LOGGER: RelayServerLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface DaemonRegistration {
  readonly socket: RelayServerSocket;
  readonly pipes: Set<PipeId>;
}

interface PipeRecord {
  readonly rid: RendezvousId;
  readonly client: RelayServerSocket;
  readonly daemon: RelayServerSocket;
  readonly pipeIdBytes: Uint8Array<ArrayBuffer>;
}

function errorFrame(code: RelayErrorCode, message: string, pipe?: PipeId): string {
  return encodeControlFrame(pipe !== undefined ? { t: 'error', code, message, pipe } : { t: 'error', code, message });
}

/** A simple per-address rolling-minute counter for handshake attempts. */
class HandshakeRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number) {}
  allow(addr: string, now: number): boolean {
    const cutoff = now - 60_000;
    const list = (this.hits.get(addr) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.perMinute) {
      this.hits.set(addr, list);
      return false;
    }
    list.push(now);
    this.hits.set(addr, list);
    return true;
  }
  forget(addr: string): void {
    this.hits.delete(addr);
  }
}

/**
 * The runtime-neutral rendezvous core. One instance per relay process. Every
 * connection is represented by a `RelayConnection` returned from `accept`.
 */
export class RelayHub {
  private readonly daemons = new Map<RendezvousId, DaemonRegistration>();
  private readonly pipes = new Map<PipeId, PipeRecord>();
  private readonly limits: RelayServerLimits;
  private readonly logger: RelayServerLogger;
  private readonly rateLimiter: HandshakeRateLimiter;

  constructor(options: { limits?: Partial<RelayServerLimits>; logger?: RelayServerLogger } = {}) {
    this.limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
    this.logger = options.logger ?? SILENT_LOGGER;
    this.rateLimiter = new HandshakeRateLimiter(this.limits.maxHandshakesPerMinutePerAddr);
  }

  /** Current occupancy — surfaces/monitoring can read this. */
  stats(): { readonly daemons: number; readonly pipes: number } {
    return { daemons: this.daemons.size, pipes: this.pipes.size };
  }

  /** Maximum bytes allowed in a single forwarded data frame. */
  get maxMessageBytes(): number {
    return this.limits.maxMessageBytes;
  }

  /** Begin tracking a freshly-connected socket. */
  accept(socket: RelayServerSocket, remoteAddr: string): RelayConnection {
    return new RelayConnection(this, socket, remoteAddr);
  }

  // ── internal operations invoked by RelayConnection ──

  /** @internal */
  _rateOk(addr: string): boolean {
    return this.rateLimiter.allow(addr, Date.now());
  }

  /** @internal Register a daemon under a rendezvous id. Returns an error code or null on success. */
  _register(rid: RendezvousId, socket: RelayServerSocket): RelayErrorCode | null {
    if (this.daemons.has(rid)) return 'rid-taken';
    if (this.daemons.size >= this.limits.maxDaemons) return 'capacity';
    this.daemons.set(rid, { socket, pipes: new Set() });
    this.logger.info('relay daemon registered', { rid, daemons: this.daemons.size });
    return null;
  }

  /** @internal Open a client pipe to a registered daemon. */
  _openPipe(rid: RendezvousId, client: RelayServerSocket): { pipeId: PipeId; pipeIdBytes: Uint8Array<ArrayBuffer> } | RelayErrorCode {
    const daemon = this.daemons.get(rid);
    if (!daemon) return 'daemon-offline';
    if (this.pipes.size >= this.limits.maxPipes) return 'capacity';
    if (daemon.pipes.size >= this.limits.maxPipesPerDaemon) return 'capacity';
    const pipeIdBytes = randomBytes(RELAY_PIPE_ID_BYTES);
    const pipeId = toBase64Url(pipeIdBytes);
    this.pipes.set(pipeId, { rid, client, daemon: daemon.socket, pipeIdBytes });
    daemon.pipes.add(pipeId);
    daemon.socket.send(encodeControlFrame({ t: 'pipe-open', pipe: pipeId }));
    this.logger.info('relay pipe opened', { rid, pipe: pipeId, pipes: this.pipes.size });
    return { pipeId, pipeIdBytes };
  }

  /** @internal Forward an opaque payload from a client to its daemon (adds pipe prefix). */
  _clientToDaemon(pipeId: PipeId, payload: Uint8Array<ArrayBuffer>): boolean {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return false;
    pipe.daemon.send(framePipePayload(pipe.pipeIdBytes, payload));
    return true;
  }

  /** @internal Forward an opaque daemon frame ([pipeId][payload]) to the right client. */
  _daemonToClient(frame: Uint8Array<ArrayBuffer>): boolean {
    const split = unframePipePayload(frame);
    if (!split) return false;
    const pipeId = toBase64Url(split.pipeId.slice());
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return false;
    pipe.client.send(split.payload.slice());
    return true;
  }

  /** @internal Tear down a single pipe, notifying the surviving peer. */
  _closePipe(pipeId: PipeId, notify: 'client' | 'daemon' | 'both', reason?: string): void {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return;
    this.pipes.delete(pipeId);
    this.daemons.get(pipe.rid)?.pipes.delete(pipeId);
    const closeFrame = encodeControlFrame(reason !== undefined ? { t: 'pipe-close', pipe: pipeId, reason } : { t: 'pipe-close', pipe: pipeId });
    if (notify === 'client' || notify === 'both') pipe.client.send(closeFrame);
    if (notify === 'daemon' || notify === 'both') pipe.daemon.send(closeFrame);
  }

  /** @internal Remove a daemon registration and close all its pipes. */
  _unregister(rid: RendezvousId): void {
    const daemon = this.daemons.get(rid);
    if (!daemon) return;
    for (const pipeId of [...daemon.pipes]) {
      const pipe = this.pipes.get(pipeId);
      this.pipes.delete(pipeId);
      pipe?.client.send(encodeControlFrame({ t: 'pipe-close', pipe: pipeId, reason: 'daemon-disconnected' }));
      pipe?.client.close(1001, 'daemon-disconnected');
    }
    this.daemons.delete(rid);
    this.logger.info('relay daemon unregistered', { rid, daemons: this.daemons.size });
  }
}

/** Per-connection state machine. One instance per accepted socket. */
export class RelayConnection {
  private role: 'unknown' | 'daemon' | 'client' = 'unknown';
  private rid: RendezvousId | undefined;
  private pipeId: PipeId | undefined;

  constructor(
    private readonly hub: RelayHub,
    private readonly socket: RelayServerSocket,
    private readonly remoteAddr: string,
  ) {}

  /** Handle a text (control) frame from this socket. */
  handleText(text: string): void {
    const frame = decodeControlFrame(text);
    if (!frame) {
      this.fail('malformed', 'Unparseable control frame.');
      return;
    }
    if (frame.t === 'register' && this.role === 'unknown') {
      this.onRegister(frame.protocol, frame.rid);
      return;
    }
    if (frame.t === 'connect' && this.role === 'unknown') {
      this.onConnect(frame.protocol, frame.rid);
      return;
    }
    // Any other control frame from an endpoint is out of protocol.
    this.fail('malformed', `Unexpected control frame "${frame.t}" for role "${this.role}".`);
  }

  /** Handle a binary (data) frame from this socket. */
  handleBinary(bytes: Uint8Array<ArrayBuffer>): void {
    if (bytes.length > this.hub.maxMessageBytes) {
      this.fail('capacity', 'Data frame exceeds the relay message-size cap.');
      return;
    }
    if (this.role === 'client' && this.pipeId) {
      if (!this.hub._clientToDaemon(this.pipeId, bytes)) this.socket.close(1011, 'pipe-gone');
      return;
    }
    if (this.role === 'daemon') {
      if (!this.hub._daemonToClient(bytes)) {
        // Unknown/closed pipe — ignore silently (client may have just left).
      }
      return;
    }
    this.fail('malformed', 'Data frame before pairing.');
  }

  /** Handle socket closure. */
  handleClose(): void {
    if (this.role === 'daemon' && this.rid) {
      this.hub._unregister(this.rid);
    } else if (this.role === 'client' && this.pipeId) {
      this.hub._closePipe(this.pipeId, 'daemon', 'client-disconnected');
    }
  }

  private onRegister(protocol: number, rid: RendezvousId): void {
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      this.fail('protocol-version', `Relay speaks protocol ${RELAY_PROTOCOL_VERSION}.`);
      return;
    }
    if (!this.hub._rateOk(this.remoteAddr)) {
      this.fail('rate-limited', 'Too many handshake attempts.');
      return;
    }
    const err = this.hub._register(rid, this.socket);
    if (err) {
      this.fail(err, err === 'rid-taken' ? 'Rendezvous id already registered.' : 'Relay at capacity.');
      return;
    }
    this.role = 'daemon';
    this.rid = rid;
    this.socket.send(encodeControlFrame({ t: 'registered', rid }));
  }

  private onConnect(protocol: number, rid: RendezvousId): void {
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      this.fail('protocol-version', `Relay speaks protocol ${RELAY_PROTOCOL_VERSION}.`);
      return;
    }
    if (!this.hub._rateOk(this.remoteAddr)) {
      this.fail('rate-limited', 'Too many handshake attempts.');
      return;
    }
    const result = this.hub._openPipe(rid, this.socket);
    if (typeof result === 'string') {
      this.fail(result, result === 'daemon-offline' ? 'No daemon is registered for that rendezvous id.' : 'Relay at capacity.');
      return;
    }
    this.role = 'client';
    this.rid = rid;
    this.pipeId = result.pipeId;
    this.socket.send(encodeControlFrame({ t: 'connected', pipe: result.pipeId }));
  }

  private fail(code: RelayErrorCode, message: string): void {
    this.socket.send(errorFrame(code, message));
    this.socket.close(1008, code);
  }
}
