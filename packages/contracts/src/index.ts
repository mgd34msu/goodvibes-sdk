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

// MIN-1: Lazy-init maps so tree-shake-conscious bundles that only need
// OPERATOR_METHOD_IDS / PEER_ENDPOINT_IDS don't pay the map-construction cost.
let _operatorMethodsById: Map<string, OperatorMethodContract> | undefined;
let _peerEndpointsById: Map<string, PeerEndpointContract> | undefined;

function getOperatorMethodsById(): Map<string, OperatorMethodContract> {
  if (!_operatorMethodsById) {
    _operatorMethodsById = new Map(OPERATOR_CONTRACT.operator.methods.map((method) => [method.id, method]));
  }
  return _operatorMethodsById;
}

function getPeerEndpointsById(): Map<string, PeerEndpointContract> {
  if (!_peerEndpointsById) {
    _peerEndpointsById = new Map(PEER_CONTRACT.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  }
  return _peerEndpointsById;
}

// MIN-2: Precomputed Sets for O(1) membership tests. Also lazy.
let _operatorMethodIdSet: Set<string> | undefined;
let _peerEndpointIdSet: Set<string> | undefined;

function getOperatorMethodIdSet(): Set<string> {
  if (!_operatorMethodIdSet) {
    _operatorMethodIdSet = new Set(OPERATOR_METHOD_IDS as readonly string[]);
  }
  return _operatorMethodIdSet;
}

function getPeerEndpointIdSet(): Set<string> {
  if (!_peerEndpointIdSet) {
    _peerEndpointIdSet = new Set(PEER_ENDPOINT_IDS as readonly string[]);
  }
  return _peerEndpointIdSet;
}

export function getOperatorMethod(methodId: string): OperatorMethodContract | undefined {
  return getOperatorMethodsById().get(methodId);
}

export function getPeerEndpoint(endpointId: string): PeerEndpointContract | undefined {
  return getPeerEndpointsById().get(endpointId);
}

export function listOperatorMethods(): readonly OperatorMethodContract[] {
  return getOperatorContract().operator.methods;
}

export function listPeerEndpoints(): readonly PeerEndpointContract[] {
  return getPeerContract().endpoints;
}

export function isOperatorMethodId(value: string): value is (typeof OPERATOR_METHOD_IDS)[number] {
  // MIN-2: O(1) Set lookup instead of O(n) linear .includes over the readonly tuple.
  return getOperatorMethodIdSet().has(value);
}

export function isPeerEndpointId(value: string): value is (typeof PEER_ENDPOINT_IDS)[number] {
  // MIN-2: O(1) Set lookup instead of O(n) linear .includes over the readonly tuple.
  return getPeerEndpointIdSet().has(value);
}

// Re-export Zod schemas + inferred shapes for runtime validation.
export * from './zod-schemas/index.js';
