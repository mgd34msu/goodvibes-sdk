/**
 * method-catalog-principals.ts
 *
 * Contract descriptors for the cross-channel principal identity registry
 * (principals.list / get / create / update / delete / resolve). These expose
 * the daemon's PrincipalRegistry (../../principals) over the operator surface so
 * channel intake and any consumer can map a channel-specific sender identity
 * (a Slack user id, an email address, a phone number) onto one named principal.
 *
 * Descriptors live here (static) so buildOperatorContract / api.md / the
 * generated contract artifacts see them whether or not a handler has been
 * attached yet; routes/principals.ts attaches the handlers at RuntimeServices
 * construction time. This mirrors the skills.* / fleet.* descriptor/handler split.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  NUMBER_SCHEMA,
  arraySchema,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import { METADATA_SCHEMA } from './operator-contract-schemas-shared.js';

/** One channel-specific sender identity: which channel, and the id within it. */
export const PRINCIPAL_IDENTITY_SCHEMA = objectSchema({
  channel: STRING_SCHEMA,
  value: STRING_SCHEMA,
}, ['channel', 'value']);

const PRINCIPAL_KIND_SCHEMA = { type: 'string', enum: ['user', 'bot', 'service', 'token'] } as const;

/** A named principal and the channel identities that resolve to it. */
export const PRINCIPAL_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  kind: PRINCIPAL_KIND_SCHEMA,
  identities: arraySchema(PRINCIPAL_IDENTITY_SCHEMA),
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'name', 'kind', 'identities', 'createdAt', 'updatedAt']);

export const PRINCIPALS_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const PRINCIPALS_LIST_OUTPUT_SCHEMA = listOutputSchema('principals', PRINCIPAL_RECORD_SCHEMA);

export const PRINCIPALS_GET_INPUT_SCHEMA = objectSchema({ principalId: STRING_SCHEMA }, ['principalId']);
export const PRINCIPALS_GET_OUTPUT_SCHEMA = entityOutputSchema('principal', PRINCIPAL_RECORD_SCHEMA);

export const PRINCIPALS_CREATE_INPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  kind: PRINCIPAL_KIND_SCHEMA,
  identities: arraySchema(PRINCIPAL_IDENTITY_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['name', 'kind']);
export const PRINCIPALS_CREATE_OUTPUT_SCHEMA = entityOutputSchema('principal', PRINCIPAL_RECORD_SCHEMA);

export const PRINCIPALS_UPDATE_INPUT_SCHEMA = objectSchema({
  principalId: STRING_SCHEMA,
  name: STRING_SCHEMA,
  kind: PRINCIPAL_KIND_SCHEMA,
  identities: arraySchema(PRINCIPAL_IDENTITY_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['principalId']);
export const PRINCIPALS_UPDATE_OUTPUT_SCHEMA = entityOutputSchema('principal', PRINCIPAL_RECORD_SCHEMA);

export const PRINCIPALS_DELETE_INPUT_SCHEMA = objectSchema({ principalId: STRING_SCHEMA }, ['principalId']);
export const PRINCIPALS_DELETE_OUTPUT_SCHEMA = objectSchema({
  principalId: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
}, ['principalId', 'deleted']);

export const PRINCIPALS_RESOLVE_INPUT_SCHEMA = objectSchema({
  channel: STRING_SCHEMA,
  value: STRING_SCHEMA,
}, ['channel', 'value']);
export const PRINCIPALS_RESOLVE_OUTPUT_SCHEMA = objectSchema({
  principal: PRINCIPAL_RECORD_SCHEMA,
  known: BOOLEAN_SCHEMA,
}, ['principal', 'known']);

export const builtinGatewayPrincipalsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'principals.list',
    title: 'List Principals',
    description: 'Return every named principal in the registry with its channel identities.',
    category: 'principals',
    scopes: ['read:principals'],
    http: { method: 'GET', path: '/api/principals' },
    inputSchema: PRINCIPALS_LIST_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'principals.get',
    title: 'Get Principal',
    description: 'Return one principal by id. Returns 404 when no principal with that id exists.',
    category: 'principals',
    scopes: ['read:principals'],
    http: { method: 'GET', path: '/api/principals/{principalId}' },
    inputSchema: PRINCIPALS_GET_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'principals.create',
    title: 'Create Principal',
    description: 'Create a named principal from a name, kind, and optional channel identities. Fails with a conflict when any identity is already mapped to a different principal.',
    category: 'principals',
    scopes: ['write:principals'],
    http: { method: 'POST', path: '/api/principals' },
    inputSchema: PRINCIPALS_CREATE_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'principals.update',
    title: 'Update Principal',
    description: 'Update a principal\'s name, kind, identities, and/or metadata. Absent fields are left unchanged; supplying identities replaces the set. Fails with a conflict when an identity is already mapped to a different principal.',
    category: 'principals',
    scopes: ['write:principals'],
    http: { method: 'POST', path: '/api/principals/{principalId}/update' },
    inputSchema: PRINCIPALS_UPDATE_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_UPDATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'principals.delete',
    title: 'Delete Principal',
    description: 'Permanently delete a principal. Returns { deleted: false } when no principal with that id existed — an honest boolean, never a 200 that pretends a phantom principal was removed.',
    category: 'principals',
    scopes: ['write:principals'],
    http: { method: 'DELETE', path: '/api/principals/{principalId}' },
    inputSchema: PRINCIPALS_DELETE_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_DELETE_OUTPUT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'principals.resolve',
    title: 'Resolve Sender Identity',
    description: 'Resolve a channel-specific sender identity ({channel, value}) to the named principal it belongs to. An unmapped identity resolves to the shared unknown principal with known:false — the registry never guesses.',
    category: 'principals',
    scopes: ['read:principals'],
    http: { method: 'POST', path: '/api/principals/resolve' },
    inputSchema: PRINCIPALS_RESOLVE_INPUT_SCHEMA,
    outputSchema: PRINCIPALS_RESOLVE_OUTPUT_SCHEMA,
  }),
];
