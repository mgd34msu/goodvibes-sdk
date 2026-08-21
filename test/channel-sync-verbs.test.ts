/**
 * channel-sync-verbs.test.ts
 *
 * The seven `channels.routing.*` / `channels.drafts.*` verbs, which spent a
 * release cataloged with `invokable: false` because their advertised paths were
 * served by nothing at all.
 *
 * Three things have to hold together, and any one of them alone is the defect
 * back again: the store behaves, the descriptors no longer claim to be
 * uncallable, and the advertised REST paths actually resolve.
 *
 * `channels.inbox.list` was the eighth, and it is served now too, by the host
 * that holds the provider credentials, from its synced mirror. What is asserted
 * here is the split: the flag is gone and the advertised path is routed, while
 * registering THESE handlers still attaches nothing for it, because an SDK-only
 * build has no mailbox to answer from.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { GATEWAY_REST_ROUTES } from '../packages/daemon-sdk/src/gateway-rest-routes.ts';
import {
  createDaemonSdkRouteProbe,
  reconcileHttpDescriptor,
} from '../packages/sdk/src/platform/control-plane/method-catalog-route-reconcile.ts';
import {
  CHANNEL_SYNC_METHOD_IDS,
  registerChannelSyncGatewayMethods,
} from '../packages/sdk/src/platform/control-plane/routes/channel-sync.ts';
import {
  ChannelSyncRegistry,
  ChannelSyncStore,
} from '../packages/sdk/src/platform/channel-sync/index.ts';
import { readGatewayVerbRefusal } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

let root: string;
let registry: ChannelSyncRegistry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'channel-sync-'));
  registry = new ChannelSyncRegistry(new ChannelSyncStore(join(root, 'channel-sync.json')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function invocation(body: Record<string, unknown>): GatewayMethodInvocation {
  return { methodId: 'test', body, context: {} } as unknown as GatewayMethodInvocation;
}

function catalogWithHandlers(): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerChannelSyncGatewayMethods(catalog, registry);
  return catalog;
}

describe('the routing table', () => {
  test('assigning the same channel twice replaces the rule rather than accumulating rows', async () => {
    await registry.assignRoute({ surfaceKind: 'Slack', channelId: 'C1', profileId: 'p1', label: 'first' });
    const second = await registry.assignRoute({ surfaceKind: 'slack', channelId: 'C1', profileId: 'p2' });

    const listed = await registry.listRoutes();
    expect(listed.total).toBe(1);
    expect(listed.routes[0]?.profileId).toBe('p2');
    // The created stamp survives the replacement; only updatedAt moves.
    expect(second.createdAt).toBe(listed.routes[0]!.createdAt);
  });

  test('a surface-wide rule and a channel-scoped one are different rows', async () => {
    await registry.assignRoute({ surfaceKind: 'slack', profileId: 'default' });
    await registry.assignRoute({ surfaceKind: 'slack', channelId: 'C1', profileId: 'special' });
    expect((await registry.listRoutes()).total).toBe(2);
  });

  test('filters narrow the rows and total still reports what matched', async () => {
    await registry.assignRoute({ surfaceKind: 'slack', channelId: 'a', profileId: 'p1' });
    await registry.assignRoute({ surfaceKind: 'slack', channelId: 'b', profileId: 'p1' });
    await registry.assignRoute({ surfaceKind: 'discord', channelId: 'c', profileId: 'p2' });

    expect((await registry.listRoutes({ surfaceKind: 'slack' })).total).toBe(2);
    expect((await registry.listRoutes({ profileId: 'p2' })).total).toBe(1);
    // A limited read still says how many there are, a screen that reported
    // the page size as the total would say "1 rule" about a table holding two.
    const limited = await registry.listRoutes({ surfaceKind: 'slack', limit: 1 });
    expect(limited.routes).toHaveLength(1);
    expect(limited.total).toBe(2);
  });

  test('deleting a rule that was already gone is an honest false, not a failure', async () => {
    expect(await registry.deleteRoute('slack:nope')).toBe(false);
    await registry.assignRoute({ surfaceKind: 'slack', channelId: 'C1', profileId: 'p1' });
    expect(await registry.deleteRoute('slack:C1')).toBe(true);
    expect((await registry.listRoutes()).total).toBe(0);
  });

  test('a rule survives a restart, because the point of mirroring it is the second device', async () => {
    await registry.assignRoute({ surfaceKind: 'slack', channelId: 'C1', profileId: 'p1' });
    const reopened = new ChannelSyncRegistry(new ChannelSyncStore(join(root, 'channel-sync.json')));
    expect((await reopened.listRoutes()).routes[0]?.profileId).toBe('p1');
  });
});

describe('the draft mirror', () => {
  const draft = {
    version: 1,
    id: 'd1',
    status: 'draft',
    message: 'hello there',
    title: 'a draft',
  };

  test('saving reports whether it created, so a device can tell its own sync from someone else\'s', async () => {
    expect((await registry.saveDraft({ ...draft })).created).toBe(true);
    expect((await registry.saveDraft({ ...draft, message: 'edited' })).created).toBe(false);
    const listed = await registry.listDrafts();
    expect(listed.total).toBe(1);
    expect(listed.drafts[0]?.message).toBe('edited');
  });

  test('an unknown draft reads as null, which the verb turns into a notFound marker', async () => {
    expect(await registry.getDraft('nope')).toBeNull();
  });

  // A webhook URL is a credential: anyone holding it can post to the channel.
  // The composing surface redacts before it sends, so a live value arriving
  // here means that redaction did not run, and this store syncs to every one
  // of the owner's machines.
  test('a live webhook URL is refused rather than mirrored', async () => {
    await expect(registry.saveDraft({ ...draft, webhook: 'https://hooks.slack.com/services/T/B/XXXX' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'webhook' });
    expect((await registry.listDrafts()).total).toBe(0);
  });

  test('a redacted webhook placeholder is stored as given', async () => {
    const saved = await registry.saveDraft({ ...draft, webhook: '••••••/T/B/XXXX' });
    expect(saved.draft.webhook).toBe('••••••/T/B/XXXX');
  });

  test('an unknown status is refused by name rather than stored', async () => {
    await expect(registry.saveDraft({ ...draft, status: 'whatever' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', field: 'status' });
  });

  test('status filters the list and total reports the matches', async () => {
    await registry.saveDraft({ ...draft, id: 'a', status: 'draft' });
    await registry.saveDraft({ ...draft, id: 'b', status: 'sent' });
    expect((await registry.listDrafts({ status: 'sent' })).total).toBe(1);
    expect((await registry.listDrafts()).total).toBe(2);
  });
});

describe('the verbs are callable, and say so', () => {
  test('every routing/drafts descriptor has dropped invokable:false', () => {
    const catalog = catalogWithHandlers();
    for (const id of CHANNEL_SYNC_METHOD_IDS) {
      expect(catalog.get(id), id).toBeDefined();
      expect(catalog.get(id)?.invokable, id).not.toBe(false);
      expect(catalog.hasHandler(id), id).toBe(true);
    }
  });

  test('each advertised REST path is in the gateway REST table and resolves', async () => {
    const probe = createDaemonSdkRouteProbe();
    const catalog = catalogWithHandlers();
    const tableIds = new Set(GATEWAY_REST_ROUTES.map((entry) => entry.methodId));
    for (const id of CHANNEL_SYNC_METHOD_IDS) {
      expect(tableIds.has(id), `${id} is missing from GATEWAY_REST_ROUTES`).toBe(true);
      const result = await reconcileHttpDescriptor(catalog.get(id)!, probe, (probed) => catalog.hasHandler(probed));
      expect(result.status, `${id}: ${result.reason}`).toBe('live');
    }
  });

  test('a handler refusal carries the field it is about', async () => {
    const catalog = catalogWithHandlers();
    let caught: unknown;
    try {
      await catalog.invoke('channels.routing.assign', invocation({ surfaceKind: 'slack' }));
    } catch (error) {
      caught = error;
    }
    const refusal = readGatewayVerbRefusal(caught);
    expect(refusal?.code).toBe('INVALID_ARGUMENT');
    expect(refusal?.field).toBe('profileId');
  });

  test('the assign verb answers with assignmentId, the name the delete verb takes', async () => {
    const catalog = catalogWithHandlers();
    const assigned = await catalog.invoke(
      'channels.routing.assign',
      invocation({ surfaceKind: 'slack', channelId: 'C1', profileId: 'p1' }),
    ) as { assignmentId: string };
    expect(assigned.assignmentId).toBe('slack:C1');
    const deleted = await catalog.invoke(
      'channels.routing.delete',
      invocation({ assignmentId: assigned.assignmentId }),
    ) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
  });

  test('a missing draft answers with the notFound marker the descriptor promises', async () => {
    const catalog = catalogWithHandlers();
    const answer = await catalog.invoke('channels.drafts.get', invocation({ draftId: 'nope' }));
    expect(answer).toEqual({ notFound: true });
  });

  // The eighth verb, and the last of this debt. It is served now, by the host
  // that holds the provider credentials, not by this module, so the flag is
  // gone and the path is in the table. What stays true is that registering the
  // routing/drafts handlers attaches no handler for it: an SDK-only build has
  // no mailbox, and the 501 it answers names the composition step that is
  // missing rather than pretending the verb does not exist.
  test('channels.inbox.list no longer claims to be uncallable, and its path is routed', () => {
    const catalog = catalogWithHandlers();
    expect(catalog.get('channels.inbox.list')?.invokable).not.toBe(false);
    expect(catalog.get('channels.inbox.list')?.http).toEqual({
      method: 'GET',
      path: '/api/channels/inbox',
    });
    const tableIds = new Set(GATEWAY_REST_ROUTES.map((entry) => entry.methodId));
    expect(tableIds.has('channels.inbox.list')).toBe(true);
    // Registering channel-sync attaches nothing for it; the host does that.
    expect(catalog.hasHandler('channels.inbox.list')).toBe(false);
  });
});
