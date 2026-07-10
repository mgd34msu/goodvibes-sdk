/**
 * method-catalog-channel-profiles.ts
 *
 * Contract descriptors for the per-channel profile binding verbs
 * (channels.profiles.list / get / set / delete). These expose the
 * ChannelProfileRegistry (../../channel-profiles) over the operator surface so a
 * channel can bind the model/provider and permission-mode defaults applied to
 * the sessions it originates.
 *
 * Distinct from the pre-existing channels.routing.* table (which maps a channel
 * to a named ProfileManager profile id): these bind CONCRETE origination
 * defaults, including the permission mode ProfileData deliberately excludes.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import { METADATA_SCHEMA } from './operator-contract-schemas-shared.js';

const CHANNEL_PERMISSION_MODE_SCHEMA = { type: 'string', enum: ['plan', 'normal', 'accept-edits', 'auto'] } as const;

/** One channel→profile binding record. */
export const CHANNEL_PROFILE_BINDING_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  permissionMode: CHANNEL_PERMISSION_MODE_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surfaceKind', 'updatedAt']);

export const CHANNEL_PROFILES_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const CHANNEL_PROFILES_LIST_OUTPUT_SCHEMA = listOutputSchema('bindings', CHANNEL_PROFILE_BINDING_SCHEMA);

export const CHANNEL_PROFILES_GET_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_GET_OUTPUT_SCHEMA = entityOutputSchema('binding', CHANNEL_PROFILE_BINDING_SCHEMA);

export const CHANNEL_PROFILES_SET_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  permissionMode: CHANNEL_PERMISSION_MODE_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_SET_OUTPUT_SCHEMA = entityOutputSchema('binding', CHANNEL_PROFILE_BINDING_SCHEMA);

export const CHANNEL_PROFILES_DELETE_INPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
}, ['surfaceKind']);
export const CHANNEL_PROFILES_DELETE_OUTPUT_SCHEMA = objectSchema({
  surfaceKind: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
}, ['surfaceKind', 'deleted']);

export const builtinGatewayChannelProfilesMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'channels.profiles.list',
    title: 'List Channel Profile Bindings',
    description: 'Return every per-channel profile binding (the model/permission defaults applied to sessions each channel originates).',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/profiles' },
    inputSchema: CHANNEL_PROFILES_LIST_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.get',
    title: 'Get Channel Profile Binding',
    description: 'Return the profile binding for a channel (surfaceKind plus optional channelId). Returns 404 when no binding for that exact key exists.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/profiles/{surfaceKind}' },
    inputSchema: CHANNEL_PROFILES_GET_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.set',
    title: 'Bind Channel Profile',
    description: 'Bind (upsert) the model/provider and permission-mode defaults for a channel. Keyed on (surfaceKind, channelId?): a channelId-scoped binding wins over the surface-wide default; setting the same key again replaces it.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/profiles' },
    inputSchema: CHANNEL_PROFILES_SET_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.profiles.delete',
    title: 'Unbind Channel Profile',
    description: 'Remove a channel profile binding. Returns { deleted: false } when no binding for that key existed — an honest boolean, never a phantom removal.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/channels/profiles/{surfaceKind}' },
    inputSchema: CHANNEL_PROFILES_DELETE_INPUT_SCHEMA,
    outputSchema: CHANNEL_PROFILES_DELETE_OUTPUT_SCHEMA,
    dangerous: true,
  }),
];
