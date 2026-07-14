/**
 * fake-acp-agent.ts — a scripted third-party ACP agent binary for tests.
 *
 * Speaks the REAL Agent Client Protocol over stdio via @agentclientprotocol/sdk
 * (the same wire a real Claude Code / Codex / opencode ACP mode uses), with
 * behavior scripted by env vars so the host tests can drive every path:
 *
 * Mode comes from argv[2] (preferred) or FAKE_ACP_MODE:
 *   happy       (default) initialize/session/prompt round-trip;
 *                             each prompt streams a chunk then ends the turn.
 *   FAKE_ACP_MODE=permission  first prompt raises a session/request_permission
 *                             to the client, then finishes according to the answer.
 *   FAKE_ACP_MODE=bad-handshake  prints garbage and exits nonzero (never speaks ACP).
 *   FAKE_ACP_MODE=hang        reads stdin but never answers initialize (timeout path).
 *   FAKE_ACP_MODE=slow-turn   a prompt streams then waits until cancelled.
 */
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '../../packages/sdk/src/platform/acp/protocol.ts';
import type {
  Agent,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '../../packages/sdk/src/platform/acp/protocol.ts';

const mode = process.argv[2] ?? process.env.FAKE_ACP_MODE ?? 'happy';

if (mode === 'bad-handshake') {
  process.stdout.write('this binary does not speak ACP\n');
  process.exit(3);
}

if (mode === 'hang') {
  // Swallow stdin forever; never respond. The host's handshake timeout must
  // turn this into a structured failure, never a hung row.
  process.stdin.on('data', () => {});
  setInterval(() => {}, 60_000);
} else {
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) { process.stdout.write(chunk); },
  });
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on('end', () => controller.close());
    },
  });

  class FakeAgent implements Agent {
    private cancelled = new Set<string>();
    private cancelWaiters = new Map<string, () => void>();
    constructor(private readonly conn: AgentSideConnection) {}

    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
        agentCapabilities: { loadSession: false },
      };
    }

    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      return { sessionId: `fake-session-${Math.random().toString(36).slice(2, 8)}` };
    }

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const sessionId = params.sessionId;
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'fake agent: working on it' },
        },
      });

      if (mode === 'permission') {
        const response = await this.conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: 'fake-tool-1', title: 'write a file', rawInput: { path: 'x.txt' } },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        });
        const approved = response.outcome.outcome === 'selected';
        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: approved ? ' permission granted' : ' permission denied' },
          },
        });
        return { stopReason: 'end_turn' };
      }

      if (mode === 'slow-turn') {
        // Park until cancel arrives, then report the honest cancelled stop.
        await new Promise<void>((resolveWait) => {
          if (this.cancelled.has(sessionId)) { resolveWait(); return; }
          this.cancelWaiters.set(sessionId, resolveWait);
        });
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
    }

    async cancel(params: CancelNotification): Promise<void> {
      this.cancelled.add(params.sessionId);
      this.cancelWaiters.get(params.sessionId)?.();
      this.cancelWaiters.delete(params.sessionId);
    }

    async authenticate(): Promise<void> {
      // No auth required.
    }
  }

  new AgentSideConnection((conn) => new FakeAgent(conn), ndJsonStream(stdout, stdin));
}
