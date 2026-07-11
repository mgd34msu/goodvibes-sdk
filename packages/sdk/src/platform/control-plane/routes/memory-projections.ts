/**
 * routes/memory-projections.ts
 *
 * Handlers for memory.projections.list + memory.projections.get over the
 * daemon's canonical MemoryRegistry. A read-only view that projects standing
 * (project/team-scope) memory records to their markdown form — the same
 * projection the file-projection surface writes, computed live from the store
 * rather than read from disk so it always matches the current records.
 *
 * Registered from register-gateway-verb-groups.ts alongside the other gateway
 * verb groups. Missing descriptor is a silent no-op (graceful degrade for a
 * minimal embed), exactly like the cost/skills groups.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { MemoryRecord } from '../../state/memory-store.js';
import { listMemoryProjections, getMemoryProjection } from '../../state/memory-file-projection.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The read surface memory projection needs: every standing/session record in the store. */
export interface MemoryProjectionSource {
  getAll(): readonly MemoryRecord[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

export function createMemoryProjectionsListHandler(source: MemoryProjectionSource): GatewayMethodHandler {
  return async () => ({ projections: listMemoryProjections(source.getAll()) });
}

export function createMemoryProjectionsGetHandler(source: MemoryProjectionSource): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = requireString(params.id, 'id');
    const projection = getMemoryProjection(source.getAll(), id);
    if (!projection) {
      throw new GatewayVerbError(`No standing memory projection with id: ${id}`, 'NOT_FOUND', 404);
    }
    return { projection: projection.entry, markdown: projection.markdown };
  };
}

/** Attach the memory.projections.list + memory.projections.get handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerMemoryProjectionsGatewayMethods(catalog: GatewayMethodCatalog, source: MemoryProjectionSource): void {
  const listDescriptor = catalog.get('memory.projections.list');
  if (listDescriptor) catalog.register(listDescriptor, createMemoryProjectionsListHandler(source), { replace: true });

  const getDescriptor = catalog.get('memory.projections.get');
  if (getDescriptor) catalog.register(getDescriptor, createMemoryProjectionsGetHandler(source), { replace: true });
}
