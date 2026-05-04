/**
 * Shared MCP type primitives — leaf-level module imported by both the public
 * events surface (`events/mcp.ts`) and the platform runtime types
 * (`platform/runtime/mcp/types.ts`).
 *
 * Keep this file free of any runtime or platform imports so that browser /
 * Expo / React Native consumers can safely import from `events/mcp.ts`
 * without pulling in platform internals.
 */

/**
 * High-level server role used for coherence evaluation.
 *
 * Superset covering both the public event surface and the platform runtime:
 *   - `general`, `docs`, `filesystem`, `git`, `database` — common across all layers
 *   - `browser`, `automation`, `ops`, `remote` — platform/coherence engine roles
 *   - `search`, `communication`, `devops`, `analytics`, `custom` — event/UI roles
 */
export type McpServerRole =
  | 'general'
  | 'docs'
  | 'filesystem'
  | 'git'
  | 'database'
  | 'browser'
  | 'automation'
  | 'ops'
  | 'remote'
  | 'search'
  | 'communication'
  | 'devops'
  | 'analytics'
  | 'custom';

/** Trust operating mode for an MCP server. */
export type McpTrustMode = 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';

/** Reason a schema was placed into quarantine. */
export type QuarantineReason = 'stale_threshold' | 'unsupported' | 'operator_flagged' | 'incompatible';
