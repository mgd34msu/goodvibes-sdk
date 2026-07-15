/**
 * relay-registration-context-cap.test.ts
 *
 * Regression guard for the operator-token control-plane relay context leak: the
 * daemon-side relay registration must keep its retained per-pipe secure-channel
 * contexts and its concurrently in-flight tunneled-request contexts BOUNDED, no
 * matter how many pipes/requests are pumped at it. Each retained context pins a
 * request that carries the operator-token Authorization header, so an unbounded
 * backlog is exactly the ~100GB OOM the daemon suffered.
 *
 * The wire is mocked: we drive `createRelayDaemonRegistration` directly through a
 * fake RelayClientWebSocket and the real E2E handshake/seal primitives, so the
 * test is fast and deterministic (no real relay server, no real sockets).
 */
import { describe, expect, test } from 'bun:test';
import {
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
} from '../packages/daemon-sdk/src/index.js';
import {
  encodeTunnelFrame,
  exportRawPublicKey,
  encodeUtf8,
  finishInitiatorHandshake,
  framePipePayload,
  generateRelayIdentity,
  randomBytes,
  RelaySecureChannel,
  startInitiatorHandshake,
  toBase64Url,
  unframePipePayload,
  RELAY_PUBLIC_KEY_BYTES,
} from '../packages/transport-core/src/relay/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
// A daemon handshake message2 is exactly the daemon ephemeral public key plus a
// fixed-size AEAD confirmation tag; anything of that length routes to a pending
// handshake, everything else is a tunnel response.
const CONFIRM_TAG_BYTES = encodeUtf8('gv-relay-confirm').length + 16;
const HANDSHAKE_MESSAGE2_LEN = RELAY_PUBLIC_KEY_BYTES + CONFIRM_TAG_BYTES;

