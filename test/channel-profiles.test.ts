/**
 * channel-profiles.test.ts
 *
 * The per-channel profile binding registry + its channels.profiles.* gateway
 * verbs, plus the intake helpers that pair a binding with the principal registry
 * to attribute and enrich a channel-originated session.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerChannelProfilesGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/channel-profiles.ts';
import {
  ChannelProfileRegistry,
  ChannelProfileStore,
  applyChannelProfileToSpawn,
  attributeInboundSession,
  buildInboundIntakeEnrichment,
} from '../packages/sdk/src/platform/channel-profiles/index.ts';
import { PrincipalRegistry, PrincipalStore } from '../packages/sdk/src/platform/principals/index.ts';

function makeRegistry(): ChannelProfileRegistry {
  return new ChannelProfileRegistry(new ChannelProfileStore(':memory:'));
}

function makeCatalog(registry: ChannelProfileRegistry): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerChannelProfilesGatewayMethods(catalog, registry);
  return catalog;
}

const ctx = { context: { admin: true } } as const;

describe('channels.profiles.* registry + verbs', () => {
  test('all four verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog(makeRegistry());
    for (const id of ['channels.profiles.list', 'channels.profiles.get', 'channels.profiles.set', 'channels.profiles.delete']) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('set -> list -> get -> delete round-trips through the catalog', async () => {
    const catalog = makeCatalog(makeRegistry());
    const set = await catalog.invoke('channels.profiles.set', {
      ...ctx,
      body: { surfaceKind: 'slack', model: 'claude-opus', permissionMode: 'plan' },
    }) as { binding: { id: string; surfaceKind: string; model?: string; permissionMode?: string } };
    expect(set.binding.id).toBe('slack');
    expect(set.binding.permissionMode).toBe('plan');

    const listed = await catalog.invoke('channels.profiles.list', { ...ctx, body: {} }) as { bindings: unknown[] };
    expect(listed.bindings).toHaveLength(1);

    const got = await catalog.invoke('channels.profiles.get', { ...ctx, body: { surfaceKind: 'slack' } }) as { binding: { model?: string } };
    expect(got.binding.model).toBe('claude-opus');

    const deleted = await catalog.invoke('channels.profiles.delete', { ...ctx, body: { surfaceKind: 'slack' } });
    expect(deleted).toEqual({ surfaceKind: 'slack', deleted: true });
  });

  test('a channel-scoped binding wins over the surface-wide default on resolve', async () => {
    const registry = makeRegistry();
    await registry.set({ surfaceKind: 'slack', model: 'wide-default' });
    await registry.set({ surfaceKind: 'slack', channelId: 'C1', model: 'channel-specific', permissionMode: 'auto' });

    const specific = await registry.resolve('slack', 'C1');
    expect(specific).toEqual({ model: 'channel-specific', permissionMode: 'auto' });

    // A different channel with no scoped binding falls back to the surface-wide default.
    const fallback = await registry.resolve('slack', 'C-other');
    expect(fallback).toEqual({ model: 'wide-default' });

    // A surface with no binding at all resolves to null (intake keeps host defaults).
    expect(await registry.resolve('telegram')).toBeNull();
  });

  test('set upserts on the same key rather than accumulating rows', async () => {
    const registry = makeRegistry();
    await registry.set({ surfaceKind: 'slack', model: 'a' });
    await registry.set({ surfaceKind: 'slack', model: 'b' });
    const bindings = await registry.list();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.model).toBe('b');
  });

  test('get on a missing binding is 404; delete of a missing one is honest { deleted: false }', async () => {
    const catalog = makeCatalog(makeRegistry());
    const error = await catalog.invoke('channels.profiles.get', { ...ctx, body: { surfaceKind: 'ghost' } }).catch((e) => e);
    expect((error as { status?: number }).status).toBe(404);
    const deleted = await catalog.invoke('channels.profiles.delete', { ...ctx, body: { surfaceKind: 'ghost' } });
    expect(deleted).toEqual({ surfaceKind: 'ghost', deleted: false });
  });
});

describe('channel intake enrichment', () => {
  test('applyChannelProfileToSpawn fills gaps without overriding explicit values', () => {
    const filled = applyChannelProfileToSpawn({ task: 'x' } as { task: string; model?: string; provider?: string }, { model: 'm', provider: 'p' });
    expect(filled).toEqual({ task: 'x', model: 'm', provider: 'p' });
    const preserved = applyChannelProfileToSpawn({ task: 'x', model: 'explicit' }, { model: 'm' });
    expect(preserved.model).toBe('explicit');
    expect(applyChannelProfileToSpawn({ task: 'x' }, null)).toEqual({ task: 'x' });
  });

  test('attribution resolves a known sender and stamps honest unknown otherwise', async () => {
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
    await principals.create({ name: 'Mike', kind: 'user', identities: [{ channel: 'slack', value: 'U1' }] });

    const known = await attributeInboundSession(principals, { surfaceKind: 'slack', userId: 'U1' });
    expect(known.metadata.attributedPrincipalKnown).toBe(true);
    expect(known.metadata.attributedPrincipalName).toBe('Mike');

    const unknown = await attributeInboundSession(principals, { surfaceKind: 'slack', userId: 'U-nobody' });
    expect(unknown.metadata.attributedPrincipalKnown).toBe(false);

    const anon = await attributeInboundSession(principals, { surfaceKind: 'slack' });
    expect(anon.metadata.attributedPrincipalKnown).toBe(false);
    expect(anon.resolution).toBeNull();
  });

  test('buildInboundIntakeEnrichment combines attribution + profile in one call', async () => {
    const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
    await principals.create({ name: 'Mike', kind: 'user', identities: [{ channel: 'slack', value: 'U1' }] });
    const channelProfiles = makeRegistry();
    await channelProfiles.set({ surfaceKind: 'slack', channelId: 'C1', model: 'm', permissionMode: 'accept-edits' });

    const enrichment = await buildInboundIntakeEnrichment(
      { principals, channelProfiles },
      { surfaceKind: 'slack', userId: 'U1', channelId: 'C1' },
    );
    expect(enrichment.sessionMetadata.attributedPrincipalName).toBe('Mike');
    expect(enrichment.spawnOverrides).toEqual({ model: 'm' });
    expect(enrichment.permissionMode).toBe('accept-edits');
    expect(enrichment.principal?.known).toBe(true);
  });
});
