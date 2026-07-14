/**
 * lan-http-posture.test.ts
 *
 * The LAN plain-http posture, end to end across its seams:
 *  - the transport accepts private-network http origins (RFC 1918, .local,
 *    localhost) with NO env escape hatch — including in a browser-like runtime
 *    where process.env does not exist — while genuinely public http origins
 *    keep the SDK_TRANSPORT_INSECURE_BASE_URL wall;
 *  - the origin posture labels browser-gated capability gaps ("needs https —
 *    available via tailscale") instead of leaving dead buttons, keeps all
 *    three on localhost, and states the one honest LAN notice line;
 *  - the pairing hand-off carries that posture so surfaces render it at
 *    pairing, once, never as a nag.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTransportPaths, isPrivateNetworkHost, normalizeBaseUrl } from '../packages/transport-http/src/paths.ts';
import { describeOriginPosture, LAN_PLAIN_HTTP_NOTICE } from '../packages/sdk/src/platform/pairing/origin-posture.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerPairingHandoffGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/pairing-handoff.ts';

describe('transport: private-network http origins are a supported posture', () => {
  test('RFC 1918 / .local / localhost http origins normalize without throwing', () => {
    for (const origin of [
      'http://10.0.0.7:3421',
      'http://172.16.4.2:3421',
      'http://172.31.255.9:3421',
      'http://192.168.1.50:3421',
      'http://mybox.local:3421',
      'http://localhost:3421',
      'http://127.0.0.1:3421',
      'http://[::1]:3421',
      'ws://192.168.1.50:3421',
    ]) {
      expect(normalizeBaseUrl(origin)).toBe(origin);
    }
  });

  test('a genuinely public http origin keeps the wall (SDK_TRANSPORT_INSECURE_BASE_URL)', () => {
    for (const origin of ['http://example.com', 'http://8.8.8.8:3421', 'http://172.15.0.1:3421', 'http://172.32.0.1:3421']) {
      expect(() => normalizeBaseUrl(origin)).toThrow(/insecure PUBLIC/i);
    }
  });

  test('works in a browser-like runtime: no process.env, LAN origin still accepted', () => {
    // Simulate a served browser bundle where globalThis.process does not exist.
    const g = globalThis as { process?: unknown };
    const realProcess = g.process;
    try {
      delete g.process;
      expect(normalizeBaseUrl('http://192.168.1.50:3421')).toBe('http://192.168.1.50:3421');
      expect(createTransportPaths('http://192.168.1.50:3421').statusUrl).toBe('http://192.168.1.50:3421/status');
      // The public wall still holds without an env hatch available.
      expect(() => normalizeBaseUrl('http://example.com')).toThrow();
    } finally {
      g.process = realProcess;
    }
  });

  test('isPrivateNetworkHost draws the boundary exactly', () => {
    expect(isPrivateNetworkHost('10.1.2.3')).toBe(true);
    expect(isPrivateNetworkHost('172.16.0.1')).toBe(true);
    expect(isPrivateNetworkHost('172.31.9.9')).toBe(true);
    expect(isPrivateNetworkHost('192.168.0.10')).toBe(true);
    expect(isPrivateNetworkHost('mybox.local')).toBe(true);
    expect(isPrivateNetworkHost('localhost')).toBe(true);
    expect(isPrivateNetworkHost('[::1]')).toBe(true);
    // Just outside each range: public.
    expect(isPrivateNetworkHost('172.15.0.1')).toBe(false);
    expect(isPrivateNetworkHost('172.32.0.1')).toBe(false);
    expect(isPrivateNetworkHost('11.0.0.1')).toBe(false);
    expect(isPrivateNetworkHost('192.169.0.1')).toBe(false);
    expect(isPrivateNetworkHost('example.com')).toBe(false);
  });
});

describe('origin posture: labeled degradation, never dead buttons', () => {
  test('plain http on a LAN IP: all three gated capabilities labeled, one notice line', () => {
    const posture = describeOriginPosture('http://192.168.1.50:3423');
    expect(posture.scheme).toBe('http');
    expect(posture.privateNetwork).toBe(true);
    expect(posture.secureContext).toBe(false);
    expect(posture.notice).toBe(LAN_PLAIN_HTTP_NOTICE);
    expect(posture.capabilities.map((c) => c.capability).sort()).toEqual(['microphone', 'push', 'service-worker']);
    for (const capability of posture.capabilities) {
      expect(capability.available).toBe(false);
      expect(capability.reason).toBe('needs https — available via tailscale');
    }
  });

  test('localhost keeps all three capabilities even over http, and no notice', () => {
    for (const origin of ['http://localhost:3423', 'http://127.0.0.1:3423']) {
      const posture = describeOriginPosture(origin);
      expect(posture.secureContext).toBe(true);
      expect(posture.notice).toBeUndefined();
      expect(posture.capabilities.every((c) => c.available)).toBe(true);
    }
  });

  test('https (e.g. a tailscale MagicDNS URL) is the full posture', () => {
    const posture = describeOriginPosture('https://mybox.my-tailnet.ts.net');
    expect(posture.scheme).toBe('https');
    expect(posture.secureContext).toBe(true);
    expect(posture.notice).toBeUndefined();
    expect(posture.capabilities.every((c) => c.available)).toBe(true);
  });

  test('an invalid origin degrades honestly instead of throwing', () => {
    const posture = describeOriginPosture('not a url');
    expect(posture.scheme).toBe('other');
    expect(posture.capabilities.every((c) => !c.available)).toBe(true);
  });
});

describe('the pairing hand-off carries the posture', () => {
  const ctx = { context: { principalId: 'pairing:p1', admin: true } } as const;

  function makeCatalog(webOrigin: string): GatewayMethodCatalog {
    const catalog = new GatewayMethodCatalog();
    registerPairingHandoffGatewayMethods(catalog, {
      tokens: { mint: ({ name }) => ({ id: 'pair-1', name, token: 'gvp_x', createdAt: 1 }) },
      push: {
        getPublicKey: async () => 'VAPID',
        subscribe: async (input) => ({ id: 'push-1', principalId: input.principalId, endpointOrigin: 'o', endpointHash: 'h', createdAt: 1 }),
      },
      relayAvailable: () => false,
      webOrigin: () => webOrigin,
    });
    return catalog;
  }

  test('handoff.create on a LAN http origin states the notice + labeled gaps once', async () => {
    const created = await makeCatalog('http://192.168.1.50:3423').invoke('pairing.handoff.create', {
      ...ctx,
      body: { name: 'Phone' },
    }) as { posture?: { notice?: string; capabilities: Array<{ available: boolean; reason?: string }> } };
    expect(created.posture?.notice).toBe(LAN_PLAIN_HTTP_NOTICE);
    expect(created.posture?.capabilities.every((c) => !c.available && c.reason?.includes('tailscale'))).toBe(true);
  });

  test('pairing.posture.get answers for the surface\'s own origin', async () => {
    const got = await makeCatalog('http://192.168.1.50:3423').invoke('pairing.posture.get', {
      ...ctx,
      body: { origin: 'https://mybox.my-tailnet.ts.net' },
    }) as { posture: { secureContext: boolean; capabilities: Array<{ available: boolean }> } };
    expect(got.posture.secureContext).toBe(true);
    expect(got.posture.capabilities.every((c) => c.available)).toBe(true);
  });
});

afterEach(() => {
  // Belt-and-braces: never leave a mutated globalThis.process behind.
  if (!(globalThis as { process?: unknown }).process) {
    (globalThis as { process?: unknown }).process = process;
  }
});
