/**
 * relay-step-up-integration.test.ts
 *
 * End-to-end proof of the WebAuthn step-up gate: with the requirement switched
 * on and a verifier wired, a MUTATING call arriving over the relay is rejected
 * (401) unless it carries a genuinely-verified assertion, while read calls pass
 * untouched. Driven through the real daemon wiring (buildDaemonRelayReachability)
 * and a real relay server + client, so the composition — not a stub — is tested.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createBunRelayServer } from '../packages/daemon-sdk/src/index.js';
import { buildDaemonRelayReachability } from '../packages/sdk/src/platform/relay/daemon-wiring.js';
import { STEP_UP_ASSERTION_HEADER } from '../packages/sdk/src/platform/relay/step-up-policy.js';
import { createRelayClient } from '../packages/transport-realtime/src/relay-transport.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { SecretsManager } from '../packages/sdk/src/platform/config/secrets.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const server = createBunRelayServer({ port: 0, logger: silent });
const relayUrl = `ws://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

function fakeConfig(overrides: Record<string, unknown>): ConfigManager {
  const map: Record<string, unknown> = {
    'relay.enabled': true,
    'relay.url': relayUrl,
    'relay.rendezvousId': 'rid-stepup-fixed',
    'relay.label': '',
    'relay.requireStepUpForMutations': true,
    ...overrides,
  };
  return { get: (key: string) => map[key], set: () => {} } as unknown as ConfigManager;
}

const memSecrets = { get: async () => null, set: async () => {} } as unknown as SecretsManager;
const flags = { isEnabled: () => true };
const echo = async (req: Request): Promise<Response> =>
  new Response(JSON.stringify({ ok: true, method: req.method }), { status: 200, headers: { 'content-type': 'application/json' } });

async function waitRegistered(status: () => string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (status() === 'registered') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('daemon did not register in time');
}

describe('relay step-up gate end-to-end', () => {
  test('mutating relay call is denied without a verified assertion and allowed with one; reads pass', async () => {
    const reachability = buildDaemonRelayReachability(
      fakeConfig({}),
      memSecrets,
      flags,
      echo,
      silent,
      async (assertion) => assertion === 'good-assertion',
    );
    await reachability.start();
    await waitRegistered(() => reachability.status);

    const pairing = await reachability.mintPairing();
    expect(pairing).not.toBeNull();
    const client = createRelayClient({ pairing: pairing! });
    await client.connect();

    // Mutating call, no step-up assertion → 401.
    const denied = await client.fetch('https://relay.invalid/api/approvals/claim', { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: 'step-up-required' });

    // Mutating call with a verified assertion → allowed through to the daemon.
    const allowed = await client.fetch('https://relay.invalid/api/approvals/claim', {
      method: 'POST',
      body: '{}',
      headers: { [STEP_UP_ASSERTION_HEADER]: 'good-assertion' },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true, method: 'POST' });

    // Read call is never gated.
    const read = await client.fetch('https://relay.invalid/api/approvals');
    expect(read.status).toBe(200);

    client.close();
    reachability.stop();
  });

  test('the challenge-mint bootstrap path is exempt from the gate (mutating, but not blocked)', async () => {
    const reachability = buildDaemonRelayReachability(
      fakeConfig({ 'relay.rendezvousId': 'rid-stepup-mint' }),
      memSecrets,
      flags,
      echo,
      silent,
      // A verifier that refuses everything: proves the mint path bypasses it.
      async () => false,
    );
    await reachability.start();
    await waitRegistered(() => reachability.status);
    const pairing = await reachability.mintPairing();
    const client = createRelayClient({ pairing: pairing! });
    await client.connect();

    // POST to the challenge-mint path with NO assertion still reaches the daemon.
    const mint = await client.fetch('https://relay.invalid/api/stepup/challenge', { method: 'POST', body: '{}' });
    expect(mint.status).toBe(200);
    expect(await mint.json()).toMatchObject({ ok: true, method: 'POST' });

    // Credential registration is NOT exempt: a mutating call there is still gated.
    const register = await client.fetch('https://relay.invalid/api/stepup/credentials', { method: 'POST', body: '{}' });
    expect(register.status).toBe(401);

    client.close();
    reachability.stop();
  });
});
