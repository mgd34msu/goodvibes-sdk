/**
 * ACP Protocol Types
 *
 * Re-exports SDK types and defines local types for subagent management.
 * The SDK host acts as the ACP client; subagents implement the Agent interface.
 */

// Re-export ACP SDK types
export type {
  Client,
  Agent,
  AgentSideConnection,
  ClientSideConnection,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  SessionNotification,
  PromptRequest,
  PromptResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';

/**
 * The ACP SDK's VALUES, `ndJsonStream`, `AgentSideConnection`,
 * `PROTOCOL_VERSION`, `ClientSideConnection`, used to be re-exported from
 * here. They are not any more, because `export { … } from '@agentclientprotocol/sdk'`
 * links the specifier at module init exactly like an import does, and the
 * package is an optionalDependency: an install without it took down every
 * graph that reached this file, the daemon's included. Take them off the
 * awaited module instead:
 *
 *   const { ndJsonStream, ClientSideConnection } = await loadAcpSdk();
 *
 * The type re-exports above are unaffected, `export type` is erased.
 */
export { describeAcpAvailability, loadAcpSdk } from './optional-sdk.js';
export type { AcpAvailability, AcpSdkModule } from './optional-sdk.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** Lifecycle status of a spawned subagent. */
export type SubagentStatus = 'running' | 'complete' | 'error' | 'cancelled';

/** Tracks a live subagent process. */
export interface SubagentInfo {
  id: string;
  task: string;
  status: SubagentStatus;
  startedAt: number;
  /** Latest progress text from session updates. */
  progress?: string | undefined;
}

/** Final result after a subagent completes. */
export interface SubagentResult {
  id: string;
  success: boolean;
  output: string;
  toolCallsMade: number;
  duration: number;
}

/** Parameters for spawning a subagent task. */
export interface SubagentTask {
  /** Human-readable task description / prompt. */
  description: string;
  /** Additional context to inject into the subagent's system prompt. */
  context: string;
  /** Tool names the subagent is allowed to use. */
  tools: string[];
  /** App-owned working directory for the spawned ACP session. */
  workingDirectory: string;
  /** Optional model override (e.g. "claude-sonnet-4-5"). */
  model?: string | undefined;
  /** Optional provider override (e.g. "anthropic"). */
  provider?: string | undefined;
}
