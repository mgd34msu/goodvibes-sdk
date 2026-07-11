// relay-registration.ts
//
// The daemon half of the relay path. It dials the relay OUTBOUND (so the daemon
// needs no inbound port or public IP), registers under its rendezvous id, and
// terminates the end-to-end secure channel INSIDE this process. Tunneled HTTP
// requests are decrypted here and replayed against the daemon's own route
// dispatcher, exactly as if they had arrived on the local HTTP listener — the
// relay only ever moved ciphertext.
//
// Reconnect uses the same capped exponential-backoff shape as the transport
// stream reconnector (base 500ms, ×2, cap 30s). The channel keys are per-pipe
// and ephemeral, so a reconnect simply re-registers and old pipes are dropped.

import {
  RELAY_PROTOCOL_VERSION,
  RelaySecureChannel,
  createRelayPairingPayload,
  decodeControlFrame,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  framePipePayload,
  relayIdentityPublicKeyBase64Url,
  respondToHandshake,
  toBase64Url,
  unframePipePayload,
  type RelayHandshakeKeys,
  type RelayKeyPair,
  type RelayPairingPayload,
} from '@pellux/goodvibes-transport-core/relay';

/** Structural client WebSocket the daemon uses to dial the relay. */
export interface RelayClientWebSocket {
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** Header set on every relay-tunneled request so downstream can tell it apart. */
export const RELAY_VIA_HEADER = 'x-goodvibes-via-relay';

/**
 * Whether a request arrived over the relay (vs the trusted LAN). Surfaces and
 * policy hooks use this to show connections as "via relay" and to apply
 * relay-specific controls such as WebAuthn step-up on mutating calls.
 */
export function isRelayTunneledRequest(req: Request): boolean {
  return req.headers.get(RELAY_VIA_HEADER) === '1';
}

/** Lifecycle status of the daemon's relay registration. */
export type RelayRegistrationStatus = 'idle' | 'connecting' | 'registered' | 'reconnecting' | 'stopped';

export interface RelayRegistrationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Options for {@link createRelayDaemonRegistration}. */
export interface RelayDaemonRegistrationOptions {
  /** The relay URL to dial (wss://…). */
  readonly relayUrl: string;
  /** The unguessable rendezvous id this daemon registers under. */
  readonly rid: string;
  /** The daemon's persistent relay identity key pair. */
  readonly identity: RelayKeyPair;
  /** Base URL used to resolve tunneled request paths into local Requests. */
  readonly localBaseUrl: string;
  /** Replay a reconstructed request against the daemon; returns null if unrouted. */
  readonly dispatch: (req: Request) => Promise<Response | null>;
  /** WebSocket constructor override (defaults to globalThis.WebSocket). */
  readonly webSocketImpl?: (url: string) => RelayClientWebSocket;
  /** Reconnect backoff base delay in ms (default 500). */
  readonly reconnectBaseDelayMs?: number;
  /** Reconnect backoff cap in ms (default 30000). */
  readonly reconnectMaxDelayMs?: number;
  /** Max concurrent event-subscription streams per pipe (default 8). */
  readonly maxStreamsPerPipe?: number;
  /** Bounded per-stream send buffer, in chunks; overflow drops-with-notice (default 256). */
  readonly streamBufferChunks?: number;
  readonly logger?: RelayRegistrationLogger;
  readonly onStatusChange?: (status: RelayRegistrationStatus) => void;
}

/** A running daemon-side relay registration. */
export interface RelayDaemonRegistration {
  start(): void;
  stop(): void;
  readonly status: RelayRegistrationStatus;
  /** Mint a pairing payload a surface can scan to reach this daemon. */
  mintPairing(label?: string): Promise<RelayPairingPayload>;
}

const SILENT: RelayRegistrationLogger = { info: () => {}, warn: () => {}, error: () => {} };

function defaultWebSocket(url: string): RelayClientWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => RelayClientWebSocket }).WebSocket;
  if (!Ctor) throw new Error('No WebSocket implementation available; provide options.webSocketImpl.');
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return null;
}

const DEFAULT_MAX_STREAMS_PER_PIPE = 8;
const DEFAULT_STREAM_BUFFER_CHUNKS = 256;

/**
 * The daemon-side pump for one event subscription: it seals event-source chunks
 * into `stream-data` frames and writes them to the relay socket, applying a
 * bounded buffer so a slow consumer can never make the daemon buffer without
 * limit. When the buffer is full a chunk is DROPPED and counted, and the next
 * successful flush emits a `stream-overflow` notice carrying the dropped count —
 * an honest gap signal, never a silent one. Clean close is explicit in both
 * directions (`stream-close`).
 */
class DaemonStreamPump {
  private readonly queue: Uint8Array<ArrayBuffer>[] = [];
  private dropped = 0;
  private seq = 0;
  private flushing = false;
  private closed = false;

