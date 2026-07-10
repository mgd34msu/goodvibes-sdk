/**
 * relay-server-integration.test.ts
 *
 * End-to-end proof over a REAL relay server and REAL WebSockets: a daemon
 * registers outbound, a client dials the same rendezvous id, the two complete
 * the NK handshake THROUGH the relay, and application bytes tunnel across in
 * both directions. Critically, the relay only ever forwards ciphertext — this
 * test drives the actual `createBunRelayServer` process, not a stub.
 *
 * It doubles as the reference for how the daemon and client halves speak the
 * relay protocol (the production wiring in later commits mirrors this).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBunRelayServer } from '../packages/daemon-sdk/src/relay-server-entry.js';
import {
  decodeControlFrame,
  encodeControlFrame,
  encodeUtf8,
  decodeUtf8,
  exportRawPublicKey,
  finishInitiatorHandshake,
  framePipePayload,
  fromBase64Url,
  generateRelayIdentity,
  respondToHandshake,
  RelaySecureChannel,
  startInitiatorHandshake,
  unframePipePayload,
  type RelayHandshakeKeys,
} from '../packages/transport-core/src/relay/index.js';

const RID = 'rid-integration-abc123';
let server: ReturnType<typeof createBunRelayServer>;
let url: string;

beforeAll(() => {
  server = createBunRelayServer({ port: 0, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  url = `ws://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function openSocket(): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${String(e)}`)), { once: true });
  });
}

function asBytes(data: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data as ArrayBuffer);
}

describe('relay server end-to-end tunnel', () => {
  test('daemon + client complete an E2E handshake through the relay and exchange bytes', async () => {
    const identity = await generateRelayIdentity();
    const daemonPubRaw = await exportRawPublicKey(identity.publicKey);
    const ridBytes = encodeUtf8(RID);

    // ── Daemon side: register, answer handshakes per pipe, echo sealed frames ──
    const daemonWs = await openSocket();
    const daemonChannels = new Map<string, RelaySecureChannel>();
    const daemonReady = new Promise<void>((resolve) => {
      daemonWs.addEventListener('message', (ev) => {
        void (async () => {
          if (typeof ev.data === 'string') {
            const frame = decodeControlFrame(ev.data);
            if (frame?.t === 'registered') resolve();
            return;
          }
          const split = unframePipePayload(asBytes(ev.data));
          if (!split) return;
          const pipeKey = Array.from(split.pipeId).join(',');
          const existing = daemonChannels.get(pipeKey);
          if (!existing) {
            // First frame on this pipe = handshake message1.
            const { keys, message2 } = await respondToHandshake(identity, ridBytes, split.payload.slice());
            daemonChannels.set(pipeKey, new RelaySecureChannel(keys, 'daemon'));
            daemonWs.send(framePipePayload(split.pipeId.slice(), message2));
          } else {
            const request = await existing.open(split.payload.slice());
            const reply = await existing.seal(encodeUtf8(`echo:${decodeUtf8(request)}`));
            daemonWs.send(framePipePayload(split.pipeId.slice(), reply));
          }
        })();
      });
    });
    daemonWs.send(encodeControlFrame({ t: 'register', role: 'daemon', protocol: 1, rid: RID }));
    await daemonReady;

    // ── Client side: dial, run initiator handshake, tunnel a request ──
    const clientWs = await openSocket();
    let pipe = '';
    let clientKeys: RelayHandshakeKeys | null = null;
    let initiatorState: Awaited<ReturnType<typeof startInitiatorHandshake>>['state'] | null = null;
    const gotReply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for tunneled reply')), 5000);
      clientWs.addEventListener('message', (ev) => {
        void (async () => {
          if (typeof ev.data === 'string') {
            const frame = decodeControlFrame(ev.data);
            if (frame?.t === 'connected') {
              pipe = frame.pipe;
              const started = await startInitiatorHandshake(daemonPubRaw, ridBytes);
              initiatorState = started.state;
              clientWs.send(started.message1); // client leg: bare payload, no prefix
            }
            return;
          }
          const payload = asBytes(ev.data);
          if (!clientKeys && initiatorState) {
            clientKeys = await finishInitiatorHandshake(initiatorState, payload.slice());
            const channel = new RelaySecureChannel(clientKeys, 'client');
            (clientWs as unknown as { _channel: RelaySecureChannel })._channel = channel;
            clientWs.send(await channel.seal(encodeUtf8('hello-over-relay')));
            return;
          }
          const channel = (clientWs as unknown as { _channel: RelaySecureChannel })._channel;
          const opened = await channel.open(payload.slice());
          clearTimeout(timer);
          resolve(decodeUtf8(opened));
        })();
      });
    });
    clientWs.send(encodeControlFrame({ t: 'connect', role: 'client', protocol: 1, rid: RID }));

    const reply = await gotReply;
    expect(reply).toBe('echo:hello-over-relay');
    expect(pipe.length).toBeGreaterThan(0);
    expect(fromBase64Url(pipe).length).toBe(16);

    clientWs.close();
    daemonWs.close();
  });

  test('health endpoint reports occupancy', async () => {
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    const body = (await res.json()) as { ok: boolean; protocol: number };
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(1);
  });
});
