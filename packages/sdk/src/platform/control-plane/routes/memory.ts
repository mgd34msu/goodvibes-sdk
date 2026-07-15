/**
 * routes/memory.ts — handler for the ops.memory.get observability verb over the
 * live MemoryGovernor (see runtime/memory/memory-governor.ts for the policy).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { MemoryGovernor } from '../../runtime/memory/index.js';

/** The narrow MemoryGovernor slice the verb needs. */
export type MemoryGatewayService = Pick<MemoryGovernor, 'snapshot'>;

export function createMemoryStatusHandler(service: MemoryGatewayService): GatewayMethodHandler {
  return () => service.snapshot();
}

/** Attach the memory handler to its registered descriptor (missing = no-op). */
export function registerMemoryGatewayMethods(catalog: GatewayMethodCatalog, service: MemoryGatewayService): void {
  const descriptor = catalog.get('ops.memory.get');
  if (descriptor) catalog.register(descriptor, createMemoryStatusHandler(service), { replace: true });
}
