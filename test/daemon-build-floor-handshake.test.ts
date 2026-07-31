/**
 * daemon-build-floor-handshake.test.ts
 *
 * The client's half of the build-floor handshake. The daemon has published
 * `X-Goodvibes-Client-Floor` on /status for a while; this is the reverse — a
 * pure client declaring the oldest daemon build it can work against, checking
 * it once against the version /status already returns, and refusing with a
 * sentence that names both versions rather than letting the first missing verb
 * read as a broken feature.
 *
 * Version literals are fixed on purpose: these assertions must not move when
 * the product version does (test/version-decoupled discipline).
 */

import { describe, expect, test } from 'bun:test';
import {
  evaluateDaemonCompatibility,
  evaluateDaemonStatusCompatibility,
  readDaemonVersion,
} from '../packages/sdk/src/platform/control-plane/daemon-compatibility.ts';
import { evaluateClientCompatibility } from '../packages/sdk/src/platform/control-plane/client-compatibility.ts';

describe('readDaemonVersion — /status already answers this', () => {
  test('reads the version out of a /status body', () => {
    expect(readDaemonVersion({ status: 'running', version: '1.21.0' })).toBe('1.21.0');
    expect(readDaemonVersion({ status: 'running', version: '  1.21.0 ' })).toBe('1.21.0');
  });

  test('a body with no usable version yields undefined rather than a guess', () => {
    expect(readDaemonVersion({ status: 'running' })).toBeUndefined();
    expect(readDaemonVersion({ status: 'running', version: '' })).toBeUndefined();
    expect(readDaemonVersion({ status: 'running', version: 42 })).toBeUndefined();
    expect(readDaemonVersion(null)).toBeUndefined();
    expect(readDaemonVersion('running')).toBeUndefined();
    expect(readDaemonVersion([1, 2, 3])).toBeUndefined();
  });
});

describe('evaluateDaemonCompatibility', () => {
  test('a daemon at or above the floor is ok', () => {
    expect(evaluateDaemonCompatibility({ daemonVersion: '1.21.0', floor: '1.21.0' }).status).toBe('ok');
    expect(evaluateDaemonCompatibility({ daemonVersion: '1.22.3', floor: '1.21.0' }).status).toBe('ok');
    expect(evaluateDaemonCompatibility({ daemonVersion: '2.0.0', floor: '1.21.0' }).status).toBe('ok');
  });

  test('a daemon below the floor refuses, naming BOTH versions and the one action', () => {
    const verdict = evaluateDaemonCompatibility({ daemonVersion: '1.19.4', floor: '1.21.0' });
    expect(verdict.status).toBe('daemon-update-required');
    expect(verdict.message).toContain('1.19.4');
    expect(verdict.message).toContain('1.21.0');
    expect(verdict.message).toContain('update the daemon');
  });

  test('the peer is named when the client knows which daemon it is talking to', () => {
    const verdict = evaluateDaemonCompatibility({
      daemonVersion: '1.19.4',
      floor: '1.21.0',
      daemonLabel: 'http://192.168.1.20:3421',
    });
    expect(verdict.message).toContain('http://192.168.1.20:3421');
  });

  test('a version that cannot be read is unknown, NOT ok', () => {
    // The whole point of a floor: a build that cannot prove it carries a
    // required behavior is treated as one that does not.
    for (const daemonVersion of [undefined, '', 'nightly']) {
      const verdict = evaluateDaemonCompatibility({ daemonVersion, floor: '1.21.0' });
      expect(verdict.status).toBe('unknown');
      expect(verdict.message).toContain('1.21.0');
    }
  });

  test('a client that declares no floor is asking for nothing, so anything is ok', () => {
    expect(evaluateDaemonCompatibility({ daemonVersion: '0.1.0', floor: undefined }).status).toBe('ok');
    expect(evaluateDaemonCompatibility({ daemonVersion: undefined, floor: '  ' }).status).toBe('ok');
  });

  test('a release candidate counts as its release — the floor gates on behavior', () => {
    expect(evaluateDaemonCompatibility({ daemonVersion: '1.21.0-rc.1', floor: '1.21.0' }).status).toBe('ok');
  });
});

describe('evaluateDaemonStatusCompatibility — the shape a client attaching actually has', () => {
  test('takes the /status body straight from the liveness probe', () => {
    const verdict = evaluateDaemonStatusCompatibility(
      { status: 'running', version: '1.19.0' },
      '1.21.0',
      'daemon-a',
    );
    expect(verdict.status).toBe('daemon-update-required');
    expect(verdict.daemonVersion).toBe('1.19.0');
    expect(verdict.floor).toBe('1.21.0');
    expect(verdict.message).toContain('daemon-a');
  });

  test('a status body from a daemon too old to report a version is unknown', () => {
    expect(evaluateDaemonStatusCompatibility({ status: 'running' }, '1.21.0').status).toBe('unknown');
  });
});

describe('the two halves of the handshake are independent', () => {
  test('a client below the daemon floor and a daemon below the client floor are separate verdicts', () => {
    // Same pair of builds, judged in both directions: neither check answers the
    // other's question, which is why both exist.
    const clientSide = evaluateClientCompatibility({ clientVersion: '1.13.0', floor: '1.14.0' });
    const daemonSide = evaluateDaemonCompatibility({ daemonVersion: '1.13.0', floor: '1.21.0' });
    expect(clientSide.status).toBe('restart-required');
    expect(daemonSide.status).toBe('daemon-update-required');
    expect(clientSide.message).not.toBe(daemonSide.message);
  });
});
