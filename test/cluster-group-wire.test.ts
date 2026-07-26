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
