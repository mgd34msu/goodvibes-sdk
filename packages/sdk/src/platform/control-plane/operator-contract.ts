import type { GatewayEventDescriptor, GatewayMethodCatalog, GatewayMethodDescriptor } from './method-catalog.js';
import { getOperatorContract } from '@pellux/goodvibes-contracts';
import type { OperatorEventContract, OperatorMethodContract } from '../types/foundation-contract.js';
import {
  BOOLEAN_SCHEMA,
  METHOD_DESCRIPTOR_SCHEMA,
  EVENT_DESCRIPTOR_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import {
  CONTROL_AUTH_CURRENT_RESPONSE_SCHEMA,
  CONTROL_AUTH_LOGIN_REQUEST_SCHEMA,
  CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA,
} from './operator-contract-schemas.js';
import type { OperatorContractManifest } from '../types/foundation-contract.js';
import { VERSION } from '../version.js';
import { OPERATOR_SESSION_COOKIE_NAME } from '../security/http-auth.js';

const OPERATOR_CONTRACT_VERSION = 1;
const OPERATOR_WS_PATH = '/api/control-plane/ws';
const OPERATOR_EVENTS_PATH = '/api/control-plane/events';
const OPERATOR_METHODS_PATH = '/api/control-plane/methods';
const OPERATOR_EVENTS_CATALOG_PATH = '/api/control-plane/events/catalog';
const OPERATOR_AUTH_CURRENT_PATH = '/api/control-plane/auth';
const PEER_CONTRACT_PATH = '/api/remote/node-host/contract';

export type { OperatorContractManifest } from '../types/foundation-contract.js';

interface OperatorSchemaCoverage {
  readonly methods: number;
  readonly typedInputs: number;
  readonly genericInputs: number;
  readonly typedOutputs: number;
  readonly genericOutputs: number;
}

interface OperatorEventCoverage {
  readonly events: number;
  readonly withDomains: number;
  readonly withWireEvents: number;
}

const OPERATOR_CONTRACT_FRAME_SCHEMA = objectSchema({
  type: STRING_SCHEMA,
  fields: arraySchema(STRING_SCHEMA),
}, ['type']);

export const OPERATOR_CONTRACT_SCHEMA = objectSchema({
  version: NUMBER_SCHEMA,
  product: objectSchema({
    id: STRING_SCHEMA,
    surface: STRING_SCHEMA,
    version: STRING_SCHEMA,
  }, ['id', 'surface', 'version']),
  auth: objectSchema({
    modes: arraySchema(STRING_SCHEMA),
    login: objectSchema({
      method: STRING_SCHEMA,
      path: STRING_SCHEMA,
      requestSchema: CONTROL_AUTH_LOGIN_REQUEST_SCHEMA,
      responseSchema: CONTROL_AUTH_LOGIN_RESPONSE_SCHEMA,
    }, ['method', 'path', 'requestSchema', 'responseSchema']),
    current: objectSchema({
      method: STRING_SCHEMA,
      path: STRING_SCHEMA,
      aliasPaths: arraySchema(STRING_SCHEMA),
      responseSchema: CONTROL_AUTH_CURRENT_RESPONSE_SCHEMA,
    }, ['method', 'path', 'responseSchema']),
    sessionCookie: objectSchema({
      name: STRING_SCHEMA,
      httpOnly: BOOLEAN_SCHEMA,
      sameSite: STRING_SCHEMA,
      path: STRING_SCHEMA,
    }, ['name', 'httpOnly', 'sameSite', 'path']),
    bearer: objectSchema({
      header: STRING_SCHEMA,
      queryParameters: arraySchema(STRING_SCHEMA),
    }, ['header', 'queryParameters']),
  }, ['modes', 'login', 'current', 'sessionCookie', 'bearer']),
  transports: objectSchema({
    http: objectSchema({
      statusPath: STRING_SCHEMA,
      methodsPath: STRING_SCHEMA,
      eventsCatalogPath: STRING_SCHEMA,
    }, ['statusPath', 'methodsPath', 'eventsCatalogPath']),
    sse: objectSchema({
      path: STRING_SCHEMA,
      query: objectSchema({
        domains: STRING_SCHEMA,
      }, ['domains']),
    }, ['path', 'query']),
    websocket: objectSchema({
      path: STRING_SCHEMA,
      clientFrames: arraySchema(OPERATOR_CONTRACT_FRAME_SCHEMA),
      serverFrames: arraySchema(OPERATOR_CONTRACT_FRAME_SCHEMA),
    }, ['path', 'clientFrames', 'serverFrames']),
  }, ['http', 'sse', 'websocket']),
  operator: objectSchema({
    methods: arraySchema(METHOD_DESCRIPTOR_SCHEMA),
    events: arraySchema(EVENT_DESCRIPTOR_SCHEMA),
    schemaCoverage: objectSchema({
      methods: NUMBER_SCHEMA,
      typedInputs: NUMBER_SCHEMA,
      genericInputs: NUMBER_SCHEMA,
      typedOutputs: NUMBER_SCHEMA,
      genericOutputs: NUMBER_SCHEMA,
    }, ['methods', 'typedInputs', 'genericInputs', 'typedOutputs', 'genericOutputs']),
    eventCoverage: objectSchema({
      events: NUMBER_SCHEMA,
      withDomains: NUMBER_SCHEMA,
      withWireEvents: NUMBER_SCHEMA,
    }, ['events', 'withDomains', 'withWireEvents']),
  }, ['methods', 'events', 'schemaCoverage', 'eventCoverage']),
  peer: objectSchema({
    contractPath: STRING_SCHEMA,
    relationship: STRING_SCHEMA,
  }, ['contractPath', 'relationship']),
}, ['version', 'product', 'auth', 'transports', 'operator', 'peer']);

function isGenericObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && schema.type === 'object' && !Object.hasOwn(schema, 'properties'));
}

