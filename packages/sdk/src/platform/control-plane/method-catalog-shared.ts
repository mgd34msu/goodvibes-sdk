import type { RuntimeEventDomain } from '../runtime/events/index.js';

export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';

export interface GatewayHttpBinding {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface GatewayMethodDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: GatewayHttpBinding | undefined;
  readonly events?: readonly string[] | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly pluginId?: string | undefined;
  readonly dangerous?: boolean | undefined;
  readonly invokable?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayEventDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly wireEvents?: readonly string[] | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly pluginId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayMethodInvocationContext {
  readonly principalId?: string | undefined;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly clientKind?: string | undefined;
  readonly authToken?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface GatewayMethodInvocation {
  readonly body?: unknown | undefined;
  readonly query?: Record<string, unknown> | undefined;
  readonly context: GatewayMethodInvocationContext;
}

export type GatewayMethodHandler = (input: GatewayMethodInvocation) => unknown | Promise<unknown>;
export interface GatewayMethodListOptions {
  readonly category?: string | undefined;
  readonly source?: GatewayMethodSource | undefined;
  readonly pluginId?: string | undefined;
}

export interface GatewayEventListOptions {
  readonly category?: string | undefined;
  readonly source?: GatewayMethodSource | undefined;
  readonly pluginId?: string | undefined;
  readonly domain?: RuntimeEventDomain | undefined;
}

export const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
export const STRING_SCHEMA = { type: 'string' } as const;
export const BOOLEAN_SCHEMA = { type: 'boolean' } as const;
export const NUMBER_SCHEMA = { type: 'number' } as const;
const NULL_SCHEMA = { type: 'null' } as const;
export const JSON_VALUE_SCHEMA: Record<string, unknown> = {};
export const JSON_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: JSON_VALUE_SCHEMA,
};
export const JSON_ARRAY_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: JSON_VALUE_SCHEMA,
};

Object.assign(JSON_VALUE_SCHEMA, {
  anyOf: [
    STRING_SCHEMA,
    NUMBER_SCHEMA,
    BOOLEAN_SCHEMA,
    NULL_SCHEMA,
    JSON_OBJECT_SCHEMA,
    JSON_ARRAY_SCHEMA,
  ],
});

export function arraySchema(itemSchema: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items: itemSchema };
}

export function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[] = [],
  options: { readonly additionalProperties?: boolean } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: options.additionalProperties ?? false,
  };
}

export const GATEWAY_HTTP_BINDING_SCHEMA = objectSchema({
  method: STRING_SCHEMA,
  path: STRING_SCHEMA,
}, ['method', 'path']);

export const METHOD_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  category: STRING_SCHEMA,
  source: STRING_SCHEMA,
  access: STRING_SCHEMA,
  transport: arraySchema(STRING_SCHEMA),
  scopes: arraySchema(STRING_SCHEMA),
  http: GATEWAY_HTTP_BINDING_SCHEMA,
  events: arraySchema(STRING_SCHEMA),
  inputSchema: JSON_OBJECT_SCHEMA,
  outputSchema: JSON_OBJECT_SCHEMA,
  pluginId: STRING_SCHEMA,
  dangerous: BOOLEAN_SCHEMA,
  invokable: BOOLEAN_SCHEMA,
  metadata: JSON_OBJECT_SCHEMA,
}, ['id', 'title', 'description', 'category', 'source', 'access', 'transport', 'scopes']);

export const EVENT_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  category: STRING_SCHEMA,
  source: STRING_SCHEMA,
  transport: arraySchema(STRING_SCHEMA),
  scopes: arraySchema(STRING_SCHEMA),
  domains: arraySchema(STRING_SCHEMA),
  wireEvents: arraySchema(STRING_SCHEMA),
  outputSchema: JSON_OBJECT_SCHEMA,
  pluginId: STRING_SCHEMA,
  metadata: JSON_OBJECT_SCHEMA,
}, ['id', 'title', 'description', 'category', 'source', 'transport', 'scopes']);

export function listOutputSchema(
  key: string,
  itemSchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({ [key]: arraySchema(itemSchema) }, [key], { additionalProperties: false });
}

export function entityOutputSchema(
  key: string,
  entitySchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({ [key]: entitySchema }, [key], { additionalProperties: false });
}

export function actionResultOutputSchema(
  key: string,
  entitySchema: Record<string, unknown>,
): Record<string, unknown> {
  return objectSchema({
    [key]: entitySchema,
  }, [key], { additionalProperties: true });
}

export function bodyEnvelopeSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: readonly string[] = [],
): Record<string, unknown> {
  return objectSchema({
    ...properties,
  }, required, { additionalProperties: true });
}

export function methodDescriptor(input: Omit<GatewayMethodDescriptor, 'source' | 'transport' | 'access'> & Partial<Pick<GatewayMethodDescriptor, 'source' | 'transport' | 'access'>>): GatewayMethodDescriptor {
  return {
    source: input.source ?? 'builtin',
    transport: input.transport ?? ['http', 'ws'],
    access: input.access ?? 'authenticated',
    ...input,
  };
}

export function eventDescriptor(input: Omit<GatewayEventDescriptor, 'source'> & Partial<Pick<GatewayEventDescriptor, 'source'>>): GatewayEventDescriptor {
  return {
    source: input.source ?? 'builtin',
    ...input,
  };
}

export function runtimeEventId(domain: RuntimeEventDomain): string {
  return `runtime.${domain}`;
}

export function runtimeDomainEvent(domain: RuntimeEventDomain, description: string): GatewayEventDescriptor {
  return eventDescriptor({
    id: runtimeEventId(domain),
    title: `${domain} Domain Events`,
    description,
    category: 'runtime-domain',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    domains: [domain],
    wireEvents: [domain],
    outputSchema: JSON_OBJECT_SCHEMA,
  });
}
