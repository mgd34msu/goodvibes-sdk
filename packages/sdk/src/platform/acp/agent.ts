/**
 * agent.ts — the AGENT side of the Agent Client Protocol (ACP).
 *
 * Exposes a GoodVibes session as an ACP agent so ACP-capable editors (Zed and
 * others) can drive GoodVibes over stdio: initialize/authenticate → session
 * lifecycle → streamed content + tool-call updates → permission requests
 * mapped onto the platform permission callback.
 *
 * The substrate is the SDK Embedding API (`createEmbeddedSession`): each ACP
 * session boots an embedded GoodVibes session against the request's `cwd` and
 * bridges its runtime-event bus onto ACP `session/update` notifications. No new
 * engine — the adapter is a protocol mapping over the embed surface.
 *
 * Honest capability surface (see `initialize`): anything the platform does not
 * support is reported `false`, never stubbed —
 *   - `loadSession: false` (no session restore over ACP)
 *   - prompt `image`/`audio`/`embeddedContext`: false (input is text; the
 *     submit seam takes a text body)
 *   - `mcpCapabilities.http`/`sse`: false (this adapter does not wire the
 *     client's MCP servers into the embedded session; `mcpServers` entries in
 *     `session/new` are ignored)
 * Turn cancellation is best-effort: `session/cancel` cancels a queued input via
 * the broker's `cancelInput` and resolves the in-flight prompt with stop reason
 * `cancelled`; an already-executing provider call is not aborted mid-flight.
 */

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent } from '@agentclientprotocol/sdk';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  StopReason,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { createEmbeddedSession, type EmbeddedSession } from '../embed/session.js';
import type { PermissionPromptDecision, PermissionPromptRequest, PermissionRequestHandler } from '../permissions/prompt.js';
import type { TurnEvent } from '../../events/turn.js';
import type { ToolEvent } from '../../events/tools.js';

/** Factory seam for the embedded-session substrate (tests inject fakes). */
export type EmbeddedSessionFactory = (options: {
  readonly workspace: string;
  readonly requestPermission: PermissionRequestHandler;
}) => Promise<EmbeddedSession>;

export interface AcpAgentOptions {
  /** Home directory handed to the embedded daemon. Defaults to $HOME. */
  readonly homeDirectory?: string | undefined;
  /** Substrate override; defaults to `createEmbeddedSession`. */
  readonly sessionFactory?: EmbeddedSessionFactory | undefined;
}

interface AcpSessionState {
  readonly embedded: EmbeddedSession;
  /** Runtime session ids whose envelopes belong to this ACP session. */
  readonly knownIds: Set<string>;
  activePrompt: {
    readonly inputId: string | undefined;
    resolve: (stopReason: StopReason) => void;
    unsubscribe: () => void;
  } | null;
  cancelled: boolean;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

/** Extract the text of a prompt: text blocks verbatim, resource links by URI. */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'resource_link') parts.push(block.uri);
    // image/audio/resource are refused via promptCapabilities; skip defensively.
  }
  return parts.join('\n\n');
}

/** Map a terminal GoodVibes turn event onto an ACP stop reason. */
export function mapStopReason(event: TurnEvent): StopReason | null {
  switch (event.type) {
    case 'TURN_COMPLETED':
      return 'end_turn';
    case 'TURN_CANCEL':
      return 'cancelled';
    case 'PREFLIGHT_FAIL':
      return event.stopReason === 'context_overflow' ? 'max_tokens' : 'refusal';
    case 'TURN_ERROR':
      if (event.stopReason === 'context_overflow') return 'max_tokens';
      if (event.stopReason === 'tool_loop_circuit_breaker') return 'max_turn_requests';
      return 'refusal';
    default:
      return null;
  }
}

/** Map an ACP permission outcome back onto the platform decision shape. */
export function mapPermissionOutcome(
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string },
): PermissionPromptDecision {
  if (outcome.outcome === 'cancelled') return { approved: false };
  switch (outcome.optionId) {
    case 'allow-once':
      return { approved: true };
    case 'allow-always':
      return { approved: true, remember: true };
    default:
      return { approved: false };
  }
}

/**
 * The ACP `Agent` implementation backed by embedded GoodVibes sessions.
 * One instance serves one connection; each `session/new` boots one embedded
 * session against the request's `cwd`.
 */
