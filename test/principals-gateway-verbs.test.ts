/**
 * principals-gateway-verbs.test.ts
 *
 * The principals.* CRUD + resolve gateway verbs, proven over a real
 * GatewayMethodCatalog with the handlers attached the way the daemon attaches
 * them (registerPrincipalsGatewayMethods). Also proves the cross-channel
 * behavior that matters: an unmapped sender resolves to the honest unknown
 * principal, and an identity cannot be silently stolen from another principal.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerPrincipalsGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/principals.ts';
import { PrincipalRegistry, PrincipalStore, UNKNOWN_PRINCIPAL_ID } from '../packages/sdk/src/platform/principals/index.ts';

function makeCatalog(): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerPrincipalsGatewayMethods(catalog, new PrincipalRegistry(new PrincipalStore(':memory:')));
  return catalog;
}

const ctx = { context: { admin: true } } as const;

interface PrincipalShape {
  id: string;
  name: string;
  kind: string;
  identities: { channel: string; value: string }[];
}

describe('principals.* gateway verbs', () => {
  test('all six verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of ['principals.list', 'principals.get', 'principals.create', 'principals.update', 'principals.delete', 'principals.resolve']) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('create -> list -> get -> update -> delete round-trips', async () => {
    const catalog = makeCatalog();

    const created = await catalog.invoke('principals.create', {
      ...ctx,
      body: { name: 'Mike', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }] },
    }) as { principal: PrincipalShape };
    expect(created.principal.name).toBe('Mike');
    expect(created.principal.id.startsWith('principal:')).toBe(true);
    const id = created.principal.id;

    const listed = await catalog.invoke('principals.list', { ...ctx, body: {} }) as { principals: PrincipalShape[] };
    expect(listed.principals.map((p) => p.name)).toEqual(['Mike']);

    const got = await catalog.invoke('principals.get', { ...ctx, body: { principalId: id } }) as { principal: PrincipalShape };
    expect(got.principal.identities).toEqual([{ channel: 'slack', value: 'U123' }]);

    const updated = await catalog.invoke('principals.update', {
      ...ctx,
      body: { principalId: id, identities: [{ channel: 'slack', value: 'U123' }, { channel: 'email', value: 'mike@example.com' }] },
    }) as { principal: PrincipalShape };
    expect(updated.principal.identities).toHaveLength(2);

    const deleted = await catalog.invoke('principals.delete', { ...ctx, body: { principalId: id } });
    expect(deleted).toEqual({ principalId: id, deleted: true });
  });

  test('resolve maps a channel identity across a hop, unmapped is honest unknown', async () => {
    const catalog = makeCatalog();
    await catalog.invoke('principals.create', {
      ...ctx,
      body: { name: 'Mike', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }, { channel: 'email', value: 'mike@example.com' }] },
    });

    // Same principal reached from a different channel — continuity survives the hop.
    const viaEmail = await catalog.invoke('principals.resolve', {
      ...ctx,
      body: { channel: 'email', value: 'mike@example.com' },
    }) as { principal: PrincipalShape; known: boolean };
    expect(viaEmail.known).toBe(true);
    expect(viaEmail.principal.name).toBe('Mike');

    // Channel is matched case-insensitively (normalizeIdentity lowercases channel).
    const viaSlackUpper = await catalog.invoke('principals.resolve', {
      ...ctx,
      body: { channel: 'Slack', value: 'U123' },
    }) as { known: boolean };
    expect(viaSlackUpper.known).toBe(true);

    const unknown = await catalog.invoke('principals.resolve', {
      ...ctx,
      body: { channel: 'phone', value: '+15550000' },
    }) as { principal: PrincipalShape; known: boolean };
    expect(unknown.known).toBe(false);
    expect(unknown.principal.id).toBe(UNKNOWN_PRINCIPAL_ID);
    // The unknown record carries the exact identity that failed to resolve.
    expect(unknown.principal.identities).toEqual([{ channel: 'phone', value: '+15550000' }]);
  });

  test('an identity already mapped to another principal is a 409 conflict, never stolen', async () => {
    const catalog = makeCatalog();
    await catalog.invoke('principals.create', {
      ...ctx,
      body: { name: 'Mike', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }] },
    });
    const error = await catalog.invoke('principals.create', {
      ...ctx,
      body: { name: 'Impostor', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }] },
    }).catch((e) => e);
    expect((error as { status?: number }).status).toBe(409);
  });

  test('get on a missing principal is a 404; delete of a missing one is honest { deleted: false }', async () => {
    const catalog = makeCatalog();
    const error = await catalog.invoke('principals.get', { ...ctx, body: { principalId: 'principal:ghost' } }).catch((e) => e);
    expect((error as { status?: number }).status).toBe(404);
    const deleted = await catalog.invoke('principals.delete', { ...ctx, body: { principalId: 'principal:ghost' } });
    expect(deleted).toEqual({ principalId: 'principal:ghost', deleted: false });
  });
});
