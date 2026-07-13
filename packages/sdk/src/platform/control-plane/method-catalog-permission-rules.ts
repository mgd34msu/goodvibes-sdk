/**
 * method-catalog-permission-rules.ts
 *
 * The permissions.rules.list / permissions.rules.delete descriptors — the
 * settings-domain surface over durable user-origin permission rules (the
 * persistent form of remembered approval decisions). ws-only invoke verbs (no
 * REST binding), registered from the same composition root as the other verb
 * groups (routes/register-gateway-verb-groups.ts). Handlers:
 * routes/permission-rules.ts.
 */

import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  PERMISSION_RULES_DELETE_INPUT_SCHEMA,
  PERMISSION_RULES_DELETE_OUTPUT_SCHEMA,
  PERMISSION_RULES_LIST_INPUT_SCHEMA,
  PERMISSION_RULES_LIST_OUTPUT_SCHEMA,
} from './operator-contract-schemas-permissions.js';

export const builtinGatewayPermissionRuleMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'permissions.rules.list',
    title: 'List Durable Permission Rules',
    description: 'List the durable user-origin permission rules written by remembered approval decisions (exact command / command class / path scope / whole tool), newest first — the persistent grants and denials the permission manager consults before ever prompting. Project-scoped.',
    category: 'permissions',
    scopes: ['read:sessions'],
    transport: ['ws'],
    inputSchema: PERMISSION_RULES_LIST_INPUT_SCHEMA,
    outputSchema: PERMISSION_RULES_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'permissions.rules.delete',
    title: 'Delete a Durable Permission Rule',
    description: 'Delete one durable user-origin permission rule by id. The matching asks prompt again afterwards — deleting a grant is how a remembered decision is revoked. deleted:false when no rule with that id exists (an honest miss, not an error).',
    category: 'permissions',
    scopes: ['write:sessions'],
    transport: ['ws'],
    inputSchema: PERMISSION_RULES_DELETE_INPUT_SCHEMA,
    outputSchema: PERMISSION_RULES_DELETE_OUTPUT_SCHEMA,
  }),
];