  constructor(
    private readonly streamId: string,
    private readonly channel: RelaySecureChannel,
    private readonly pipeIdBytes: Uint8Array<ArrayBuffer>,
    private readonly ws: RelayClientWebSocket,
    private readonly bufferCap: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.closed) return;
    if (this.queue.length >= this.bufferCap) {
      this.dropped += 1;
      return;
    }
    this.queue.push(chunk);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const chunk = this.queue.shift()!;
        const frame = encodeTunnelFrame({ id: this.streamId, kind: 'stream-data', seq: this.seq++ }, chunk);
        this.ws.send(framePipePayload(this.pipeIdBytes, await this.channel.seal(frame)));
        if (this.dropped > 0 && !this.closed) {
          const dropped = this.dropped;
          this.dropped = 0;
          const notice = encodeTunnelFrame({ id: this.streamId, kind: 'stream-overflow', dropped }, new Uint8Array(0));
          this.ws.send(framePipePayload(this.pipeIdBytes, await this.channel.seal(notice)));
        }
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.flushing = false;
    }
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    try {
      const frame = encodeTunnelFrame({ id: this.streamId, kind: 'stream-close', ...(reason ? { reason } : {}) }, new Uint8Array(0));
      this.ws.send(framePipePayload(this.pipeIdBytes, await this.channel.seal(frame)));
    } catch (error) {
      this.onError(error);
    }
  }
}

interface DaemonStreamRecord {
  readonly pump: DaemonStreamPump;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export function createRelayDaemonRegistration(options: RelayDaemonRegistrationOptions): RelayDaemonRegistration {
  const logger = options.logger ?? SILENT;
  const makeSocket = options.webSocketImpl ?? defaultWebSocket;
  const ridBytes = encodeUtf8(options.rid);
  const baseDelay = options.reconnectBaseDelayMs ?? 500;
  const maxDelay = options.reconnectMaxDelayMs ?? 30_000;
  const maxStreamsPerPipe = options.maxStreamsPerPipe ?? DEFAULT_MAX_STREAMS_PER_PIPE;
  const streamBufferChunks = options.streamBufferChunks ?? DEFAULT_STREAM_BUFFER_CHUNKS;

  let status: RelayRegistrationStatus = 'idle';
  let socket: RelayClientWebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const channels = new Map<string, RelaySecureChannel>();
  // Per-pipe live event subscriptions: pipeKey -> (streamId -> record).
  const pipeStreams = new Map<string, Map<string, DaemonStreamRecord>>();

  function closePipeStreams(pipeKey: string): void {
    const streams = pipeStreams.get(pipeKey);
    if (!streams) return;
    for (const record of streams.values()) {
      record.reader?.cancel().catch(() => {});
      void record.pump.close('pipe-closed');
    }
    pipeStreams.delete(pipeKey);
  }

  function setStatus(next: RelayRegistrationStatus): void {
    status = next;
    options.onStatusChange?.(next);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    setStatus('reconnecting');
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    attempt += 1;
    reconnectTimer = setTimeout(openConnection, delay);
  }

  async function handleDaemonFrame(pipeIdBytes: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>, ws: RelayClientWebSocket): Promise<void> {
    const pipeKey = toBase64Url(pipeIdBytes);
    const existing = channels.get(pipeKey);
    if (!existing) {
      // First frame on a new pipe is the client's handshake initiation.
      const { keys, message2 } = await respondToHandshake(options.identity, ridBytes, payload);
      channels.set(pipeKey, new RelaySecureChannel(keys, 'daemon'));
      ws.send(framePipePayload(pipeIdBytes, message2));
      return;
    }
    await serveTunneledFrame(pipeKey, existing, pipeIdBytes, payload, ws);
  }

  async function serveTunneledFrame(
    pipeKey: string,
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    sealed: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    const framed = decodeTunnelFrame(await channel.open(sealed));
    if (!framed) return;
    const header = framed.header;
    if (header.kind === 'request') {
      await serveTunneledRequest(header, framed.body, channel, pipeIdBytes, ws);
      return;
    }
    if (header.kind === 'stream-open') {
      await openTunneledStream(pipeKey, header, channel, pipeIdBytes, ws);
      return;
    }
    if (header.kind === 'stream-close') {
      closeTunneledStream(pipeKey, header.id);
      return;
    }
    // Other kinds (response, stream-data, stream-overflow) are daemon → surface
    // only; a surface should never send them. Ignore rather than trust.
  }

  async function serveTunneledRequest(
    header: { id: string; method: string; path: string; headers: ReadonlyArray<readonly [string, string]> },
    body: Uint8Array<ArrayBuffer>,
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    const request = new Request(new URL(header.path, options.localBaseUrl), {
      method: header.method,
      headers: [...header.headers.map(([k, v]) => [k, v] as [string, string]), [RELAY_VIA_HEADER, '1']],
      ...(body.length > 0 ? { body } : {}),
    });
    let response: Response;
    try {
      response = (await options.dispatch(request)) ?? new Response('Not found', { status: 404 });
    } catch (err) {
      logger.error('relay dispatch failed', { error: String(err) });
      response = new Response('Internal error', { status: 500 });
    }
    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    const respHeaders: Array<[string, string]> = [];
    response.headers.forEach((value, key) => respHeaders.push([key, value]));
    const out = encodeTunnelFrame(
      { id: header.id, kind: 'response', status: response.status, headers: respHeaders },
      new Uint8Array(bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength)),
    );
    ws.send(framePipePayload(pipeIdBytes, await channel.seal(out)));
  }

