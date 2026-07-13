/**
 * routes/pairing.ts
 *
 * Handlers for the `pairing.tokens.*` verbs over the PairingTokenManager. Thin
 * verb registration in the same `catalog.register(descriptor, handler)` pattern
 * push.* / fleet.* use, reached through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
 *
 * These verbs manage the daemon's own paired-device tokens, so they require an
 * authenticated operator principal (the invoke layer already gates on the
 * write:/read:control-plane scopes the descriptors declare); the secret is
 * returned only by mint/migrate, and only once.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PairingTokenManager } from '../../pairing/pairing-token-store.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The narrow slice of PairingTokenManager these verbs need. */
export type PairingGatewayService = Pick<
  PairingTokenManager,
  'list' | 'mint' | 'mintForMigration' | 'rename' | 'revoke' | 'isLegacyRevoked' | 'revokeLegacyShared'
>;

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Pairing verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`Missing or invalid ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function createListHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    return { tokens: service.list(), legacySharedRevoked: service.isLegacyRevoked() };
  };
}

function createMintHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    return { token: service.mint({ name }) };
  };
}

function createMigrateHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireString(params.name, 'name');
    return { token: service.mintForMigration({ name }) };
  };
}

function createRenameHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const id = requireString(params.id, 'id');
    const name = requireString(params.name, 'name');
    if (!service.rename(id, name)) {
      throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    }
    return { id, renamed: true };
  };
}

function createRevokeHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const id = requireString(params.id, 'id');
    if (!service.revoke(id)) {
      throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    }
    return { id, revoked: true };
  };
}

function createRevokeSharedHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    service.revokeLegacyShared();
    return { legacySharedRevoked: true };
  };
}

const PAIRING_HANDLER_FACTORIES: Readonly<Record<string, (service: PairingGatewayService) => GatewayMethodHandler>> = {
  'pairing.tokens.list': createListHandler,
  'pairing.tokens.create': createMintHandler,
  'pairing.tokens.migrate': createMigrateHandler,
  'pairing.tokens.rename': createRenameHandler,
  'pairing.tokens.delete': createRevokeHandler,
  'pairing.tokens.revokeShared': createRevokeSharedHandler,
};

/**
 * Attach the `pairing.tokens.*` handlers to their cataloged descriptors. A
 * missing descriptor is a silent no-op rather than a throw — construction must
 * never fail because one verb failed to register; the operator-contract gates
 * catch a real drift.
 */
export function registerPairingGatewayMethods(catalog: GatewayMethodCatalog, service: PairingGatewayService): void {
  for (const [methodId, factory] of Object.entries(PAIRING_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(service), { replace: true });
    }
  }
}
