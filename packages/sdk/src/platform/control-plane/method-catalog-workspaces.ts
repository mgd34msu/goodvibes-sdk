/**
 * method-catalog-workspaces.ts
 *
 * Contract descriptors for the shared registered-workspace registry verbs
 * (workspaces.registrations.list / .add / .remove and workspaces.resolve). The
 * registry is the platform-wide successor to the agent fork's local
 * registered-workspaces file: it records which project roots an operator has
 * opted into, remembers subtree-scoped declines, and resolves any path to the
 * nearest covering root — following the git worktree→main-repo link, not path
 * ancestry, so an orchestration sibling worktree inherits its main repo's
 * registration.
 *
 * Descriptors live here (static) so `buildOperatorContract` / api.md / the
 * generated artifacts see them whether or not a handler is attached yet;
 * routes/workspaces.ts attaches the handlers at gateway composition time. All
 * four carry an `http` binding backed by GATEWAY_REST_ROUTES (REST parity).
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { methodDescriptor } from './method-catalog-shared.js';
import {
  WORKSPACES_REGISTRATIONS_LIST_INPUT_SCHEMA,
  WORKSPACES_REGISTRATIONS_LIST_OUTPUT_SCHEMA,
  WORKSPACES_REGISTRATIONS_ADD_INPUT_SCHEMA,
  WORKSPACES_REGISTRATIONS_ADD_OUTPUT_SCHEMA,
  WORKSPACES_REGISTRATIONS_REMOVE_INPUT_SCHEMA,
  WORKSPACES_REGISTRATIONS_REMOVE_OUTPUT_SCHEMA,
  WORKSPACES_RESOLVE_INPUT_SCHEMA,
  WORKSPACES_RESOLVE_OUTPUT_SCHEMA,
} from './operator-contract-schemas-workspaces.js';

export const builtinGatewayWorkspacesMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workspaces.registrations.list',
    title: 'List Registered Workspaces',
    description:
      'Return every registered workspace root (coverage flows down each root\'s subtree) and every remembered subtree-scoped decline. Read-only.',
    category: 'workspaces',
    scopes: ['read:workspaces'],
    http: { method: 'GET', path: '/api/workspaces/registrations' },
    inputSchema: WORKSPACES_REGISTRATIONS_LIST_INPUT_SCHEMA,
    outputSchema: WORKSPACES_REGISTRATIONS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'workspaces.registrations.add',
    title: 'Register a Workspace',
    description:
      'Register a workspace root so the whole subtree beneath it is covered. Refuses an absurdly broad root (the home directory, the filesystem root, or the daemon state directory) with a 400 — coverage flows down the entire subtree, so a root that broad would sweep far more than a project. Idempotent: re-registering the same normalized root returns alreadyRegistered:true. Registering a root clears any remembered decline recorded at exactly that root.',
    category: 'workspaces',
    scopes: ['write:workspaces'],
    http: { method: 'POST', path: '/api/workspaces/registrations' },
    inputSchema: WORKSPACES_REGISTRATIONS_ADD_INPUT_SCHEMA,
    outputSchema: WORKSPACES_REGISTRATIONS_ADD_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'workspaces.registrations.remove',
    title: 'Unregister a Workspace',
    description:
      'Remove a registered workspace root. Returns { removed: false } when no root with that normalized path was registered — an honest boolean, never a 200 that pretends a phantom root was removed.',
    category: 'workspaces',
    scopes: ['write:workspaces'],
    http: { method: 'DELETE', path: '/api/workspaces/registrations' },
    inputSchema: WORKSPACES_REGISTRATIONS_REMOVE_INPUT_SCHEMA,
    outputSchema: WORKSPACES_REGISTRATIONS_REMOVE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'workspaces.resolve',
    title: 'Resolve Workspace Coverage',
    description:
      'Resolve a path against the registry: covered (by which nearest registered root), declined (at which root), or unknown. Coverage flows DOWN a registered root\'s subtree and is inherited through the git worktree→main-repo link — a linked worktree outside any registered root still resolves to the main repo\'s registration. When mainWorktreeRoot is omitted the daemon probes the link itself. Read-only.',
    category: 'workspaces',
    scopes: ['read:workspaces'],
    http: { method: 'POST', path: '/api/workspaces/resolve' },
    inputSchema: WORKSPACES_RESOLVE_INPUT_SCHEMA,
    outputSchema: WORKSPACES_RESOLVE_OUTPUT_SCHEMA,
  }),
];