function summarizeSchemaCoverage(methods: readonly GatewayMethodDescriptor[]): OperatorSchemaCoverage {
  let genericInputs = 0;
  let genericOutputs = 0;
  for (const method of methods) {
    if (isGenericObjectSchema(method.inputSchema)) genericInputs += 1;
    if (isGenericObjectSchema(method.outputSchema)) genericOutputs += 1;
  }
  return {
    methods: methods.length,
    typedInputs: methods.length - genericInputs,
    genericInputs,
    typedOutputs: methods.length - genericOutputs,
    genericOutputs,
  };
}

function summarizeEventCoverage(events: readonly GatewayEventDescriptor[]): OperatorEventCoverage {
  return {
    events: events.length,
    withDomains: events.filter((event) => (event.domains?.length ?? 0) > 0).length,
    withWireEvents: events.filter((event) => (event.wireEvents?.length ?? 0) > 0).length,
  };
}

function toMethodContract(d: GatewayMethodDescriptor): OperatorMethodContract {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    source: d.source,
    access: d.access,
    transport: d.transport,
    scopes: d.scopes,
    ...(d.http ? { http: d.http } : {}),
    ...(d.events ? { events: d.events } : {}),
    ...(d.inputSchema ? { inputSchema: d.inputSchema } : {}),
    ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
    ...(d.pluginId !== undefined ? { pluginId: d.pluginId } : {}),
    ...(d.dangerous !== undefined ? { dangerous: d.dangerous } : {}),
    ...(d.invokable !== undefined ? { invokable: d.invokable } : {}),
    ...(d.metadata ? { metadata: d.metadata } : {}),
  };
}

function toEventContract(d: GatewayEventDescriptor): OperatorEventContract {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    source: d.source,
    transport: d.transport,
    scopes: d.scopes,
    ...(d.domains ? { domains: d.domains } : {}),
    ...(d.wireEvents ? { wireEvents: d.wireEvents } : {}),
    ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
    ...(d.pluginId !== undefined ? { pluginId: d.pluginId } : {}),
    ...(d.metadata ? { metadata: d.metadata } : {}),
  };
}

export function buildOperatorContract(catalog: GatewayMethodCatalog): OperatorContractManifest {
  const contract = getOperatorContract();
  const methods = catalog.list().map(toMethodContract);
  const events = catalog.listEvents().map(toEventContract);
  return {
    ...contract,
    product: {
      ...contract.product,
      version: VERSION,
    },
    auth: {
      ...contract.auth,
      current: {
        ...contract.auth.current,
        aliasPaths: ['/api/control-plane/whoami'],
      },
    },
    operator: {
      ...contract.operator,
      methods,
      events,
      schemaCoverage: summarizeSchemaCoverage(catalog.list()),
      eventCoverage: summarizeEventCoverage(catalog.listEvents()),
    },
  };
}