/** A mock daemon<->relay socket that lets the test inject frames and observe sends. */
class MockRelaySocket implements RelayClientWebSocket {
  binaryType = 'arraybuffer';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  /** pipeKey -> resolver awaiting that pipe's handshake message2 payload. */
  readonly pendingHandshakes = new Map<string, (payload: Uint8Array) => void>();
  /** Sealed tunnel responses the daemon sent back, in order. */
  readonly responses: { pipeKey: string; payload: Uint8Array }[] = [];

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === 'string') return; // control frames (register); ignored here
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    const split = unframePipePayload(new Uint8Array(bytes).slice() as Uint8Array<ArrayBuffer>);
    if (!split) return;
    const pipeKey = toBase64Url(split.pipeId.slice() as Uint8Array<ArrayBuffer>);
    const payload = split.payload.slice();
    const pending = this.pendingHandshakes.get(pipeKey);
    if (pending && payload.length === HANDSHAKE_MESSAGE2_LEN) {
      this.pendingHandshakes.delete(pipeKey);
      pending(payload);
      return;
    }
    this.responses.push({ pipeKey, payload });
  }

  close(): void {}

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  emitMessage(data: Uint8Array): void {
    for (const l of this.listeners.get('message') ?? []) l({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  }
}

async function daemonStaticPublicRaw(identity: Awaited<ReturnType<typeof generateRelayIdentity>>): Promise<Uint8Array<ArrayBuffer>> {
  return exportRawPublicKey(identity.publicKey);
}

/** Complete one client-side handshake against the mock daemon; returns the sealing channel. */
async function establishPipe(
  socket: MockRelaySocket,
  staticPubRaw: Uint8Array<ArrayBuffer>,
  ridBytes: Uint8Array<ArrayBuffer>,
): Promise<{ pipeId: Uint8Array<ArrayBuffer>; channel: RelaySecureChannel }> {
  const pipeId = randomBytes(16);
  const pipeKey = toBase64Url(pipeId);
  const { state, message1 } = await startInitiatorHandshake(staticPubRaw, ridBytes);
  const message2 = new Promise<Uint8Array>((resolve) => socket.pendingHandshakes.set(pipeKey, resolve));
  socket.emitMessage(framePipePayload(pipeId, message1));
  const keys = await finishInitiatorHandshake(state, (await message2).slice() as Uint8Array<ArrayBuffer>);
  return { pipeId, channel: new RelaySecureChannel(keys, 'client') };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('relay registration retained-context caps', () => {
  test('pipe cap bounds retained secure-channel contexts under thousands of pipes', async () => {
    const identity = await generateRelayIdentity();
    const staticPubRaw = await daemonStaticPublicRaw(identity);
    const rid = 'rid-pipe-cap';
    const ridBytes = encodeUtf8(rid);
    const socket = new MockRelaySocket();
    const maxPipes = 8;
    const reg = createRelayDaemonRegistration({
      relayUrl: 'ws://mock', rid, identity, localBaseUrl: 'http://daemon.local',
      dispatch: async () => new Response('ok'),
      webSocketImpl: () => socket, logger: silent, maxPipes,
    });
    reg.start();

    const totalPipes = 3000;
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < totalPipes; i++) {
      await establishPipe(socket, staticPubRaw, ridBytes);
    }
    await waitUntil(() => reg.stats().droppedPipes >= totalPipes - maxPipes);

    const stats = reg.stats();
    // Retained pipe contexts never exceed the cap, regardless of churn.
    expect(stats.pipes).toBeLessThanOrEqual(maxPipes);
    expect(stats.droppedPipes).toBe(totalPipes - maxPipes);

    // Heap-delta ceiling: 3000 pipes' worth of channel contexts must NOT be
    // retained. Tolerant bound (deterministic across runs) — the leak retained
    // ~206k contexts, so anything near the cap is orders of magnitude under this.
    const g = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
    if (g?.gc) {
      g.gc(true);
      const heapDelta = process.memoryUsage().heapUsed - heapBefore;
      expect(heapDelta).toBeLessThan(64 * 1024 * 1024);
    }
    reg.stop();
  });

  test('in-flight request cap refuses (never retains) beyond the ceiling', async () => {
    const identity = await generateRelayIdentity();
    const staticPubRaw = await daemonStaticPublicRaw(identity);
    const rid = 'rid-inflight-cap';
    const ridBytes = encodeUtf8(rid);
    const socket = new MockRelaySocket();
    const maxInFlightRequests = 4;

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let concurrentDispatch = 0;
    let peakConcurrentDispatch = 0;
    const reg = createRelayDaemonRegistration({
      relayUrl: 'ws://mock', rid, identity, localBaseUrl: 'http://daemon.local',
      dispatch: async () => {
        concurrentDispatch += 1;
        peakConcurrentDispatch = Math.max(peakConcurrentDispatch, concurrentDispatch);
        await gate;
        concurrentDispatch -= 1;
        return new Response('ok');
      },
      webSocketImpl: () => socket, logger: silent, maxInFlightRequests, maxPipes: 512,
    });
    reg.start();

    // Establish one channel per request (fresh counters — no ordering coupling).
    const total = 20;
    const channels: { pipeId: Uint8Array<ArrayBuffer>; channel: RelaySecureChannel }[] = [];
    for (let i = 0; i < total; i++) channels.push(await establishPipe(socket, staticPubRaw, ridBytes));

    // Burst all requests; each carries an operator-token Authorization header.
    for (let i = 0; i < total; i++) {
      const { pipeId, channel } = channels[i]!;
      const frame = encodeTunnelFrame(
        { id: `req-${i}`, kind: 'request', method: 'GET', path: '/api/approvals', headers: [['authorization', 'Bearer operator-token-xyz']] },
        new Uint8Array(0) as Uint8Array<ArrayBuffer>,
      );
      const sealed = await channel.seal(frame);
      socket.emitMessage(framePipePayload(pipeId, sealed));
    }

    // The first maxInFlight requests are retained (in dispatch); the rest are
    // refused with an honest 503 and NOT retained.
    await waitUntil(() => reg.stats().droppedRequests >= total - maxInFlightRequests);
    const busy = reg.stats();
    expect(busy.inFlightRequests).toBeLessThanOrEqual(maxInFlightRequests);
    expect(busy.droppedRequests).toBe(total - maxInFlightRequests);
    expect(peakConcurrentDispatch).toBeLessThanOrEqual(maxInFlightRequests);

    // Release the gate: every retained context drains back to zero.
    releaseGate();
    await waitUntil(() => reg.stats().inFlightRequests === 0);
    expect(reg.stats().inFlightRequests).toBe(0);
    reg.stop();
  });
});
