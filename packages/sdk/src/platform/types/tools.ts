/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/** Represents a tool the LLM can invoke. Parameters follow JSON Schema. */
export type ToolSideEffect =
  | 'read_fs'
  | 'write_fs'
  | 'network'
  | 'exec'
  | 'agent'
  | 'workflow'
  | 'state';

export type ToolConcurrencyMode = 'serial' | 'parallel' | 'singleton';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Side effects the tool may perform when executed successfully. */
  sideEffects?: readonly ToolSideEffect[] | undefined;
  /** Whether multiple calls can safely run in parallel. */
  concurrency?: ToolConcurrencyMode | undefined;
  /** Whether the tool can emit meaningful progress before final completion. */
  supportsProgress?: boolean | undefined;
  /** Whether results may be streamed or delivered incrementally. */
  supportsStreamingOutput?: boolean | undefined;
}

/** A tool invocation requested by the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Structured denial detail for a tool call the permission layer blocked.
 *
 * Rides on the failed ToolResult so the ASKING agent receives machine-readable
 * denial data scoped to that exact call — never a hung promise and never a bare
 * throw — and can continue and report honestly instead of parsing an error
 * string. `reason` is the permission layer's reason code (see
 * PermissionDecisionReasonCode, e.g. 'user_denied' / 'config_deny') and `scope`
 * is the layer that produced the decision (see PermissionDecisionSource, e.g.
 * 'user_prompt' / 'config_policy'); both are kept as plain strings so this
 * low-level type stays free of a permissions/ import.
 */
export interface ToolDenial {
  readonly denied: true;
  readonly reason: string;
  readonly scope: string;
  /** Optional user free-text (e.g. why a call was declined) for the model to adapt to. */
  readonly detail?: string | undefined;
}

/** The outcome of executing a tool. */
export interface ToolResult {
  callId: string;
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  /** Non-failing issues the caller should surface with the result. */
  warnings?: readonly string[] | undefined;
  /**
   * Present only when the call was refused by the permission layer. Structured,
   * call-scoped denial data the asking agent can act on. See {@link ToolDenial}.
   */
  denial?: ToolDenial | undefined;
  /**
   * True when this specific call was cancelled by the user mid-flight (per-call
   * cooperative cancellation — NOT a whole-turn abort). The turn continues:
   * the model sees this structured result and adapts. `error` carries the
   * human-readable "cancelled by user"; partial `output` is preserved when the
   * tool produced any before stopping.
   */
  cancelled?: boolean | undefined;
}

/**
 * Optional per-call execution options.
 *
 * `signal` is ADDITIVE: it was not present before, and every
 * existing tool implementation that declares `execute(args)` with a single
 * parameter remains a valid implementation of this interface (structural
 * typing — an unused trailing optional parameter is simply never read). Only
 * tools that opt in (exec, fetch) read it to propagate cooperative
 * cancellation into a spawned child process or an in-flight request.
 */
export interface ToolExecuteOptions {
  readonly signal?: AbortSignal | undefined;
}

/** A registered tool with its definition and executor. */
export interface Tool {
  definition: ToolDefinition;
  /** Tools return a result without callId — the registry injects callId when wrapping. */
  execute(args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<Omit<ToolResult, 'callId'>>;
}
