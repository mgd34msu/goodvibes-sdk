/**
 * relay-verbs.test.ts
 *
 * `relay.reachability.get` and `relay.pairing.mint`.
 *
 * The reachability controller shipped on every daemon that turns the relay on,
 * and the only way to read it was `DaemonServer.getRelayReachability()`, an
 * in-process method. A surface in the same process could see the state; every
 * client over the wire could only say "unavailable", which the terminal did,
 * honestly and uselessly.
 *
 * The properties worth holding: absence and disabled are the same answer, a
 * gated-off relay is distinguishable from a failing one, minting against no
 * live registration is null rather than an error, and the accessor is consulted
 * on every call so a controller dropped at stop stops being answered for.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  RELAY_METHOD_IDS,
  registerRelayGatewayMethods,
  type RelayReachabilityService,
} from '../packages/sdk/src/platform/control-plane/routes/relay.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

const PAIRING = {
  protocol: 1,
  relayUrl: 'wss://relay.example.com',
  rid: 'rid_abc',
  daemonPublicKey: 'BASE64URLKEY',
  label: 'the workshop machine',
};

function invocation(): GatewayMethodInvocation {
  return { methodId: 'test', body: {}, context: {} } as unknown as GatewayMethodInvocation;
}

function catalogFor(accessor: () => RelayReachabilityService | null): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerRelayGatewayMethods(catalog, accessor);
  return catalog;
}

function controller(status: string, pairing: unknown = PAIRING): RelayReachabilityService {
  return { status, mintPairing: async () => pairing };
}

describe('the verbs are in the catalog and handled', () => {
  test('both descriptors exist and carry a handler', () => {
    const catalog = catalogFor(() => null);
    for (const id of RELAY_METHOD_IDS) {
      expect(catalog.get(id), id).toBeDefined();
      expect(catalog.hasHandler(id), id).toBe(true);
      expect(catalog.get(id)?.invokable, id).not.toBe(false);
    }
  });

  test('minting is admin-gated and reading is not', () => {
    const catalog = catalogFor(() => null);
    expect(catalog.get('relay.pairing.mint')?.access).toBe('admin');
    expect(catalog.get('relay.reachability.get')?.scopes).toEqual(['read:control-plane']);
  });
});

describe('reachability', () => {
  test('a registered relay reports its live status and counts as configured', async () => {
    const catalog = catalogFor(() => controller('registered'));
    expect(await catalog.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'registered', configured: true });
  });

  test('a gated-off relay is `disabled`, which is not the same answer as a failing one', async () => {
    const off = catalogFor(() => controller('disabled'));
    expect(await off.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'disabled', configured: false });

    // Reconnecting means the gates ARE open and the connection is not up: a
    // caller renders "retrying", not "turn it on".
    const flapping = catalogFor(() => controller('reconnecting'));
    expect(await flapping.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'reconnecting', configured: true });
  });

  test('no controller at all reads as disabled rather than throwing', async () => {
    // The daemon builds one at start and drops it at stop, so a client can ask
    // in between. That window must answer, not fault.
    const catalog = catalogFor(() => null);
    expect(await catalog.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'disabled', configured: false });
  });

  test('the accessor is consulted per call, so a stopped relay stops being answered for', async () => {
    let live: RelayReachabilityService | null = controller('registered');
    const catalog = catalogFor(() => live);
    expect(await catalog.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'registered', configured: true });

    live = null;
    expect(await catalog.invoke('relay.reachability.get', invocation()))
      .toEqual({ status: 'disabled', configured: false });
  });
});

describe('pairing', () => {
  test('a live registration mints the payload a surface scans', async () => {
    const catalog = catalogFor(() => controller('registered'));
    expect(await catalog.invoke('relay.pairing.mint', invocation()))
      .toEqual({ pairing: PAIRING, status: 'registered' });
  });

  test('nothing to mint against is null and a status, not an error', async () => {
    const catalog = catalogFor(() => controller('idle', null));
    expect(await catalog.invoke('relay.pairing.mint', invocation()))
      .toEqual({ pairing: null, status: 'idle' });
  });

  test('no controller mints null and says the relay is disabled', async () => {
    const catalog = catalogFor(() => null);
    expect(await catalog.invoke('relay.pairing.mint', invocation()))
      .toEqual({ pairing: null, status: 'disabled' });
  });

  test('the minted payload carries every field the descriptor declares required', async () => {
    const catalog = catalogFor(() => controller('registered'));
    const answer = await catalog.invoke('relay.pairing.mint', invocation()) as { pairing: Record<string, unknown> };
    for (const field of ['protocol', 'relayUrl', 'rid', 'daemonPublicKey']) {
      expect(answer.pairing[field], field).toBeDefined();
    }
  });
});
