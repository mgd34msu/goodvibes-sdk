/**
 * Coverage-gap smoke test, platform/runtime/network
 * Verifies inbound/outbound TLS inspection functions return correct observable shapes.
 * Closes coverage gap: platform/runtime/network
 */

import { describe, expect, test } from 'bun:test';
import {
  inspectInboundTls,
  resolveInboundTlsContext,
} from '../packages/sdk/src/platform/runtime/network/inbound.js';
import {
  applyOutboundTlsToFetchInit,
} from '../packages/sdk/src/platform/runtime/network/outbound.js';

/** Minimal config reader that returns undefined for all keys. */
function makeConfig() {
  return {
    get: (_path: string) => undefined,
    getControlPlaneConfigDir: () => '/tmp',
  };
}

describe('platform/runtime/network: behavior smoke', () => {
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
    // In 'off' mode no TLS credentials, tls is undefined
    expect(ctx.tls).toBeUndefined();
  });

  test('applyOutboundTlsToFetchInit preserves method in the returned init object', () => {
    const init = applyOutboundTlsToFetchInit('https://example.test/', { method: 'GET' }, makeConfig());
    expect((init as RequestInit).method).toBe('GET');
  });
});
