/**
 * routes/channel-sync.ts, the handlers behind `channels.routing.*` and
 * `channels.drafts.*`.
 *
 * These seven verbs were cataloged by an audit that found the paths advertised
 * and unserved, and were marked `invokable: false` so the contract said
 * "cataloged, not callable" instead of letting a caller discover a 404. The
 * store behind them now exists (platform/channel-sync), so the flag comes off
 * and the advertised REST paths resolve, through the same gateway REST table
 * `channels.profiles.*` uses, so the plain-REST path and the methodId-invoke
 * endpoint reach one handler rather than two implementations of one idea.
 *
 * `channels.inbox.list` is not here either, and for a reason that outlived the
 * other seven: its answer needs the provider credentials and the synced mirror
 * behind them, which live in the host, not in this SDK. It is no longer marked
 * `invokable: false`, the host attaches a handler over the catalog descriptor
 * and its advertised path is in the gateway REST table with these, but the
 * handler is composed there rather than registered here. A build with no inbox
 * composition answers 501 NOT_INVOKABLE naming the missing step, which is the
 * honest answer for a process that holds no mailbox.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { ChannelSyncError, type ChannelSyncRegistry } from '../../channel-sync/index.js';

export type ChannelSyncGatewayService = Pick<
  ChannelSyncRegistry,
  'listRoutes' | 'assignRoute' | 'deleteRoute' | 'listDrafts' | 'getDraft' | 'saveDraft' | 'deleteDraft'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof ChannelSyncError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400, error.field);
  }
  throw error;
}

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new GatewayVerbError(`Invalid ${field}: expected a string`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.trim() || undefined;
}

function optionalLimit(params: Record<string, unknown>): number | undefined {
  const value = params.limit;
  if (value === undefined || value === null) return undefined;
  const limit = typeof value === 'string' ? Number(value) : value;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new GatewayVerbError('Invalid limit: expected a positive number', 'INVALID_ARGUMENT', 400, 'limit');
  }
  return Math.floor(limit);
}

function createRoutingListHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = optionalString(params, 'surfaceKind');
    const profileId = optionalString(params, 'profileId');
    const limit = optionalLimit(params);
    try {
      return await service.listRoutes({
        ...(surfaceKind === undefined ? {} : { surfaceKind }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(limit === undefined ? {} : { limit }),
      });
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createRoutingAssignHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const channelId = optionalString(params, 'channelId');
    const routeId = optionalString(params, 'routeId');
    const label = optionalString(params, 'label');
    try {
      const rule = await service.assignRoute({
        surfaceKind: requireString(params, 'surfaceKind'),
        profileId: requireString(params, 'profileId'),
        ...(channelId === undefined ? {} : { channelId }),
        ...(routeId === undefined ? {} : { routeId }),
        ...(label === undefined ? {} : { label }),
      });
      // `assignmentId` on the wire is the rule's own id: one name for the
      // caller, one for the record, and never two different values.
      const { id, ...rest } = rule;
      return { assignmentId: id, ...rest };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createRoutingDeleteHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const assignmentId = requireString(params, 'assignmentId');
    try {
      // An honest boolean rather than a 404: a caller removing a rule that was
      // already gone has got what it asked for, and reporting failure invites a
      // retry that can never succeed.
      return { deleted: await service.deleteRoute(assignmentId), assignmentId };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDraftsListHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const status = optionalString(params, 'status');
    const limit = optionalLimit(params);
    try {
      return await service.listDrafts({
        ...(status === undefined ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
      });
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDraftsGetHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const draftId = requireString(params, 'draftId');
    try {
      // A notFound MARKER, not a 404, because the descriptor says so: a device
      // syncing a draft list asks about ids it may have deleted elsewhere, and
      // an error status for each one turns an ordinary sync into a failure.
      return (await service.getDraft(draftId)) ?? { notFound: true };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDraftsSaveHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      return await service.saveDraft(params);
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDraftsDeleteHandler(service: ChannelSyncGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const draftId = requireString(params, 'draftId');
    try {
      return { deleted: await service.deleteDraft(draftId), draftId };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

/** Every verb this module owns, in the order the catalog lists them. */
export const CHANNEL_SYNC_METHOD_IDS: readonly string[] = [
  'channels.routing.list',
  'channels.routing.assign',
  'channels.routing.delete',
  'channels.drafts.list',
  'channels.drafts.get',
  'channels.drafts.save',
  'channels.drafts.delete',
];

export function registerChannelSyncGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: ChannelSyncGatewayService,
): void {
  const handlers: Readonly<Record<string, GatewayMethodHandler>> = {
    'channels.routing.list': createRoutingListHandler(service),
    'channels.routing.assign': createRoutingAssignHandler(service),
    'channels.routing.delete': createRoutingDeleteHandler(service),
    'channels.drafts.list': createDraftsListHandler(service),
    'channels.drafts.get': createDraftsGetHandler(service),
    'channels.drafts.save': createDraftsSaveHandler(service),
    'channels.drafts.delete': createDraftsDeleteHandler(service),
  };
  for (const id of CHANNEL_SYNC_METHOD_IDS) {
    const descriptor = catalog.get(id);
    const handler = handlers[id];
    if (!descriptor || !handler) continue;
    // A registered handler is the authority on whether a verb works, so the
    // audit-era `invokable: false` comes off with the handler going on.
    const invokable = descriptor.invokable === false ? { ...descriptor, invokable: true } : descriptor;
    catalog.register(invokable, handler, { replace: true });
  }
}
