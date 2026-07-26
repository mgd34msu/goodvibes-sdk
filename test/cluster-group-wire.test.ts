/**
 * cluster-group-wire.test.ts — the envelope, and the no-group state.
 *
 * The envelope is the one shape every node on the network speaks, so its field
 * set is asserted literally: a field quietly added or renamed is a datagram
 * that a peer on the previous build silently drops.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalizeEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BYTES,
  peekEnvelope,
  signEnvelope,
  type ClusterKeyring,
} from '../packages/sdk/src/platform/cluster/protocol-envelope.js';
import { GroupWireRouter } from '../packages/sdk/src/platform/cluster/group-transport.js';
import { digestSurfaceId } from '../packages/sdk/src/platform/cluster/group-crypto.js';
import { surfaceIdFor } from '../packages/sdk/src/platform/cluster/surface-id.js';
import { decodeMessage, encodeMessage } from '../packages/sdk/src/platform/cluster/protocol.js';
import { CLUSTER_PROTOCOL_VERSION } from '../packages/sdk/src/platform/cluster/types.js';
import type { ClusterLogger, ClusterTransport } from '../packages/sdk/src/platform/cluster/types.js';

function keyring(overrides: Partial<ClusterKeyring> = {}): ClusterKeyring {
  return {
    groupId: 'gTESTTESTTESTTEST',
    currentGeneration: 2,
    keyForGeneration: (generation) => (generation === 2 || generation === 1 ? `key-${generation}` : null),
    acceptedGenerations: () => [2, 1],
    ...overrides,
  };
}

const EMPTY_KEYRING: ClusterKeyring = {
  groupId: '',
  currentGeneration: 0,
  keyForGeneration: () => null,
  acceptedGenerations: () => [],
};

describe('the envelope', () => {
  test('carries exactly the agreed fields, and nothing else', () => {
    const raw = encodeEnvelope(
      { type: 'HEARTBEAT', nodeId: 'n1', nodeVersion: '1.2.3', seq: 7, ts: 1_700_000, body: { uptimeMs: 5 } },
      keyring(),
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'body', 'groupId', 'keyGen', 'nodeId', 'nodeVersion', 'seq', 'sig', 'surfaceId', 'ts', 'type', 'v',
    ]);
    expect(parsed['v']).toBe(1);
    expect(parsed['keyGen']).toBe(2);
    expect(parsed['surfaceId']).toBeNull();
  });

  test('the signature covers every field, so tampering with any of them is caught', () => {
    const raw = encodeEnvelope(
      { type: 'CLAIM', nodeId: 'n1', nodeVersion: '1.0.0', seq: 1, ts: 10, body: { uptimeMs: 1 } },
      keyring(),
    );
    const ring = keyring();
    expect(decodeEnvelope(raw, ring).envelope).not.toBeNull();

    for (const field of ['type', 'nodeId', 'nodeVersion', 'seq', 'ts', 'surfaceId', 'keyGen']) {
      const tampered = JSON.parse(raw) as Record<string, unknown>;
      tampered[field] = typeof tampered[field] === 'number' ? (tampered[field] as number) + 1 : 'CHANGED';
      const result = decodeEnvelope(JSON.stringify(tampered), ring);
      expect(result.envelope).toBeNull();
      // keyGen changes which key is expected, so it fails at a different gate —
      // both are refusals, which is the property under test.
      expect(['signature-did-not-verify', 'generation-not-accepted', 'malformed-field'])
        .toContain(result.rejected);
    }
    const bodyTampered = JSON.parse(raw) as Record<string, unknown>;
    bodyTampered['body'] = { uptimeMs: 999 };
    expect(decodeEnvelope(JSON.stringify(bodyTampered), keyring()).rejected).toBe('signature-did-not-verify');
  });

  test('the canonical form does not depend on the order the object was built in', () => {
    const a = { v: 1, groupId: 'g', keyGen: 1, surfaceId: null, type: 'PROBE', nodeId: 'n',
      nodeVersion: '1', seq: 1, ts: 2, body: { a: 1, b: { c: 2, d: 3 } } } as const;
    const b = { ts: 2, seq: 1, nodeVersion: '1', nodeId: 'n', type: 'PROBE', surfaceId: null,
      keyGen: 1, groupId: 'g', v: 1, body: { b: { d: 3, c: 2 }, a: 1 } } as const;
    expect(canonicalizeEnvelope(a)).toBe(canonicalizeEnvelope(b));
    expect(signEnvelope(a, 'k')).toBe(signEnvelope(b, 'k'));
  });

  test('a datagram from another group is refused before any signature work', () => {
    const foreign = encodeEnvelope(
      { type: 'BEACON', nodeId: 'n2', nodeVersion: '1.0.0', seq: 1, ts: 1, body: { displayName: 'theirs' } },
      keyring({ groupId: 'gOTHEROTHEROTHER0' }),
    );
    const result = decodeEnvelope(foreign, keyring());
    expect(result.envelope).toBeNull();
    expect(result.rejected).toBe('other-group');
    // Still readable as an advertisement, which is how discovery works.
    expect(result.claimedGroupId).toBe('gOTHEROTHEROTHER0');
    expect(peekEnvelope(foreign)?.body['displayName']).toBe('theirs');
  });

  test('an oversized or malformed datagram is refused rather than parsed', () => {
    expect(decodeEnvelope('x'.repeat(MAX_ENVELOPE_BYTES + 1), keyring()).rejected).toBe('oversized');
    expect(decodeEnvelope('not json', keyring()).rejected).toBe('not-json');
    expect(decodeEnvelope('[1,2,3]', keyring()).rejected).toBe('not-an-object');
    expect(decodeEnvelope(JSON.stringify({ v: 99, groupId: 'gTESTTESTTESTTEST' }), keyring()).rejected)
      .toBe('unsupported-version');
  });

  test('a surface identity on the wire is a digest, never a name', () => {
    const digest = digestSurfaceId('ntfy://mikes-private-inbox', 'gTESTTESTTESTTEST');
    expect(digest).toMatch(/^s[0-9a-f]{32}$/);
    expect(digest).not.toContain('mikes');
    // Already-digested values pass through untouched rather than being hashed twice.
    expect(digestSurfaceId(digest, 'gTESTTESTTESTTEST')).toBe(digest);
  });

  test('a surface id from the election layer passes through unhashed', () => {
    // The per-surface election derives its own ids in surface-id.ts — bare hex,
    // no prefix. Re-hashing one here would produce a value the far side cannot
    // route and would break the election's own signature, which covers
    // surfaceId. This pass-through is what makes the two layers agree.
    const electionId = surfaceIdFor({ kind: 'ntfy', discriminator: 'mikes-private-inbox' });
    expect(electionId).toMatch(/^[0-9a-f]{32}$/);
    expect(digestSurfaceId(electionId, 'gTESTTESTTESTTEST')).toBe(electionId);
  });

  test('an envelope refuses a surfaceId that is not a digest', () => {
    // A plaintext topic carried as a surface id is the one thing the whole
    // surface-id design exists to prevent, so it is refused at the edge rather
    // than routed on.
    const ring = keyring();
    const forged = JSON.stringify({
      v: 1,
      groupId: ring.groupId,
      keyGen: 2,
      surfaceId: 'ntfy://mikes-private-inbox',
      type: 'CLAIM',
      nodeId: 'n1',
      nodeVersion: '1.0.0',
      seq: 1,
      ts: 10,
      body: {},
      sig: 'whatever',
    });
    expect(decodeEnvelope(forged, ring).rejected).toBe('malformed-field');
  });
});

describe('the merged wire format — group fields and surface fields together', () => {
  /** A router over an in-memory socket, with the far side wired back to itself. */
  function loopback(): {
    readonly router: GroupWireRouter;
    readonly sent: string[];
    readonly delivered: string[];
    readonly transport: ClusterTransport;
  } {
    const sent: string[] = [];
    const delivered: string[] = [];
    const inner: ClusterTransport = {
      start: async () => {},
      send: async (raw) => { sent.push(raw); },
      stop: async () => {},
      describe: () => ({ mode: 'in-memory', group: 'memory', port: 0, peers: [] }),
    };
    const router = new GroupWireRouter({
      inner,
      keyring: keyring(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      now: () => 999_999,
      onGroupMessage: () => {},
      onOutOfBandMessage: () => {},
      onForeignBeacon: () => {},
    });
    return { router, sent, delivered, transport: router.electionTransport('1.2.3') };
  }

  /** The election's own datagram, exactly as protocol.ts encodes it. */
  function electionDatagram(secret: string): { raw: string; surfaceId: string } {
    const surfaceId = surfaceIdFor({ kind: 'ntfy', discriminator: 'mikes-private-inbox' });
    const message = {
      v: CLUSTER_PROTOCOL_VERSION,
      type: 'HEARTBEAT' as const,
      surfaceId,
      nodeId: 'node-a',
      nodeVersion: '1.2.3',
      seq: 11,
      ts: 1_700_000_000,
    };
    return { raw: encodeMessage(message, secret), surfaceId };
  }

  test('one datagram carries groupId, keyGen AND surfaceId under one signature', async () => {
    const rig = loopback();
    await rig.transport.start(() => {});
    const { surfaceId } = electionDatagram('');
    await rig.transport.send(electionDatagram('').raw);

    expect(rig.sent).toHaveLength(1);
    const parsed = JSON.parse(rig.sent[0]!) as Record<string, unknown>;
    // Both halves of the merge are present on the object.
    expect(parsed['groupId']).toBe('gTESTTESTTESTTEST');
    expect(parsed['keyGen']).toBe(2);
    expect(parsed['surfaceId']).toBe(surfaceId);
    // And all three are inside the signed form, so none can be rewritten in
    // flight to redirect a claim at a different surface or a different group.
    const canonical = canonicalizeEnvelope({
      v: 1,
      groupId: 'gTESTTESTTESTTEST',
      keyGen: 2,
      surfaceId,
      type: 'HEARTBEAT',
      nodeId: 'node-a',
      nodeVersion: '1.2.3',
      seq: 11,
      ts: 1_700_000_000,
      body: parsed['body'] as Record<string, unknown>,
    });
    expect(canonical).toContain('gTESTTESTTESTTEST');
    expect(canonical).toContain(surfaceId);
    expect(parsed['sig']).toBe(signEnvelope(JSON.parse(rig.sent[0]!) as never, 'key-2'));
  });

  test('the election gets back the exact message it sent', async () => {
    const rig = loopback();
    const received: string[] = [];
    await rig.transport.start((raw) => received.push(raw));
    const { raw } = electionDatagram('');
    await rig.transport.send(raw);

    // Feed the wrapped datagram back in, as a peer would receive it.
    (rig.router as unknown as { receive(raw: string): void }).receive(rig.sent[0]!);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual(JSON.parse(raw) as Record<string, unknown>);
  });

  test("the election's own signature still verifies after the round trip", async () => {
    // When cluster.secret is ALSO set, the election re-checks its own HMAC over
    // [v, type, surfaceId, nodeId, nodeVersion, seq, ts]. Any lifted field that
    // came back renamed or altered would fail every single datagram.
    const secret = 'a-shared-secret';
    const rig = loopback();
    const received: string[] = [];
    await rig.transport.start((raw) => received.push(raw));
    const { raw, surfaceId } = electionDatagram(secret);
    await rig.transport.send(raw);
    (rig.router as unknown as { receive(raw: string): void }).receive(rig.sent[0]!);

    expect(received).toHaveLength(1);
    const decoded = decodeMessage(received[0]!, secret);
    expect(decoded.rejected).toBeNull();
    expect(decoded.message?.surfaceId).toBe(surfaceId);
    expect(decoded.message?.nodeVersion).toBe('1.2.3');
    expect(decoded.message?.seq).toBe(11);
    expect(decoded.message?.ts).toBe(1_700_000_000);
  });
});

