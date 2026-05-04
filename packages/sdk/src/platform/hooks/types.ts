/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/** The 5 lifecycle phases */
export type HookPhase = 'Pre' | 'Post' | 'Fail' | 'Change' | 'Lifecycle';

/** Hook event categories */
export type HookCategory =
  | 'tool' | 'file' | 'git' | 'agent' | 'compact'
  | 'llm' | 'mcp' | 'config' | 'budget' | 'session' | 'workflow'
  | 'permission' | 'transport' | 'orchestration' | 'communication';

/** A fully qualified hook event path: Phase:Category:Specific */
export type HookEventPath = `${HookPhase}:${HookCategory}:${string}`;

/** Event payload passed to hooks */
export interface HookEvent {
  path: HookEventPath;
  phase: HookPhase;
  category: HookCategory;
  specific: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  /** For agent-scoped events */
  agentId?: string | undefined;
}

/** Result returned by a hook handler */
export interface HookResult {
  /** For Pre hooks: allow, deny, or ask */
  decision?: 'allow' | 'deny' | 'ask' | undefined;
  /** Reason for denial */
  reason?: string | undefined;
  /** Modified input (Pre hooks can modify tool input) */
  updatedInput?: Record<string, unknown> | undefined;
  /** Context to inject into the LLM conversation */
  additionalContext?: string | undefined;
  /** Whether the hook ran successfully */
  ok: boolean;
  /** Error message if hook failed */
  error?: string | undefined;
}

/** The 5 hook types */
export type HookType = 'command' | 'prompt' | 'agent' | 'http' | 'ts';

/** Hook definition in hooks.json */
export interface HookDefinition {
  /** Which event path to match. Supports wildcards: Pre:tool:* */
  match: string;
  /** Further filter within the match (e.g., specific tool name) */
  matcher?: string | undefined;
  /** Hook type */
  type: HookType;
  /** For command hooks: shell command to execute */
  command?: string | undefined;
  /** For prompt/agent hooks: the prompt text. $ARGUMENTS replaced with event JSON. */
  prompt?: string | undefined;
  /** For http hooks: URL to POST to */
  url?: string | undefined;
  /** For ts hooks: path to TypeScript file */
  path?: string | undefined;
  /** For http hooks: custom headers */
  headers?: Record<string, string> | undefined;
  /** For prompt/agent hooks: LLM model to use */
  model?: string | undefined;
  /** Timeout in seconds (default: 30 for command/prompt/http, 60 for agent) */
  timeout?: number | undefined;
  /** Custom status message shown while hook runs */
  statusMessage?: string | undefined;
  /** Run in background without blocking */
  async?: boolean | undefined;
  /** Run once then auto-remove */
  once?: boolean | undefined;
  /** Description for documentation */
  description?: string | undefined;
  /** Optional name for programmatic enable/disable/remove */
  name?: string | undefined;
  /** Whether the hook is enabled (default: true) */
  enabled?: boolean | undefined;
  /**
   * For http hooks: when true, bypasses the SEC-08 SSRF tier filter and
   * allows requests to internal/private hosts. Use only in trusted,
   * air-gapped environments where the hook target is a known internal service.
   * Default: false (SSRF filter active).
   */
  allowInternal?: boolean | undefined;
}

/** Hook chain step */
export interface ChainStep {
  match: string;
  capture?: Record<string, string> | undefined;
  within?: string;       // e.g., "30s", "5m"
  condition?: string;    // JS expression evaluated against payload
  optional?: boolean | undefined;
  debounce?: string;     // e.g., "2s"
}

/** Hook chain definition */
export interface HookChain {
  name: string;
  description?: string | undefined;
  steps: ChainStep[];
  action: HookDefinition;
}

/** Full hooks.json schema */
export interface HooksConfig {
  /** Direct hooks keyed by event path pattern */
  hooks?: Record<string, HookDefinition[]> | undefined;
  /** Multi-event chains */
  chains?: HookChain[] | undefined;
}