export class GoodVibesAcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(
    private readonly conn: Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission'>,
    private readonly options: AcpAgentOptions = {},
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  }

  /** No authentication required: the embedded daemon is process-local. */
  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const acpSessionId = `gv-${randomUUID()}`;
    const factory: EmbeddedSessionFactory =
      this.options.sessionFactory ??
      (async ({ workspace, requestPermission }) =>
        createEmbeddedSession({
          workspace,
          homeDirectory: this.options.homeDirectory ?? process.env.HOME ?? process.cwd(),
          requestPermission,
        }));
    const embedded = await factory({
      workspace: params.cwd,
      requestPermission: (request) => this.bridgePermission(acpSessionId, request),
    });
    this.sessions.set(acpSessionId, {
      embedded,
      knownIds: new Set(),
      activePrompt: null,
      cancelled: false,
    });
    return { sessionId: acpSessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw new Error(`Unknown ACP session: ${params.sessionId}`);
    state.cancelled = false;

    const submission = await state.embedded.submit(promptText(params.prompt));
    state.knownIds.add(submission.session.id);
    if (submission.activeAgentId) state.knownIds.add(submission.activeAgentId);

    return new Promise<PromptResponse>((resolvePrompt) => {
      const finish = (stopReason: StopReason): void => {
        state.activePrompt?.unsubscribe();
        state.activePrompt = null;
        resolvePrompt({ stopReason });
      };

      const matches = (envelopeSessionId: string | undefined): boolean => {
        if (this.sessions.size === 1) return true; // single-session fast path
        return envelopeSessionId !== undefined && state.knownIds.has(envelopeSessionId);
      };

      const offTurn = state.embedded.events.onDomain('turn', (envelope) => {
        if (!matches(envelope.sessionId)) return;
        const event = envelope.payload;
        if (event.type === 'STREAM_DELTA' && event.content) {
          void this.conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.content },
            },
          });
        }
        const stop = mapStopReason(event);
        if (stop) finish(state.cancelled ? 'cancelled' : stop);
      });

      const offTool = state.embedded.events.onDomain('tools', (envelope) => {
        if (!matches(envelope.sessionId)) return;
        this.forwardToolEvent(params.sessionId, envelope.payload);
      });

      state.activePrompt = {
        inputId: submission.input?.id,
        resolve: finish,
        unsubscribe: () => {
          offTurn();
          offTool();
        },
      };
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return;
    state.cancelled = true;
    const active = state.activePrompt;
    if (active?.inputId) {
      const sharedId = [...state.knownIds][0];
      if (sharedId) {
        await state.embedded.sessions.cancelInput(sharedId, active.inputId).catch(() => null);
      }
    }
    active?.resolve('cancelled');
  }

  /** Tear down every embedded session (used by serveAcpAgent on stream end). */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.embedded.stop()));
    this.sessions.clear();
  }

  private async bridgePermission(
    acpSessionId: string,
    request: PermissionPromptRequest,
  ): Promise<PermissionPromptDecision> {
    const response = await this.conn.requestPermission({
      sessionId: acpSessionId,
      toolCall: {
        toolCallId: request.callId,
        title: request.tool,
        status: 'pending',
        rawInput: request.args,
      },
      options: PERMISSION_OPTIONS,
    });
    return mapPermissionOutcome(response.outcome as Parameters<typeof mapPermissionOutcome>[0]);
  }

  private forwardToolEvent(acpSessionId: string, event: ToolEvent): void {
    if (event.type === 'TOOL_EXECUTING') {
      void this.conn.sessionUpdate({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: event.callId,
          title: event.tool,
          status: 'in_progress',
        },
      });
      return;
    }
    if (event.type === 'TOOL_SUCCEEDED' || event.type === 'TOOL_FAILED') {
      void this.conn.sessionUpdate({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.callId,
          status: event.type === 'TOOL_SUCCEEDED' ? 'completed' : 'failed',
          ...(event.type === 'TOOL_FAILED'
            ? { content: [{ type: 'content', content: { type: 'text', text: event.error } }] }
            : {}),
        },
      });
    }
  }
}

/**
 * Serve a GoodVibes ACP agent over stdio. Call from a headless entry point;
 * returns the connection and a dispose handle (the caller owns process exit).
 */
export function serveAcpAgent(options: AcpAgentOptions = {}): {
  connection: AgentSideConnection;
  dispose: () => Promise<void>;
} {
  let agent: GoodVibesAcpAgent | null = null;
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on('end', () => controller.close());
    },
  });
  const connection = new AgentSideConnection((conn) => {
    agent = new GoodVibesAcpAgent(conn, options);
    return agent;
  }, ndJsonStream(stdout, stdin));
  return {
    connection,
    dispose: async () => {
      await agent?.dispose();
    },
  };
}
