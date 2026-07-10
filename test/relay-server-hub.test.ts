/**
 * relay-server-hub.test.ts
 *
 * Behavioral tests for the runtime-neutral RelayHub — the rendezvous core of the
 * self-hostable relay. A pair of in-memory fake sockets stands in for real
 * WebSockets so the pairing, opaque forwarding, caps, and lifecycle can be
 * exercised deterministically without a network. The hub must never inspect the
 * payloads it forwards; these tests assert it forwards them byte-for-byte and
 * only ever adds/strips the pipe-routing prefix.
 */
import { describe, expect, test } from 'bun:test';
import {
  RelayHub,
  type RelayServerSocket,
} from '../packages/daemon-sdk/src/relay-server.js';
import {
  decodeControlFrame,
  encodeControlFrame,
  fromBase64Url,
  framePipePayload,
  toBase64Url,
  unframePipePayload,
  type RelayControlFrame,
} from '../packages/transport-core/src/relay/index.js';

class FakeSocket implements RelayServerSocket {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array<ArrayBuffer>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.texts.push(data);
    else this.binaries.push(new Uint8Array(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  lastControl(): RelayControlFrame | null {
    const last = this.texts.at(-1);
    return last ? decodeControlFrame(last) : null;
  }
}

function registerDaemon(hub: RelayHub, rid: string) {
  const sock = new FakeSocket();
  const conn = hub.accept(sock, '10.0.0.1');
  conn.handleText(encodeControlFrame({ t: 'register', role: 'daemon', protocol: 1, rid }));
  return { sock, conn };
}

function connectClient(hub: RelayHub, rid: string, addr = '10.0.0.2') {
  const sock = new FakeSocket();
  const conn = hub.accept(sock, addr);
  conn.handleText(encodeControlFrame({ t: 'connect', role: 'client', protocol: 1, rid }));
  return { sock, conn };
}

describe('RelayHub pairing + opaque forwarding', () => {
  test('daemon registers and a client pairs, opening a pipe both sides see', () => {
    const hub = new RelayHub();
    const daemon = registerDaemon(hub, 'rid-1');
    expect(daemon.sock.lastControl()).toEqual({ t: 'registered', rid: 'rid-1' });

    const client = connectClient(hub, 'rid-1');
    const clientFrame = client.sock.lastControl();
    expect(clientFrame?.t).toBe('connected');
    const pipe = clientFrame?.t === 'connected' ? clientFrame.pipe : '';
    expect(daemon.sock.lastControl()).toEqual({ t: 'pipe-open', pipe });
    expect(hub.stats()).toEqual({ daemons: 1, pipes: 1 });
  });

  test('forwards client bytes to the daemon with a pipe prefix, and back', () => {
    const hub = new RelayHub();
    const daemon = registerDaemon(hub, 'rid-2');
    const client = connectClient(hub, 'rid-2');
    const connected = client.sock.lastControl();
    const pipe = connected?.t === 'connected' ? connected.pipe : '';
    const pipeBytes = fromBase64Url(pipe);

    // client -> daemon: hub prepends the pipe id, payload is untouched.
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    client.conn.handleBinary(payload);
    const forwarded = daemon.sock.binaries.at(-1)!;
    const split = unframePipePayload(forwarded)!;
    expect(toBase64Url(split.pipeId.slice())).toBe(pipe);
    expect(Array.from(split.payload)).toEqual([9, 8, 7, 6, 5]);

    // daemon -> client: hub strips the pipe id, client sees the bare payload.
    const reply = new Uint8Array([1, 2, 3]);
    daemon.conn.handleBinary(framePipePayload(pipeBytes, reply));
    expect(Array.from(client.sock.binaries.at(-1)!)).toEqual([1, 2, 3]);
  });
});

describe('RelayHub honest failure + caps', () => {
  test('dialing an unregistered rendezvous id returns daemon-offline and closes', () => {
    const hub = new RelayHub();
    const client = connectClient(hub, 'nope');
    const frame = client.sock.lastControl();
    expect(frame).toMatchObject({ t: 'error', code: 'daemon-offline' });
    expect(client.sock.closed).not.toBeNull();
  });

  test('a second daemon claiming a taken rendezvous id is rejected', () => {
    const hub = new RelayHub();
    registerDaemon(hub, 'dup');
    const second = registerDaemon(hub, 'dup');
    expect(second.sock.lastControl()).toMatchObject({ t: 'error', code: 'rid-taken' });
  });

  test('protocol-version mismatch is rejected', () => {
    const hub = new RelayHub();
    const sock = new FakeSocket();
    const conn = hub.accept(sock, 'a');
    conn.handleText(encodeControlFrame({ t: 'register', role: 'daemon', protocol: 999, rid: 'x' }));
    expect(sock.lastControl()).toMatchObject({ t: 'error', code: 'protocol-version' });
  });

  test('per-daemon pipe cap trips capacity', () => {
    const hub = new RelayHub({ limits: { maxPipesPerDaemon: 1 } });
    registerDaemon(hub, 'cap');
    connectClient(hub, 'cap');
    const overflow = connectClient(hub, 'cap');
    expect(overflow.sock.lastControl()).toMatchObject({ t: 'error', code: 'capacity' });
  });

  test('oversized data frame is rejected', () => {
    const hub = new RelayHub({ limits: { maxMessageBytes: 8 } });
    registerDaemon(hub, 'big');
    const client = connectClient(hub, 'big');
    client.conn.handleBinary(new Uint8Array(9));
    expect(client.sock.lastControl()).toMatchObject({ t: 'error', code: 'capacity' });
  });

  test('handshake rate limit trips after the configured budget', () => {
    const hub = new RelayHub({ limits: { maxHandshakesPerMinutePerAddr: 2 } });
    registerDaemon(hub, 'r');
    // same address dials repeatedly
    connectClient(hub, 'r', 'spammer'); // 1
    const third = connectClient(hub, 'r', 'spammer'); // 2 (register used 0 for this addr; this is 2nd client)
    // The daemon registered from a different addr, so 'spammer' has 2 connects.
    const fourth = connectClient(hub, 'r', 'spammer');
    expect(fourth.sock.lastControl()).toMatchObject({ t: 'error', code: 'rate-limited' });
    expect(third.sock.lastControl()?.t).toBe('connected');
  });
});

describe('RelayHub lifecycle cleanup', () => {
  test('client disconnect notifies the daemon and frees the pipe', () => {
    const hub = new RelayHub();
    const daemon = registerDaemon(hub, 'life');
    const client = connectClient(hub, 'life');
    client.conn.handleClose();
    expect(daemon.sock.lastControl()?.t).toBe('pipe-close');
    expect(hub.stats().pipes).toBe(0);
  });

  test('daemon disconnect closes its clients and clears registration', () => {
    const hub = new RelayHub();
    const daemon = registerDaemon(hub, 'gone');
    const client = connectClient(hub, 'gone');
    daemon.conn.handleClose();
    expect(client.sock.lastControl()).toMatchObject({ t: 'pipe-close', reason: 'daemon-disconnected' });
    expect(client.sock.closed).not.toBeNull();
    expect(hub.stats()).toEqual({ daemons: 0, pipes: 0 });
  });
});
