/**
 * pairing-handoff.test.ts
 *
 * The pairing hand-off bundle: (1) the deep-link content is exactly the
 * `#pair=<token>` fragment shape the web app consumes, and (2) one exchange
 * carries the notifications/relay/passkey offer set which a surface completes in
 * a single pass, each offer independently declinable. The verbs are proven over
 * a real GatewayMethodCatalog with the handlers attached the daemon's way.
 */
import { describe, expect, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerPairingHandoffGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/pairing-handoff.ts';
import {
  buildPairingHandoffLink,
  parsePairingHandoffLink,
} from '../packages/sdk/src/platform/pairing/pairing-handoff.ts';

/**
 * Real subscription key material. The hand-off registers a push subscription
 * through the same content validation `push.subscriptions.create` applies, so
 * placeholder strings are refused at 400, as they should be, since they could
 * never receive a push.
 */
const pushKeys = ((): { p256dh: string; auth: string } => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
})();

describe('pairing hand-off deep link (the #pair= shape the web app consumes)', () => {
  test('build -> parse round-trips token + offers; the web app can read `pair`', () => {
    const link = buildPairingHandoffLink({
      webOrigin: 'https://app.example/',
      token: 'gvp_abc',
      offers: ['notifications', 'passkey'],
    });
    expect(link).toBe('https://app.example/#pair=gvp_abc&offers=notifications%2Cpasskey');

    // The web app reads the `pair` key out of the fragment via URLSearchParams.
    const hash = link.slice(link.indexOf('#') + 1);
    expect(new URLSearchParams(hash).get('pair')).toBe('gvp_abc');

    const parsed = parsePairingHandoffLink(link);
    expect(parsed).toEqual({ token: 'gvp_abc', offers: ['notifications', 'passkey'] });
  });

  test('a plain pairing link with no offers still parses the token', () => {
    const link = buildPairingHandoffLink({ webOrigin: 'https://app.example', token: 'gvp_z' });
    expect(link).toBe('https://app.example/#pair=gvp_z');
    expect(parsePairingHandoffLink(link)).toEqual({ token: 'gvp_z', offers: [] });
    expect(parsePairingHandoffLink('#nothing=here')).toBeNull();
  });
});

interface Captured {
  readonly subscribed: Array<{ endpoint: string; deviceId?: string }>;
  readonly credentials: Array<{ credentialId: string }>;
}

