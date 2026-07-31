/**
 * cli-network-posture.test.ts — classifyBindPosture / isLoopbackHost /
 * isNetworkFacing.
 *
 * This is the honesty check behind every "Local only" vs "Local Network"
 * label a front-end prints next to an endpoint. Getting it wrong in the
 * reassuring direction is the failure that matters: a binding reachable from
 * the LAN must never be described as local. So the classification is
 * belt-and-braces — it trusts the stored hostMode, but also inspects the
 * resolved host, because a 'local' mode paired with 0.0.0.0 is a
 * misconfiguration, not a local bind.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyBindPosture,
  isLoopbackHost,
  isNetworkFacing,
} from '@pellux/goodvibes-terminal-shell';

describe('isLoopbackHost', () => {
  test('recognizes the named and numeric loopback forms', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
  });

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isLoopbackHost('  LOCALHOST ')).toBe(true);
    expect(isLoopbackHost('LocalHost')).toBe(true);
  });

  test('does not treat wildcard or routable addresses as loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('10.0.0.7')).toBe(false);
    expect(isLoopbackHost('example.lan')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('classifyBindPosture', () => {
  test("hostMode 'local' is local and not network-facing", () => {
    const posture = classifyBindPosture({ hostMode: 'local', host: '127.0.0.1' });
    expect(posture.kind).toBe('local');
    expect(posture.label).toBe('Local only');
    expect(posture.networkFacing).toBe(false);
  });

  test('a loopback host is local even when the stored mode says otherwise', () => {
    const posture = classifyBindPosture({ hostMode: 'network', host: 'localhost' });
    expect(posture.kind).toBe('local');
    expect(posture.networkFacing).toBe(false);
  });

  test("hostMode 'network' and the wildcard addresses are local-network", () => {
    for (const binding of [
      { hostMode: 'network', host: '192.168.1.20' },
      { hostMode: 'custom', host: '0.0.0.0' },
      { hostMode: 'custom', host: '::' },
    ] as const) {
      const posture = classifyBindPosture(binding);
      expect(posture.kind).toBe('local-network');
      expect(posture.label).toBe('Local Network');
      expect(posture.networkFacing).toBe(true);
    }
  });

  test('a routable non-wildcard host under a custom mode is custom-network', () => {
    const posture = classifyBindPosture({ hostMode: 'custom', host: 'gateway.example.com' });
    expect(posture.kind).toBe('custom-network');
    expect(posture.label).toBe('Custom network');
    expect(posture.networkFacing).toBe(true);
  });

  test('an unrecognized hostMode still classifies by host rather than throwing', () => {
    expect(classifyBindPosture({ hostMode: 'nonsense', host: '127.0.0.1' }).kind).toBe('local');
    expect(classifyBindPosture({ hostMode: 'nonsense', host: '10.0.0.7' }).kind).toBe('custom-network');
  });

  test('every posture agrees with its own networkFacing flag', () => {
    for (const binding of [
      { hostMode: 'local', host: '127.0.0.1' },
      { hostMode: 'network', host: '0.0.0.0' },
      { hostMode: 'custom', host: 'host.lan' },
    ] as const) {
      const posture = classifyBindPosture(binding);
      expect(posture.networkFacing).toBe(posture.kind !== 'local');
    }
  });
});

describe('isNetworkFacing', () => {
  test('a disabled endpoint is never network-facing, whatever it would bind to', () => {
    const wideOpen = { hostMode: 'network', host: '0.0.0.0' } as const;
    expect(isNetworkFacing(false, wideOpen)).toBe(false);
    expect(isNetworkFacing(undefined, wideOpen)).toBe(false);
    expect(isNetworkFacing(null, wideOpen)).toBe(false);
  });

  test('only a literal true counts as enabled — truthy values do not', () => {
    const wideOpen = { hostMode: 'network', host: '0.0.0.0' } as const;
    expect(isNetworkFacing(true, wideOpen)).toBe(true);
    expect(isNetworkFacing(1, wideOpen)).toBe(false);
    expect(isNetworkFacing('true', wideOpen)).toBe(false);
  });

  test('an enabled endpoint bound to loopback is not network-facing', () => {
    expect(isNetworkFacing(true, { hostMode: 'local', host: '127.0.0.1' })).toBe(false);
  });
});
