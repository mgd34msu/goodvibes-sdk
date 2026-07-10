/**
 * routes/channel-profiles.ts
 *
 * Handlers for the channels.profiles.* verbs over the ChannelProfileRegistry
 * (../../channel-profiles). Thin verb registration: read the invocation params,
 * call the registry, map a ChannelProfileError to an honest wire status
 * (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import {
  ChannelProfileError,
  ChannelProfileRegistry,
  type ChannelPermissionMode,
} from '../../channel-profiles/index.js';

export type ChannelProfilesGatewayService = Pick<
  ChannelProfileRegistry,
  'list' | 'get' | 'set' | 'delete'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof ChannelProfileError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError('metadata must be an object', 'INVALID_ARGUMENT', 400);
  }
  return value as Record<string, unknown>;
}

function createListHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async () => ({ bindings: await service.list() });
}

function createGetHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = requireString(params.surfaceKind, 'surfaceKind');
    try {
      return { binding: await service.get(surfaceKind, optionalString(params.channelId)) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSetHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const binding = await service.set({
        surfaceKind: requireString(params.surfaceKind, 'surfaceKind'),
        channelId: optionalString(params.channelId),
        model: optionalString(params.model),
        provider: optionalString(params.provider),
        permissionMode: optionalString(params.permissionMode) as ChannelPermissionMode | undefined,
        metadata: readMetadata(params.metadata),
      });
      return { binding };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDeleteHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = requireString(params.surfaceKind, 'surfaceKind');
    const channelId = optionalString(params.channelId);
    try {
      const deleted = await service.delete(surfaceKind, channelId);
      return { surfaceKind, ...(channelId ? { channelId } : {}), deleted };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

export function registerChannelProfilesGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: ChannelProfilesGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('channels.profiles.list', createListHandler(service));
  attach('channels.profiles.get', createGetHandler(service));
  attach('channels.profiles.set', createSetHandler(service));
  attach('channels.profiles.delete', createDeleteHandler(service));
}
