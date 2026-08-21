/**
 * Permission-layer config types: the tool-action matrix (`permissions.mode`,
 * `permissions.tools.*`) and the background-agent mode that decides whether
 * background/subagent tool calls consult it. Split out of schema-types.ts so
 * that file stays under its grandfathered line ceiling; re-exported from
 * schema-types.ts so import sites are unchanged.
 */
export type PermissionMode = 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits';
export type PermissionAction = 'allow' | 'prompt' | 'deny';
/**
 * How background/subagent tool execution consults the permission layer.
 * - 'inherit' (default): background tool calls run through the SAME session
 *   permission mode as the foreground turn loop, allow-all changes nothing,
 *   prompt/plan/accept-edits/custom apply their matrices, and any ask brokers
 *   through the same blocked-on-user machinery with subagent attribution.
 * - 'allow-all': background agents are deliberately exempt, their tool calls
 *   auto-approve regardless of the session mode (the escape hatch for fully
 *   autonomous runs that never want a background ask).
 */
export type BackgroundAgentsMode = 'inherit' | 'allow-all';
export type LineNumberMode = 'all' | 'code' | 'off';

export interface PermissionsToolConfig {
  read?: PermissionAction;        // default: 'allow'
  write?: PermissionAction;       // default: 'prompt'
  edit?: PermissionAction;        // default: 'prompt'
  exec?: PermissionAction;        // default: 'prompt'
  find?: PermissionAction;        // default: 'allow'
  fetch?: PermissionAction;       // default: 'prompt'
  analyze?: PermissionAction;     // default: 'allow'
  inspect?: PermissionAction;     // default: 'allow'
  agent?: PermissionAction;       // default: 'prompt'
  state?: PermissionAction;       // default: 'allow'
  workflow?: PermissionAction;    // default: 'prompt'
  registry?: PermissionAction;    // default: 'allow'
  delegate?: PermissionAction;    // default: 'prompt'
  mcp?: PermissionAction;         // default: 'prompt'
}
