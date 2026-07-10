/**
 * routes/principals.ts
 *
 * Handlers for the principals.* gateway verbs over the PrincipalRegistry
 * (../../principals). Thin verb registration: each handler reads the invocation
 * params, calls the registry, and maps a PrincipalRegistryError to an honest
 * wire status (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404, ALREADY_EXISTS -> 409,
 * CONFLICT -> 409).
 *
 * Wired via GatewayMethodCatalog.register(descriptor, handler) against
 * descriptors already cataloged (without a handler) from
 * ../method-catalog-principals.ts — the same mechanism skills.* / fleet.* use.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import {
  PrincipalRegistry,
  PrincipalRegistryError,
  type PrincipalIdentity,
  type PrincipalKind,
} from '../../principals/index.js';

export type PrincipalsGatewayService = Pick<
  PrincipalRegistry,
  'list' | 'get' | 'create' | 'update' | 'delete' | 'resolveByIdentity'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof PrincipalRegistryError) {
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

/** Coerce the wire `identities` array into typed identity pairs (strings only). */
function readIdentities(value: unknown): PrincipalIdentity[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new GatewayVerbError('identities must be an array', 'INVALID_ARGUMENT', 400);
  }
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new GatewayVerbError(`identities[${index}] must be an object`, 'INVALID_ARGUMENT', 400);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.channel !== 'string' || typeof entry.value !== 'string') {
      throw new GatewayVerbError(`identities[${index}] needs string channel and value`, 'INVALID_ARGUMENT', 400);
    }
    return { channel: entry.channel, value: entry.value };
  });
}

/** Coerce an untyped wire value into a JSON metadata object, or undefined. */
function readMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError('metadata must be an object', 'INVALID_ARGUMENT', 400);
  }
  return value as Record<string, unknown>;
}

function createListHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async () => ({ principals: await service.list() });
}

function createGetHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const principalId = requireString(params.principalId, 'principalId');
    try {
      return { principal: await service.get(principalId) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createCreateHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const principal = await service.create({
        name: requireString(params.name, 'name'),
        kind: requireString(params.kind, 'kind') as PrincipalKind,
        identities: readIdentities(params.identities),
        metadata: readMetadata(params.metadata),
      });
      return { principal };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createUpdateHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const principalId = requireString(params.principalId, 'principalId');
    try {
      const principal = await service.update(principalId, {
        name: typeof params.name === 'string' ? params.name : undefined,
        kind: typeof params.kind === 'string' ? (params.kind as PrincipalKind) : undefined,
        identities: readIdentities(params.identities),
        metadata: readMetadata(params.metadata),
      });
      return { principal };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDeleteHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const principalId = requireString(params.principalId, 'principalId');
    try {
      return { principalId, deleted: await service.delete(principalId) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createResolveHandler(service: PrincipalsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const channel = requireString(params.channel, 'channel');
    const value = requireString(params.value, 'value');
    try {
      return await service.resolveByIdentity({ channel, value });
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

export function registerPrincipalsGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: PrincipalsGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('principals.list', createListHandler(service));
  attach('principals.get', createGetHandler(service));
  attach('principals.create', createCreateHandler(service));
  attach('principals.update', createUpdateHandler(service));
  attach('principals.delete', createDeleteHandler(service));
  attach('principals.resolve', createResolveHandler(service));
}
