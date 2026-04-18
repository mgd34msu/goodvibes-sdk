// Synced from packages/contracts/src/index.ts
import type {
  OperatorContractManifest,
  OperatorMethodContract,
  PeerContractManifest,
  PeerEndpointContract,
} from './types.js';
import { FOUNDATION_METADATA } from './generated/foundation-metadata.js';
import { OPERATOR_CONTRACT } from './generated/operator-contract.js';
import { OPERATOR_METHOD_IDS } from './generated/operator-method-ids.js';
import { PEER_CONTRACT } from './generated/peer-contract.js';
import { PEER_ENDPOINT_IDS } from './generated/peer-endpoint-ids.js';

export type {
  ContractHttpDefinition,
  JsonSchema,
  OperatorContractManifest,
  OperatorEventCoverageContract,
  OperatorEventContract,
  OperatorMethodContract,
  OperatorSchemaCoverageContract,
  PeerContractManifest,
  PeerEndpointContract,
} from './types.js';
export { FOUNDATION_METADATA } from './generated/foundation-metadata.js';
export type {
  OperatorEventPayload,
  OperatorEventPayloadMap,
  OperatorMethodInput,
  OperatorMethodInputMap,
  OperatorMethodOutput,
  OperatorMethodOutputMap,
  OperatorStreamMethodId,
  OperatorTypedEventId,
  OperatorTypedMethodId,
  PeerEndpointInput,
  PeerEndpointInputMap,
  PeerEndpointOutput,
  PeerEndpointOutputMap,
  PeerTypedEndpointId,
  RuntimeDomainEventPayload,
  RuntimeDomainEventPayloadMap,
  RuntimeDomainEventType,
  RuntimeEventTypedDomain,
} from './generated/foundation-client-types.js';
export { OPERATOR_CONTRACT } from './generated/operator-contract.js';
export { OPERATOR_METHOD_IDS } from './generated/operator-method-ids.js';
export type { OperatorMethodId } from './generated/operator-method-ids.js';
export { PEER_CONTRACT } from './generated/peer-contract.js';
export { PEER_ENDPOINT_IDS } from './generated/peer-endpoint-ids.js';
export type { PeerEndpointId } from './generated/peer-endpoint-ids.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './generated/runtime-event-domains.js';
export type { RuntimeEventDomain } from './generated/runtime-event-domains.js';

export function getOperatorContract(): OperatorContractManifest {
  return OPERATOR_CONTRACT;
}

export function getPeerContract(): PeerContractManifest {
  return PEER_CONTRACT;
}

export function getOperatorMethod(methodId: string): OperatorMethodContract | undefined {
  return getOperatorContract().operator.methods.find((method) => method.id === methodId);
}

export function getPeerEndpoint(endpointId: string): PeerEndpointContract | undefined {
  return getPeerContract().endpoints.find((endpoint) => endpoint.id === endpointId);
}

export function listOperatorMethods(): readonly OperatorMethodContract[] {
  return getOperatorContract().operator.methods;
}

export function listPeerEndpoints(): readonly PeerEndpointContract[] {
  return getPeerContract().endpoints;
}

export function isOperatorMethodId(value: string): value is (typeof OPERATOR_METHOD_IDS)[number] {
  return (OPERATOR_METHOD_IDS as readonly string[]).includes(value);
}

export function isPeerEndpointId(value: string): value is (typeof PEER_ENDPOINT_IDS)[number] {
  return (PEER_ENDPOINT_IDS as readonly string[]).includes(value);
}



// Re-export Zod schemas + inferred shapes for runtime validation.
export * from './zod-schemas/index.js';
