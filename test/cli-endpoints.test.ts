/**
 * cli-endpoints.test.ts, resolveRuntimeEndpointBinding, formatRuntimeEndpointBinding,
 * and hostModeForHostname.
 *
 * The one thing that must never happen: a hostMode the daemon's own bind
 * resolver cannot handle (its switch has no default case, it throws before
 * binding) getting displayed as though it resolved to a real bind. That is
 * exactly what `recognized: false` and formatRuntimeEndpointBinding's warning
 * text exist to prevent.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  RUNTIME_ENDPOINT_DEFAULT_PORTS,
  formatRuntimeEndpointBinding,
  hostModeForHostname,
  resolveRuntimeEndpointBinding,
} from '@pellux/goodvibes-terminal-shell';

function fakeConfig(values: Record<string, unknown>): Pick<ConfigManager, 'get'> {
  return { get: ((key: string) => values[key]) as ConfigManager['get'] };
}

describe('hostModeForHostname', () => {
  test('0.0.0.0 and :: are network', () => {
    expect(hostModeForHostname('0.0.0.0')).toBe('network');
    expect(hostModeForHostname('::')).toBe('network');
  });

  test('127.0.0.1, localhost, and ::1 are local', () => {
    expect(hostModeForHostname('127.0.0.1')).toBe('local');
    expect(hostModeForHostname('localhost')).toBe('local');
    expect(hostModeForHostname('::1')).toBe('local');
    expect(hostModeForHostname('LOCALHOST')).toBe('local');
  });

  test('anything else is custom', () => {
    expect(hostModeForHostname('10.0.0.7')).toBe('custom');
    expect(hostModeForHostname('example.lan')).toBe('custom');
  });
});

describe('resolveRuntimeEndpointBinding', () => {
  test('network hostMode binds 0.0.0.0 at the configured port', () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.hostMode': 'network', 'controlPlane.host': '10.0.0.7', 'controlPlane.port': 4319 }),
      'controlPlane',
    );
    expect(binding).toEqual({
      hostMode: 'network', configuredHost: '10.0.0.7', host: '0.0.0.0', port: 4319, recognized: true,
    });
  });

  test('local hostMode always binds 127.0.0.1 regardless of configuredHost', () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.hostMode': 'local', 'controlPlane.host': '10.0.0.7' }),
      'controlPlane',
    );
    expect(binding.host).toBe('127.0.0.1');
    expect(binding.recognized).toBe(true);
    expect(binding.port).toBe(RUNTIME_ENDPOINT_DEFAULT_PORTS.controlPlane);
  });

  test('custom hostMode binds the configured host, falling back to loopback when blank', () => {
    const withHost = resolveRuntimeEndpointBinding(
      fakeConfig({ 'httpListener.hostMode': 'custom', 'httpListener.host': 'gateway.internal' }),
      'httpListener',
    );
    expect(withHost.host).toBe('gateway.internal');
    expect(withHost.recognized).toBe(true);

    const blankHost = resolveRuntimeEndpointBinding(
      fakeConfig({ 'httpListener.hostMode': 'custom', 'httpListener.host': '' }),
      'httpListener',
    );
    expect(blankHost.host).toBe('127.0.0.1');
  });

  test('an unrecognized hostMode reports recognized:false rather than asserting a definite bind', () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.hostMode': 'LAN', 'controlPlane.host': '10.0.0.7' }),
      'controlPlane',
    );
    expect(binding.recognized).toBe(false);
    expect(binding.hostMode).toBe('LAN');
  });

  test('a missing or non-numeric stored port falls back to the endpoint default', () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'httpListener.hostMode': 'local', 'httpListener.port': 0 }),
      'httpListener',
    );
    expect(binding.port).toBe(RUNTIME_ENDPOINT_DEFAULT_PORTS.httpListener);
  });

  test('the web endpoint resolves its port through the SDK resolveWebPort, not the raw stored value', () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'web.hostMode': 'local', 'web.port': 4568 }),
      'web',
    );
    expect(binding.port).toBe(4568);
  });
});

describe('formatRuntimeEndpointBinding', () => {
  test('a recognized binding renders "<mode> <host>:<port>"', () => {
    expect(formatRuntimeEndpointBinding({
      hostMode: 'network', configuredHost: '0.0.0.0', host: '0.0.0.0', port: 3421, recognized: true,
    })).toBe('network 0.0.0.0:3421');
  });

  test('an unrecognized binding names the mode and explains the daemon cannot bind it, never a fake host:port', () => {
    const text = formatRuntimeEndpointBinding({
      hostMode: 'LAN', configuredHost: '10.0.0.7', host: '127.0.0.1', port: 3421, recognized: false,
    });
    expect(text).toContain("'LAN'");
    expect(text).toContain('not a recognized host mode');
    expect(text).toContain('cannot bind this endpoint');
    // The fallback host:port must never be presented as though it were real.
    expect(text).not.toContain('127.0.0.1:3421');
  });
});
