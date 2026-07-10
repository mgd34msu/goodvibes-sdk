/**
 * method-catalog-skills.ts
 *
 * Contract descriptors for the daemon's skills CRUD gateway verbs
 * (skills.list / skills.get / skills.create / skills.update / skills.delete).
 * These expose the single canonical skill service (../skills, service.ts) over
 * the operator surface so a consumer drives one shared skill store through the
 * daemon instead of each carrying its own on-disk copy.
 *
 * Descriptors live here (static) so `buildOperatorContract` / api.md / the
 * generated contract artifacts see them whether or not a handler has been
 * attached yet; routes/skills.ts attaches the handlers at RuntimeServices
 * construction time. This mirrors the fleet.* descriptor/handler split.
 *
 * Progressive disclosure is expressed in the shapes: skills.list returns the
 * cheap index line (name + description + metadata, NO body), skills.get returns
 * the full record including the Markdown body.
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

/** The cheap index line of a skill: enough to decide whether to open it, no body. */
export const SKILL_INDEX_ENTRY_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['name', 'description', 'metadata']);

/** A fully-disclosed skill: its index line plus the Markdown body. */
export const SKILL_RECORD_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
  body: STRING_SCHEMA,
}, ['name', 'description', 'metadata', 'body']);

export const SKILLS_LIST_INPUT_SCHEMA = objectSchema({}, []);
export const SKILLS_LIST_OUTPUT_SCHEMA = listOutputSchema('skills', SKILL_INDEX_ENTRY_SCHEMA);

export const SKILLS_GET_INPUT_SCHEMA = objectSchema({ name: STRING_SCHEMA }, ['name']);
export const SKILLS_GET_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_CREATE_INPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  body: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['name', 'description', 'body']);
export const SKILLS_CREATE_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_UPDATE_INPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  body: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['name']);
export const SKILLS_UPDATE_OUTPUT_SCHEMA = entityOutputSchema('skill', SKILL_RECORD_SCHEMA);

export const SKILLS_DELETE_INPUT_SCHEMA = objectSchema({ name: STRING_SCHEMA }, ['name']);
export const SKILLS_DELETE_OUTPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  deleted: BOOLEAN_SCHEMA,
}, ['name', 'deleted']);

export const builtinGatewaySkillsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'skills.list',
    title: 'List Skills',
    description: 'Return the index line (name, description, metadata) of every skill in the canonical store. Progressive disclosure: bodies are never returned here — call skills.get for the one skill you decide to open.',
    category: 'skills',
    scopes: ['read:skills'],
    http: { method: 'GET', path: '/api/skills' },
    inputSchema: SKILLS_LIST_INPUT_SCHEMA,
    outputSchema: SKILLS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.get',
    title: 'Get Skill',
    description: 'Return one skill in full, including its Markdown body. Returns 404 when no skill with that name exists.',
    category: 'skills',
    scopes: ['read:skills'],
    http: { method: 'GET', path: '/api/skills/{name}' },
    inputSchema: SKILLS_GET_INPUT_SCHEMA,
    outputSchema: SKILLS_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.create',
    title: 'Create Skill',
    description: 'Create a new skill from a name, one-line description, and Markdown body (plus optional frontmatter metadata). Fails with a conflict when a skill of that name already exists — use skills.update to change an existing one.',
    category: 'skills',
    scopes: ['write:skills'],
    http: { method: 'POST', path: '/api/skills' },
    inputSchema: SKILLS_CREATE_INPUT_SCHEMA,
    outputSchema: SKILLS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.update',
    title: 'Update Skill',
    description: 'Update an existing skill\'s description, body, and/or frontmatter metadata. Absent fields are left unchanged. Returns 404 when no skill with that name exists.',
    category: 'skills',
    scopes: ['write:skills'],
    http: { method: 'POST', path: '/api/skills/{name}/update' },
    inputSchema: SKILLS_UPDATE_INPUT_SCHEMA,
    outputSchema: SKILLS_UPDATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'skills.delete',
    title: 'Delete Skill',
    description: 'Permanently delete a skill. Delete means delete: the document is removed, not tombstoned. Returns { deleted: false } when no skill with that name existed — an honest boolean, never a 200 that pretends a phantom skill was removed.',
    category: 'skills',
    scopes: ['write:skills'],
    http: { method: 'DELETE', path: '/api/skills/{name}' },
    inputSchema: SKILLS_DELETE_INPUT_SCHEMA,
    outputSchema: SKILLS_DELETE_OUTPUT_SCHEMA,
  }),
];
