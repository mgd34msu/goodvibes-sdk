/**
 * Coverage-gap smoke test — platform/runtime/network
 * Verifies that inbound and outbound TLS inspection modules load correctly.
 * Closes coverage gap: platform/runtime/network (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import {
  InboundTlsMode,
  InboundServerSurface,
  inspectInboundTls,
  resolveInboundTlsContext,
} from '../packages/sdk/src/platform/runtime/network/inbound.js';
import {
  OutboundTrustMode,
  inspectOutboundTls,
  applyOutboundTlsToFetchInit,
  createNetworkFetch,
  GlobalNetworkTransportInstaller,
} from '../packages/sdk/src/platform/runtime/network/outbound.js';

describe('platform/runtime/network — module load smoke', () => {
  test('inspectInboundTls is a function', () => {
    expect(typeof inspectInboundTls).toBe('function');
  });

  test('resolveInboundTlsContext is a function', () => {
    expect(typeof resolveInboundTlsContext).toBe('function');
  });

  test('inspectOutboundTls is a function', () => {
    expect(typeof inspectOutboundTls).toBe('function');
  });

  test('applyOutboundTlsToFetchInit is a function', () => {
    expect(typeof applyOutboundTlsToFetchInit).toBe('function');
  });

  test('createNetworkFetch is a function', () => {
    expect(typeof createNetworkFetch).toBe('function');
  });

  test('GlobalNetworkTransportInstaller is a constructor', () => {
    expect(typeof GlobalNetworkTransportInstaller).toBe('function');
  });

  test('GlobalNetworkTransportInstaller instance has install method', () => {
    const installer = new GlobalNetworkTransportInstaller();
    expect(typeof installer.install).toBe('function');
    expect(typeof installer.setConfigManager).toBe('function');
  });
});