function makeCatalog(relayAvailable = true, withStepUp = true): { catalog: GatewayMethodCatalog; captured: Captured } {
  const captured: Captured = { subscribed: [], credentials: [] };
  const catalog = new GatewayMethodCatalog();
  registerPairingHandoffGatewayMethods(catalog, {
    tokens: { mint: ({ name }) => ({ id: 'pair-1', name, token: 'gvp_minted', createdAt: 1 }) },
    push: {
      getPublicKey: async () => 'VAPID_PUBLIC',
      subscribe: async (input) => {
        captured.subscribed.push({ endpoint: input.endpoint, ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
        return {
          id: 'push-1', principalId: input.principalId, endpointOrigin: 'https://push', endpointHash: 'h', createdAt: 1,
        };
      },
    },
    ...(withStepUp
      ? {
          stepUp: {
            registerCredential: async (input) => {
              captured.credentials.push({ credentialId: input.credentialId });
              return { credential: { credentialId: input.credentialId } } as never;
            },
            mintChallenge: (() => ({})) as never,
          },
        }
      : {}),
    relayAvailable: () => relayAvailable,
    webOrigin: () => 'https://app.example',
  });
  return { catalog, captured };
}

const ctx = { context: { principalId: 'pairing:pair-1', admin: true } } as const;

describe('pairing.handoff.* over the catalog', () => {
  test('create mints a token and advertises the available offer set + deep link', async () => {
    const { catalog } = makeCatalog();
    const created = await catalog.invoke('pairing.handoff.create', {
      ...ctx,
      body: { name: 'Phone' },
    }) as { token: { token: string }; offers: Array<{ kind: string; vapidPublicKey?: string }>; fragment: string; deepLink?: string };

    expect(created.token.token).toBe('gvp_minted');
    const kinds = created.offers.map((o) => o.kind).sort();
    expect(kinds).toEqual(['notifications', 'passkey', 'relay']);
    // The notifications offer carries the VAPID public key.
    expect(created.offers.find((o) => o.kind === 'notifications')?.vapidPublicKey).toBe('VAPID_PUBLIC');
    expect(created.fragment).toBe('#pair=gvp_minted&offers=notifications%2Crelay%2Cpasskey');
    expect(created.deepLink).toBe('https://app.example/#pair=gvp_minted&offers=notifications%2Crelay%2Cpasskey');
  });

  test('complete applies notifications + relay in one pass and reports passkey declined', async () => {
    const { catalog, captured } = makeCatalog();
    const done = await catalog.invoke('pairing.handoff.complete', {
      ...ctx,
      body: {
        accept: {
          notifications: { endpoint: 'https://push/device', keys: pushKeys, deviceId: 'dev-1' },
          relay: true,
          // passkey omitted -> declined
        },
      },
    }) as { results: Array<{ kind: string; status: string }> };

    const byKind = Object.fromEntries(done.results.map((r) => [r.kind, r.status]));
    expect(byKind).toEqual({ notifications: 'completed', relay: 'completed', passkey: 'declined' });
    // The notifications offer really registered the subscription (device-scoped).
    expect(captured.subscribed).toEqual([{ endpoint: 'https://push/device', deviceId: 'dev-1' }]);
    expect(captured.credentials).toHaveLength(0);
  });

  test('an accepted passkey offer registers the credential in the same pass', async () => {
    const { catalog, captured } = makeCatalog();
    const done = await catalog.invoke('pairing.handoff.complete', {
      ...ctx,
      body: {
        accept: {
          notifications: { endpoint: 'https://push/d', keys: pushKeys },
          relay: false, // explicitly declined
          passkey: { rpId: 'app.example', origin: 'https://app.example', credentialId: 'cred-1', publicKeyCose: 'cose' },
        },
      },
    }) as { results: Array<{ kind: string; status: string }> };

    const byKind = Object.fromEntries(done.results.map((r) => [r.kind, r.status]));
    expect(byKind).toEqual({ notifications: 'completed', relay: 'declined', passkey: 'completed' });
    expect(captured.credentials).toEqual([{ credentialId: 'cred-1' }]);
  });

  test('a notifications offer with unusable key material is refused, not stored', async () => {
    const { catalog, captured } = makeCatalog();
    // A malformed request is a 400 here, the same as every other bad argument
    // in this verb, and nothing reaches the push service, so a record that
    // could never receive a push is never registered.
    await expect(catalog.invoke('pairing.handoff.complete', {
      ...ctx,
      body: {
        accept: {
          notifications: { endpoint: 'https://push/device', keys: { p256dh: 'not-base64!!!!', auth: 'x' } },
        },
      },
    })).rejects.toThrow('Push subscription p256dh key is not a 65-byte uncompressed P-256 point');
    expect(captured.subscribed).toHaveLength(0);
  });

  test('a notifications offer with an oversized endpoint is refused', async () => {
    const { catalog, captured } = makeCatalog();
    await expect(catalog.invoke('pairing.handoff.complete', {
      ...ctx,
      body: {
        accept: {
          notifications: { endpoint: `https://push/${'d'.repeat(50_000)}`, keys: pushKeys },
        },
      },
    })).rejects.toThrow('longer than 2048 characters');
    expect(captured.subscribed).toHaveLength(0);
  });

  test('an offer the daemon does not support is reported unavailable, not faked', async () => {
    const { catalog } = makeCatalog(false /* relay unavailable */, false /* no step-up */);
    const created = await catalog.invoke('pairing.handoff.create', { ...ctx, body: { name: 'X' } }) as { offers: Array<{ kind: string }> };
    // Only notifications is available.
    expect(created.offers.map((o) => o.kind)).toEqual(['notifications']);

    const done = await catalog.invoke('pairing.handoff.complete', {
      ...ctx,
      body: { accept: { relay: true, passkey: { rpId: 'r', origin: 'o', credentialId: 'c', publicKeyCose: 'k' } } },
    }) as { results: Array<{ kind: string; status: string }> };
    const byKind = Object.fromEntries(done.results.map((r) => [r.kind, r.status]));
    expect(byKind.relay).toBe('unavailable');
    expect(byKind.passkey).toBe('unavailable');
    expect(byKind.notifications).toBe('declined');
  });
});
