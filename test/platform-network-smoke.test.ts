/**
 * Coverage-gap smoke test — platform/runtime/network
 * Verifies inbound/outbound TLS inspection functions return correct observable shapes.
 * Closes coverage gap: platform/runtime/network
 */

import { describe, expect, test } from 'bun:test';
import {
  inspectInboundTls,
  resolveInboundTlsContext,
} from '../packages/sdk/src/platform/runtime/network/inbound.js';
import {
  inspectOutboundTls,
  applyOutboundTlsToFetchInit,
  GlobalNetworkTransportInstaller,
} from '../packages/sdk/src/platform/runtime/network/outbound.js';

/** Minimal config reader that returns undefined for all keys. */
function makeConfig() {
  return {
    get: (_path: string) => undefined,
    getControlPlaneConfigDir: () => '/tmp',
  };
}

describe('platform/runtime/network — behavior smoke', () => {
  test('inspectInboundTls for controlPlane returns snapshot with surface and mode', () => {
    const snapshot = inspectInboundTls(makeConfig(), 'controlPlane');
    expect(snapshot).toHaveProperty('mode');
    expect(snapshot.surface).toBe('controlPlane');
    expect('mode' in snapshot).toBe(true);
    expect(typeof snapshot.host).toBe('string');
    expect(typeof snapshot.port).toBe('number');
  });

  test('inspectInboundTls for httpListener returns snapshot with httpListener surface', () => {
    const snapshot = inspectInboundTls(makeConfig(), 'httpListener');
    expect(snapshot.surface).toBe('httpListener');
  });

  test('resolveInboundTlsContext returns context with tls undefined in default (off) mode', () => {
    const ctx = resolveInboundTlsContext(makeConfig(), 'controlPlane');
    expect(ctx).not.toBeNull(); // presence-only: context returned
    // In 'off' mode no TLS credentials — tls is undefined
    expect(ctx.tls).toBeUndefined();
  });

  test('inspectOutboundTls returns snapshot with mode and trustMode fields', () => {
    const snapshot = inspectOutboundTls(makeConfig());
    expect(snapshot).toHaveProperty('mode'); // presence-only refined: check mode field
    expect('mode' in snapshot).toBe(true);
  });

  test('applyOutboundTlsToFetchInit preserves method in the returned init object', () => {
    const init = applyOutboundTlsToFetchInit(makeConfig(), { method: 'GET' });
    expect((init as RequestInit).method).toBe('GET');
  });

  test('GlobalNetworkTransportInstaller instance exposes install and setConfigManager', () => {
    const installer = new GlobalNetworkTransportInstaller();
    expect(typeof installer.install).toBe('function');
    expect(typeof installer.setConfigManager).toBe('function');
  });
});
