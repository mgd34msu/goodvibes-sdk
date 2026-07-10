/**
 * relay-reachability.test.ts
 *
 * The daemon-side reachability controller: its triple gate (config + feature
 * flag + url), one-time identity generation with durable custody, rendezvous-id
 * minting, and the full outbound registration against a real relay server. The
 * controller is what the daemon facade calls at boot; here it is exercised in
 * isolation with an in-memory identity store and a live Bun relay.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createBunRelayServer } from '../packages/daemon-sdk/src/index.js';
import {
  createRelayReachability,
  isRelayReachabilityEnabled,
  type RelayIdentityStore,
} from '../packages/sdk/src/platform/relay/reachability.js';
import { createRelayClient } from '../packages/transport-realtime/src/relay-transport.js';
import type { SerializedRelayIdentity } from '../packages/transport-core/src/relay/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const server = createBunRelayServer({ port: 0, logger: silent });
const relayUrl = `ws://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

function memoryStore(): RelayIdentityStore & { saved: SerializedRelayIdentity | null; saves: number } {
  const state = {
    saved: null as SerializedRelayIdentity | null,
    saves: 0,
    load: async () => state.saved,
    save: async (id: SerializedRelayIdentity) => {
      state.saved = id;
      state.saves += 1;
    },
  };
  return state;
}

const echoDispatch = async (req: Request): Promise<Response> =>
  new Response(JSON.stringify({ path: new URL(req.url).pathname }), { headers: { 'content-type': 'application/json' } });

describe('relay reachability gating', () => {
  test('all three gates required', () => {
    const base = { url: 'wss://r', rendezvousId: '', label: '' };
    expect(isRelayReachabilityEnabled({ ...base, enabled: true }, true)).toBe(true);
    expect(isRelayReachabilityEnabled({ ...base, enabled: false }, true)).toBe(false);
    expect(isRelayReachabilityEnabled({ ...base, enabled: true }, false)).toBe(false);
    expect(isRelayReachabilityEnabled({ enabled: true, url: '', rendezvousId: '', label: '' }, true)).toBe(false);
  });

  test('disabled controller is inert', async () => {
    const store = memoryStore();
    const r = createRelayReachability({
      config: { enabled: false, url: relayUrl, rendezvousId: '', label: '' },
      featureFlagEnabled: true,
      identityStore: store,
      dispatch: echoDispatch,
    });
    await r.start();
    expect(r.status).toBe('disabled');
    expect(await r.mintPairing()).toBeNull();
    expect(store.saves).toBe(0);
    r.stop();
  });
});

describe('relay reachability enabled', () => {
  test('generates + persists identity, mints a rid, registers, and serves a tunneled request', async () => {
    const store = memoryStore();
    let mintedRid = '';
    let registered: () => void = () => {};
    const registeredP = new Promise<void>((res) => {
      registered = res;
    });
    const r = createRelayReachability({
      config: { enabled: true, url: relayUrl, rendezvousId: '', label: 'Studio' },
      featureFlagEnabled: true,
      identityStore: store,
      dispatch: echoDispatch,
      onRendezvousId: (rid) => {
        mintedRid = rid;
      },
      onStatusChange: (s) => {
        if (s === 'registered') registered();
      },
      logger: silent,
    });
    await r.start();
    await registeredP;

    expect(r.status).toBe('registered');
    expect(store.saves).toBe(1); // identity generated once and persisted
    expect(mintedRid.startsWith('rid_')).toBe(true);

    const pairing = await r.mintPairing();
    expect(pairing).not.toBeNull();
    expect(pairing!.rid).toBe(mintedRid);
    expect(pairing!.daemonPublicKey).toBe(store.saved!.publicKeyRaw);
    expect(pairing!.label).toBe('Studio');

    // A surface can now reach the daemon end-to-end using that pairing.
    const client = createRelayClient({ pairing: pairing! });
    await client.connect();
    const res = await fetchThrough(client, '/api/approvals');
    expect(res).toEqual({ path: '/api/approvals' });
    client.close();
    r.stop();
  });

  test('reuses a persisted identity across controller instances (no re-save)', async () => {
    const store = memoryStore();
    const first = createRelayReachability({
      config: { enabled: true, url: relayUrl, rendezvousId: 'rid_fixed_one', label: '' },
      featureFlagEnabled: true,
      identityStore: store,
      dispatch: echoDispatch,
      logger: silent,
    });
    await first.start();
    await Promise.resolve();
    first.stop();
    const firstPub = store.saved!.publicKeyRaw;

    const second = createRelayReachability({
      config: { enabled: true, url: relayUrl, rendezvousId: 'rid_fixed_one', label: '' },
      featureFlagEnabled: true,
      identityStore: store,
      dispatch: echoDispatch,
      logger: silent,
    });
    await second.start();
    expect(store.saves).toBe(1); // loaded, not regenerated
    expect(store.saved!.publicKeyRaw).toBe(firstPub);
    second.stop();
  });
});

async function fetchThrough(client: { fetch: typeof fetch }, path: string): Promise<unknown> {
  const res = await client.fetch(`https://relay.invalid${path}`);
  return res.json();
}
