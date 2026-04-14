// Synced from packages/transport-direct/src/index.ts
// Extracted from legacy source: src/runtime/transports/direct-client.ts
import { createClientTransport, type ClientTransport } from '../transport-core/index.js';

export type DirectClientTransport<TOperator, TPeer> = ClientTransport<'direct', TOperator, TPeer>;

export function createDirectClientTransport<TOperator, TPeer>(
  operator: TOperator,
  peer: TPeer,
): DirectClientTransport<TOperator, TPeer> {
  return createClientTransport('direct', operator, peer);
}
