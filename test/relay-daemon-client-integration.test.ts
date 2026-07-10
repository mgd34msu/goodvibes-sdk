/**
 * relay-daemon-client-integration.test.ts
 *
 * The headline proof for the relay path: the EXISTING typed operator client,
 * built only with a relay-backed `fetchImpl`, works unchanged over the relay.
 * A real Bun relay server, a real daemon-side registration terminating the E2E
 * channel and replaying tunneled requests against the mock-daemon fixtures, and
 * the real `createOperatorSdk` client on the far side. Nothing about the typed
 * client is relay-aware — it just calls `sdk.approvals.list()` and gets the
 * daemon's answer back through the encrypted tunnel.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
import { createMockDaemon } from '@pellux/goodvibes-contracts/testing';
import {
  createBunRelayServer,
  createRelayDaemonRegistration,
  RELAY_VIA_HEADER,
} from '../packages/daemon-sdk/src/index.js';
import { createRelayClient } from '../packages/transport-realtime/src/relay-transport.js';
import { createOperatorSdk } from '../packages/operator-sdk/src/client.js';
import { generateRelayIdentity, relayIdentityPublicKeyBase64Url } from '../packages/transport-core/src/relay/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const server = createBunRelayServer({ port: 0, logger: silent });
const relayUrl = `ws://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

async function standUpDaemon(rid: string, dispatch: (req: Request) => Promise<Response | null>) {
  const identity = await generateRelayIdentity();
  let resolveReg: () => void = () => {};
  const registered = new Promise<void>((resolve) => {
    resolveReg = resolve;
  });
  const reg = createRelayDaemonRegistration({
    relayUrl,
    rid,
    identity,
    localBaseUrl: 'http://daemon.local',
    dispatch,
    logger: silent,
    onStatusChange: (s) => {
      if (s === 'registered') resolveReg();
    },
  });
  reg.start();
  await registered;
  return reg;
}

describe('typed operator client over the relay', () => {
  test('sdk.approvals.list() round-trips through the encrypted tunnel', async () => {
    const mock = createMockDaemon(getOperatorContract());
    const expected = mock.answerHttp('GET', '/api/approvals');
    expect(expected).not.toBeNull();

    let sawViaHeader = false;
    let sawAuth: string | null = null;
    const reg = await standUpDaemon('rid-typed-client', async (req) => {
      const url = new URL(req.url);
      sawViaHeader = req.headers.get(RELAY_VIA_HEADER) === '1';
      sawAuth = req.headers.get('authorization');
      const answer = mock.answerHttp(req.method, url.pathname);
      if (!answer) return null;
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const pairing = await reg.mintPairing('test-daemon');
    const client = createRelayClient({ pairing });
    await client.connect();

    const sdk = createOperatorSdk({ baseUrl: 'https://relay.invalid', fetchImpl: client.fetch, authToken: 'operator-token-xyz' });
    const result = await sdk.approvals.list();

    expect(result).toEqual(expected!.body);
    // The tunneled request carried the operator's auth token (invisible to the
    // relay) and was tagged as arriving via relay.
    expect(sawAuth).toBe('Bearer operator-token-xyz');
    expect(sawViaHeader).toBe(true);

    client.close();
    reg.stop();
  });

  test('dialing an offline daemon surfaces an honest error', async () => {
    const identity = await generateRelayIdentity();
    const daemonPublicKey = await relayIdentityPublicKeyBase64Url(identity);
    const client = createRelayClient({
      pairing: { protocol: 1, relayUrl, rid: 'rid-that-nobody-registered', daemonPublicKey },
      connectTimeoutMs: 3000,
    });
    await expect(client.connect()).rejects.toThrow(/daemon/i);
    client.close();
  });
});
