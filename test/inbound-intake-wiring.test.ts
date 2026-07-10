/**
 * inbound-intake-wiring.test.ts
 *
 * Proves the inbound-intake enrichment is actually WIRED at the transport intake
 * chokepoint (SharedSessionBroker.submitMessage), not just that the substrate
 * exists: an inbound message from a mapped identity originates a session
 * attributed to the right principal with the channel profile applied, and an
 * unmapped sender gets the honest unknown principal (known:false), never a guess.
 */
import { describe, expect, test } from 'bun:test';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import {
  ChannelProfileRegistry,
  ChannelProfileStore,
  installInboundIntakeEnrichment,
  enrichInboundSubmitMetadata,
  ATTRIBUTED_PRINCIPAL_ID_KEY,
  ATTRIBUTED_PRINCIPAL_NAME_KEY,
  ATTRIBUTED_PRINCIPAL_KNOWN_KEY,
  CHANNEL_PROFILE_MODEL_KEY,
  CHANNEL_PROFILE_PROVIDER_KEY,
  CHANNEL_PROFILE_PERMISSION_MODE_KEY,
} from '../packages/sdk/src/platform/channel-profiles/index.ts';
import { PrincipalRegistry, PrincipalStore, UNKNOWN_PRINCIPAL_ID } from '../packages/sdk/src/platform/principals/index.ts';

function makeBroker(): SharedSessionBroker {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    getBinding: () => null,
    resolve: () => null,
    upsertBinding: async (b: Record<string, unknown>) => ({ id: 'rb-1', ...b }),
  } as unknown as RouteBindingManager;
  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

async function makeRegistries() {
  const principals = new PrincipalRegistry(new PrincipalStore(':memory:'));
  const mike = await principals.create({
    name: 'Mike',
    kind: 'user',
    identities: [{ channel: 'slack', value: 'U123' }],
  });
  const channelProfiles = new ChannelProfileRegistry(new ChannelProfileStore(':memory:'));
  await channelProfiles.set({
    surfaceKind: 'slack',
    model: 'claude-profile-model',
    provider: 'anthropic',
    permissionMode: 'auto',
  });
  return { principals, channelProfiles, mikeId: mike.id };
}

describe('inbound-intake enrichment — pure metadata mapping', () => {
  test('a mapped identity produces principal attribution + the applied channel profile', async () => {
    const { principals, channelProfiles, mikeId } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U123', body: 'hi' },
    );
    expect(metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(mikeId);
    expect(metadata[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('Mike');
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(metadata[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
    expect(metadata[CHANNEL_PROFILE_PROVIDER_KEY]).toBe('anthropic');
    expect(metadata[CHANNEL_PROFILE_PERMISSION_MODE_KEY]).toBe('auto');
  });

  test('an unmapped sender is attributed to the honest unknown principal (known:false)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U999-not-mapped', body: 'hi' },
    );
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(metadata[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
    // The profile still applies — it binds to the channel, not the sender.
    expect(metadata[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
  });

  test('caller-set metadata is preserved (enrichment augments, never rewrites)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const metadata = await enrichInboundSubmitMetadata(
      { principals, channelProfiles },
      { surfaceKind: 'slack', surfaceId: 'T1', userId: 'U123', body: 'hi', metadata: { threadTs: '42.0' } },
    );
    expect(metadata.threadTs).toBe('42.0');
    expect(metadata[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
  });
});

describe('inbound-intake enrichment — wired at the broker submitMessage seam', () => {
  test('installInboundIntakeEnrichment attributes an originated session and applies the profile', async () => {
    const { principals, channelProfiles, mikeId } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });

    const submission = await broker.submitMessage({
      surfaceKind: 'slack',
      surfaceId: 'T1',
      externalId: 'C-general',
      userId: 'U123',
      displayName: 'mike',
      body: 'ship it',
    });

    const meta = submission.session.metadata ?? {};
    expect(meta[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(mikeId);
    expect(meta[ATTRIBUTED_PRINCIPAL_NAME_KEY]).toBe('Mike');
    expect(meta[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(true);
    expect(meta[CHANNEL_PROFILE_MODEL_KEY]).toBe('claude-profile-model');
    expect(meta[CHANNEL_PROFILE_PROVIDER_KEY]).toBe('anthropic');
    expect(meta[CHANNEL_PROFILE_PERMISSION_MODE_KEY]).toBe('auto');
  });

  test('an unmapped sender originates a session with the honest unknown principal', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });

    const submission = await broker.submitMessage({
      surfaceKind: 'slack',
      surfaceId: 'T1',
      externalId: 'C-general',
      userId: 'U999-not-mapped',
      body: 'who am i',
    });

    const meta = submission.session.metadata ?? {};
    expect(meta[ATTRIBUTED_PRINCIPAL_KNOWN_KEY]).toBe(false);
    expect(meta[ATTRIBUTED_PRINCIPAL_ID_KEY]).toBe(UNKNOWN_PRINCIPAL_ID);
  });

  test('installing twice does not double-wrap (idempotent guard)', async () => {
    const { principals, channelProfiles } = await makeRegistries();
    const broker = makeBroker();
    await broker.start();
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    const wrappedOnce = broker.submitMessage;
    installInboundIntakeEnrichment(broker, { principals, channelProfiles });
    expect(broker.submitMessage).toBe(wrappedOnce);
  });
});