describe('a machine that is in no group', () => {
  function collectingLogger(): { logger: ClusterLogger; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      logger: {
        debug: () => {},
        info: (message) => lines.push(`info:${message}`),
        warn: (message) => lines.push(`warn:${message}`),
        error: (message) => lines.push(`error:${message}`),
      },
    };
  }

  test('sends no election traffic, and says why exactly once', async () => {
    const sent: string[] = [];
    const inner: ClusterTransport = {
      start: async () => {},
      send: async (raw) => { sent.push(raw); },
      stop: async () => {},
      describe: () => ({ mode: 'in-memory', group: 'memory', port: 0, peers: [] }),
    };
    const { logger, lines } = collectingLogger();
    const router = new GroupWireRouter({
      inner,
      keyring: EMPTY_KEYRING,
      logger,
      now: () => 1_000,
      onGroupMessage: () => {},
      onOutOfBandMessage: () => {},
      onForeignBeacon: () => {},
    });
    const transport = router.electionTransport('1.0.0');
    await transport.start(() => {});

    // The election heartbeats forever; every one of them is dropped.
    for (let index = 0; index < 25; index += 1) {
      await transport.send(JSON.stringify({ type: 'HEARTBEAT', nodeId: 'n1', version: '1.0.0', uptimeMs: index, seq: index }));
    }

    expect(sent).toHaveLength(0);
    expect(router.counters.droppedNoGroup).toBe(25);
    expect(router.counters.sent).toBe(0);
    // One line, not twenty-five. The first live run of this produced a warning
    // per datagram every two seconds, which buried the machine's log.
    const notices = lines.filter((line) => line.includes('not in a group'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith('info:');
    expect(lines.filter((line) => line.startsWith('warn:'))).toHaveLength(0);
  });
});
