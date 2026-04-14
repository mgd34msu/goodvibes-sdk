// Synced from goodvibes-tui/src/runtime/transports/direct-client.ts
import { createClientTransport, type ClientTransport } from '@pellux/goodvibes-transport-core';

export type DirectClientTransport<TOperator, TPeer> = ClientTransport<'direct', TOperator, TPeer>;

export function createDirectClientTransport<TOperator, TPeer>(
  operator: TOperator,
  peer: TPeer,
): DirectClientTransport<TOperator, TPeer> {
  return createClientTransport('direct', operator, peer);
}