  async function openTunneledStream(
    pipeKey: string,
    header: { id: string; method: string; path: string; headers: ReadonlyArray<readonly [string, string]> },
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    const streams = pipeStreams.get(pipeKey) ?? new Map<string, DaemonStreamRecord>();
    pipeStreams.set(pipeKey, streams);
    const pump = new DaemonStreamPump(header.id, channel, pipeIdBytes, ws, streamBufferChunks, (error) =>
      logger.error('relay stream send failed', { error: String(error) }),
    );
    // Per-pipe stream cap: refuse a new stream with an immediate close notice.
    if (streams.size >= maxStreamsPerPipe || streams.has(header.id)) {
      await pump.close('stream-limit');
      return;
    }
    const record: DaemonStreamRecord = { pump, reader: null };
    streams.set(header.id, record);

    const request = new Request(new URL(header.path, options.localBaseUrl), {
      method: header.method,
      headers: [...header.headers.map(([k, v]) => [k, v] as [string, string]), [RELAY_VIA_HEADER, '1']],
    });
    let response: Response | null;
    try {
      response = await options.dispatch(request);
    } catch (err) {
      logger.error('relay stream dispatch failed', { error: String(err) });
      response = null;
    }
    if (!response || !response.body) {
      streams.delete(header.id);
      await pump.close('no-stream');
      return;
    }
    const reader = response.body.getReader();
    record.reader = reader;
    // Pump loop: read the daemon's event source and forward chunks. The await on
    // each read applies natural backpressure to the source; the pump's bounded
    // buffer + overflow notice covers the send side.
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) pump.enqueue(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) as Uint8Array<ArrayBuffer>);
        }
        await pump.close('source-ended');
      } catch (err) {
        logger.warn('relay stream source error', { error: String(err) });
        await pump.close('source-error');
      } finally {
        streams.delete(header.id);
        if (streams.size === 0) pipeStreams.delete(pipeKey);
      }
    })();
  }

  function closeTunneledStream(pipeKey: string, streamId: string): void {
    const streams = pipeStreams.get(pipeKey);
    const record = streams?.get(streamId);
    if (!record) return;
    record.reader?.cancel().catch(() => {});
    void record.pump.close('client-unsubscribed');
    streams!.delete(streamId);
    if (streams!.size === 0) pipeStreams.delete(pipeKey);
  }

  function openConnection(): void {
    if (stopped) return;
    reconnectTimer = null;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    for (const pipeKey of [...pipeStreams.keys()]) closePipeStreams(pipeKey);
    channels.clear();
    let ws: RelayClientWebSocket;
    try {
      ws = makeSocket(options.relayUrl);
    } catch (err) {
      logger.error('relay socket construction failed', { error: String(err) });
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.addEventListener('open', () => {
      ws.send(encodeControlFrame({ t: 'register', role: 'daemon', protocol: RELAY_PROTOCOL_VERSION, rid: options.rid }));
    });
    ws.addEventListener('message', (event) => {
      const data = (event as { data: unknown }).data;
      void (async () => {
        try {
          if (typeof data === 'string') {
            const frame = decodeControlFrame(data);
            if (!frame) return;
            if (frame.t === 'registered') {
              attempt = 0;
              setStatus('registered');
              logger.info('relay registered', { rid: options.rid });
            } else if (frame.t === 'pipe-close') {
              channels.delete(frame.pipe);
              closePipeStreams(frame.pipe);
            } else if (frame.t === 'error') {
              logger.warn('relay error frame', { code: frame.code, message: frame.message });
            }
            return;
          }
          const bytes = toBytes(data);
          if (!bytes) return;
          const split = unframePipePayload(bytes);
          if (!split) return;
          await handleDaemonFrame(split.pipeId.slice(), split.payload.slice(), ws);
        } catch (err) {
          logger.error('relay frame handling failed', { error: String(err) });
        }
      })();
    });
    ws.addEventListener('close', () => {
      socket = null;
      if (!stopped) scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      logger.warn('relay websocket error', { rid: options.rid });
    });
  }

  return {
    start(): void {
      if (!stopped && status !== 'idle') return;
      stopped = false;
      attempt = 0;
      openConnection();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const pipeKey of [...pipeStreams.keys()]) closePipeStreams(pipeKey);
      channels.clear();
      try {
        socket?.close();
      } catch {
        // ignore
      }
      socket = null;
      setStatus('stopped');
    },
    get status(): RelayRegistrationStatus {
      return status;
    },
    async mintPairing(label?: string): Promise<RelayPairingPayload> {
      return createRelayPairingPayload({
        relayUrl: options.relayUrl,
        rid: options.rid,
        daemonPublicKey: await relayIdentityPublicKeyBase64Url(options.identity),
        ...(label !== undefined ? { label } : {}),
      });
    },
  };
}
