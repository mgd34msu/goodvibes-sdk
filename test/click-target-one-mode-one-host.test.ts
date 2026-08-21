/**
 * One bind mode + one destination, one click-target host.
 *
 * Owner ruling: "if it is set to network, it should NOT be exposing local".
 * The effective bind decides the host and nothing else does, so a single run
 * cannot produce two different host forms, which is exactly what the owner
 * observed on the ntfy topic (`http://127.0.0.1:3421/...` and
 * `http://0.0.0.0:3421/...` inside one burst).
 *
 * `0.0.0.0` is never a click target in any mode: it is a bind address, not a
 * destination. That was verified fixed against a live daemon and is pinned
 * here so it cannot regress.
 *
 * SECOND RULING, from the same live run: the discriminator for whether a
 * loopback answer is acceptable at all is WHERE THE LINK IS GOING. A
 * loopback-only daemon was putting `127.0.0.1` in the `Click` header of a
 * notification that is read on a phone, a dead link every time. Off-host
 * destinations get the LAN address; local destinations may use loopback; a
 * loopback-only daemon has no off-host answer and omits the link.
 *
 * A wildcard bind serves loopback AND the LAN address simultaneously, so both
 * must keep working, which is why the destination, not the mode, chooses.
 */
import { describe, expect, test } from 'bun:test';
import {
  normalizeReachableBaseUrl,
  resolveClickTargetHost,
  resolveClickTargetMode,
  resolveReachableBaseUrl,
} from '../packages/sdk/src/platform/utils/reachable-base-url.ts';

const LAN_ADDRESS = '192.168.1.42';
const LAN = () => ({ eth0: [{ address: LAN_ADDRESS, family: 'IPv4', internal: false }] });
const NO_LAN = () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] });

/** Every base URL shape a config can hand the resolver in one run. */
const CANDIDATE_URLS = [
  'http://127.0.0.1:3421',
  'http://localhost:3421',
  'http://0.0.0.0:3421',
  'http://[::]:3421',
  'http://127.0.0.1:3423',
  'http://0.0.0.0:3423',
] as const;

function hostsProducedIn(bindHost: string, destination: 'off-host' | 'local' = 'off-host'): string[] {
  const hosts = new Set<string>();
  for (const candidate of CANDIDATE_URLS) {
    const normalized = normalizeReachableBaseUrl(candidate, destination, LAN, bindHost);
    if (normalized) hosts.add(new URL(normalized).hostname);
  }
  return [...hosts];
}

describe('click target: one mode, one host', () => {
  test('network mode produces the LAN address and only the LAN address', () => {
    for (const bindHost of ['0.0.0.0', '::', LAN_ADDRESS]) {
      expect(resolveClickTargetMode(bindHost)).toBe('network');
      expect(hostsProducedIn(bindHost)).toEqual([LAN_ADDRESS]);
    }
  });

  test('an off-host link never gets loopback', () => {
    expect(hostsProducedIn('0.0.0.0')).not.toContain('127.0.0.1');
    expect(normalizeReachableBaseUrl('http://127.0.0.1:3421', 'off-host', LAN, '0.0.0.0'))
      .toBe(`http://${LAN_ADDRESS}:3421`);
  });

  test('a local click still gets loopback, on either bind', () => {
    for (const bindHost of ['127.0.0.1', 'localhost', '::1']) {
      expect(resolveClickTargetMode(bindHost)).toBe('local');
      expect(hostsProducedIn(bindHost, 'local')).toEqual(['127.0.0.1']);
    }
    // A wildcard bind answers on loopback too, so a local link may use it.
    expect(hostsProducedIn('0.0.0.0', 'local')).toEqual(['127.0.0.1']);
  });

  test('a local click never gets a LAN address the daemon does not answer on', () => {
    expect(hostsProducedIn('127.0.0.1', 'local')).not.toContain(LAN_ADDRESS);
    expect(normalizeReachableBaseUrl('http://0.0.0.0:3421', 'local', LAN, '127.0.0.1'))
      .toBe('http://127.0.0.1:3421');
  });

  test('the wildcard is never a click target, in any mode or destination', () => {
    for (const destination of ['off-host', 'local'] as const) {
      for (const bindHost of ['0.0.0.0', '127.0.0.1', '::', 'localhost', LAN_ADDRESS]) {
        for (const host of hostsProducedIn(bindHost, destination)) {
          expect(['0.0.0.0', '::', '[::]']).not.toContain(host);
        }
      }
    }
  });

  test('network mode with no LAN address omits the link rather than inventing one', () => {
    expect(resolveClickTargetHost('network', 'off-host', NO_LAN)).toBeNull();
    expect(normalizeReachableBaseUrl('http://0.0.0.0:3421', 'off-host', NO_LAN, '0.0.0.0')).toBeNull();
    expect(normalizeReachableBaseUrl('http://127.0.0.1:3421', 'off-host', NO_LAN, '0.0.0.0')).toBeNull();
  });

  test('a declared destination is the operator\'s and passes through in both modes', () => {
    for (const bindHost of ['0.0.0.0', '127.0.0.1']) {
      for (const destination of ['off-host', 'local'] as const) {
        expect(normalizeReachableBaseUrl('https://gv.example.com/', destination, LAN, bindHost))
          .toBe('https://gv.example.com');
      }
    }
  });

  test('the full resolver agrees with the mode for each hostMode setting', () => {
    const networkReader = {
      get: (key: string) => key === 'controlPlane.hostMode'
        ? 'network'
        : key === 'controlPlane.host'
          ? '0.0.0.0'
          : 'http://127.0.0.1:3421',
    };
    expect(resolveReachableBaseUrl(networkReader, 'off-host', LAN)).toBe(`http://${LAN_ADDRESS}:3421`);

    const localReader = {
      get: (key: string) => key === 'controlPlane.hostMode'
        ? 'local'
        : key === 'controlPlane.host'
          ? '127.0.0.1'
          : 'http://0.0.0.0:3421',
    };
    expect(resolveReachableBaseUrl(localReader, 'local', LAN)).toBe('http://127.0.0.1:3421');
  });
});

describe('a local-only daemon fabricates no off-host link', () => {
  // The defect, observed live: a loopback-only daemon put 127.0.0.1 in the
  // Click header of a notification that is read on a phone.
  test('loopback-only bind + off-host destination has no answer', () => {
    expect(resolveClickTargetHost('local', 'off-host', LAN)).toBeNull();
    expect(hostsProducedIn('127.0.0.1', 'off-host')).toEqual([]);
    expect(normalizeReachableBaseUrl('http://127.0.0.1:3421', 'off-host', LAN, '127.0.0.1')).toBeNull();
  });

  test('the full resolver omits the link for a local-mode daemon', () => {
    const local = {
      get: (key: string) => key === 'controlPlane.hostMode'
        ? 'local'
        : key === 'controlPlane.host'
          ? '127.0.0.1'
          : 'http://127.0.0.1:3421',
    };
    expect(resolveReachableBaseUrl(local, 'off-host', LAN)).toBeUndefined();
    // ...and still answers for a click that happens on this machine.
    expect(resolveReachableBaseUrl(local, 'local', LAN)).toBe('http://127.0.0.1:3421');
  });

  test('a declared external address still works for a local-mode daemon', () => {
    const tunnelled = {
      get: (key: string) => key === 'controlPlane.hostMode'
        ? 'local'
        : key === 'controlPlane.host'
          ? '127.0.0.1'
          : 'https://gv.example.com',
    };
    expect(resolveReachableBaseUrl(tunnelled, 'off-host', LAN)).toBe('https://gv.example.com');
  });
});
