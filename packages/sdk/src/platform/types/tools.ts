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

/** The outcome of executing a tool. */
export interface ToolResult {
  callId: string;
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  /** Non-failing issues the caller should surface with the result. */
  warnings?: readonly string[] | undefined;
}

/**
 * Optional per-call execution options.
 *
 * `signal` (Wave 4, wo701) is ADDITIVE: it was not present before, and every
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
