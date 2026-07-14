/**
 * acp/host.ts — HOSTING third-party coding agents over the Agent Client
 * Protocol.
 *
 * The existing acp/ modules make GoodVibes an ACP *agent* (agent.ts) and spawn
 * short-lived ACP *subagents* (connection.ts/manager.ts). This module is the
 * daemon-side HOST: it discovers installed third-party coding agents (Claude
 * Code, Codex CLI, opencode), spawns one over stdio as a LONG-LIVED session,
 * and exposes the lifecycle a fleet row needs — prompt (steer), stop, and the
 * waiting-on-human attention states — so a hosted agent is visible, steerable,
 * and stoppable exactly like a native row.
 *
 * Honesty contract:
 *  - Discovery is READ-ONLY (PATH + known install directories; no execution).
 *    Absence is quiet — an empty list, never a nag.
 *  - A binary that fails the ACP handshake yields a STRUCTURED error (which
 *    binary, which stage, what happened) on a 'failed' record — never a hung
 *    row. Spawn/initialize/session are bounded by a handshake timeout.
 *  - Permission requests from the hosted agent flow through the injected
 *    permission handler (the daemon wires its shared approval broker) and the
 *    record reads 'awaiting-approval' while one is pending, so the fleet
 *    attention classification (glyph/count/jump/push) is inherited for free.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Agent, Client, NewSessionResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from './protocol.js';
import type { PermissionRequestHandler } from '../permissions/prompt.js';
import { analyzePermissionRequest } from '../permissions/analysis.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { VERSION } from '../version.js';

// ── Discovery ────────────────────────────────────────────────────────────────

/** One known third-party ACP-capable coding agent and how to launch its ACP mode. */
export interface KnownAcpAgent {
  readonly id: string;
  readonly title: string;
  /** Launch candidates, first found wins: binary name + the args that start ACP stdio mode. */
  readonly candidates: ReadonlyArray<{ readonly binary: string; readonly args: readonly string[] }>;
}

/**
 * The known agents table. The ACP launch shape per agent:
 *  - Claude Code speaks ACP through its dedicated adapter binary
 *    (`claude-code-acp`, the officially published bridge). The bare `claude`
 *    binary is deliberately NOT a candidate: it has no ACP mode (verified
 *    live), and advertising it would offer a spawn that always fails.
 *  - Codex CLI exposes `codex acp` (experimental) on recent builds.
 *  - opencode serves ACP via `opencode acp` (verified live end-to-end).
 * A wrong/outdated launch shape is not a hazard: the handshake timeout turns
 * it into a structured 'failed' record, never a hung row.
 */
export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  { id: 'claude-code', title: 'Claude Code', candidates: [{ binary: 'claude-code-acp', args: [] }] },
  { id: 'codex', title: 'Codex CLI', candidates: [{ binary: 'codex', args: ['acp'] }] },
  { id: 'opencode', title: 'opencode', candidates: [{ binary: 'opencode', args: ['acp'] }] },
];

/** A discovered, spawnable third-party agent: which binary resolved and how to launch it. */
export interface DiscoveredAcpAgent {
  readonly id: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly args: readonly string[];
}

/** Injectable probes so discovery is testable without touching the real filesystem. */
export interface DiscoveryIo {
  readonly fileExists: (path: string) => boolean;
  readonly envPath: () => string;
  readonly home: () => string;
}

const defaultDiscoveryIo: DiscoveryIo = {
  fileExists: (path) => existsSync(path),
  envPath: () => process.env.PATH ?? '',
  home: () => homedir(),
};

/** Known install directories checked IN ADDITION to $PATH (read-only). */
function knownInstallDirs(io: DiscoveryIo): string[] {
  const home = io.home();
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/**
 * Discover installed third-party ACP-capable agents. READ-ONLY: existence
 * checks over $PATH entries and known install directories — no process is ever
 * executed. Returns only what is present; absence is a quiet empty list.
 */
export function discoverAcpAgents(io: DiscoveryIo = defaultDiscoveryIo): DiscoveredAcpAgent[] {
  const dirs = [...io.envPath().split(delimiter).filter(Boolean), ...knownInstallDirs(io)];
  const seen = new Set<string>();
  const uniqueDirs = dirs.filter((dir) => (seen.has(dir) ? false : (seen.add(dir), true)));
  const found: DiscoveredAcpAgent[] = [];
  for (const agent of KNOWN_ACP_AGENTS) {
    for (const candidate of agent.candidates) {
      const dir = uniqueDirs.find((d) => io.fileExists(join(d, candidate.binary)));
      if (dir) {
        found.push({ id: agent.id, title: agent.title, binaryPath: join(dir, candidate.binary), args: candidate.args });
        break; // first candidate wins per agent
      }
    }
  }
  return found;
}

// ── Hosted sessions ──────────────────────────────────────────────────────────

/** Lifecycle state of a hosted third-party agent session. */
export type HostedAcpState = 'starting' | 'idle' | 'prompting' | 'awaiting-approval' | 'failed' | 'stopped';

/** The structured, user-renderable handshake/spawn failure — never a bare string. */
export interface AcpHostError {
  /** The binary that was launched. */
  readonly binary: string;
  /** Which stage failed: spawning the process, the ACP initialize, or session creation. */
  readonly stage: 'spawn' | 'initialize' | 'session' | 'prompt';
  readonly message: string;
}

/** One hosted third-party agent session, as the fleet adapter reads it. */
export interface HostedAcpAgent {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly state: HostedAcpState;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  /** The daemon shared-session id this hosted agent is mapped onto. */
  readonly sessionId?: string | undefined;
  /** Latest streamed output tail (bounded), for the row's activity line. */
  readonly progress?: string | undefined;
  /** Present while a permission ask is pending — the attention detail. */
  readonly pendingPermission?: string | undefined;
  /** Present when state === 'failed'. */
  readonly error?: AcpHostError | undefined;
  readonly promptCount: number;
}

interface HostedRecord {
  info: {
    id: string; agentId: string; title: string; binaryPath: string; cwd: string;
    state: HostedAcpState; startedAt: number; completedAt?: number | undefined;
    sessionId?: string | undefined; progress?: string | undefined;
    pendingPermission?: string | undefined; error?: AcpHostError | undefined; promptCount: number;
  };
  child: ReturnType<typeof Bun.spawn> | null;
  conn: ClientSideConnection | null;
  acpSessionId: string | null;
}

/** Registers/heartbeats the daemon shared session a hosted agent maps onto. */
export type AcpSessionRegistrar = (input: {
  readonly id: string;
  readonly title: string;
  readonly agentTitle: string;
  readonly cwd: string;
}) => void;

export interface AcpHostServiceDeps {
  /** Permission asks from hosted agents route here (the daemon wires its shared approval broker). */
  readonly requestPermission?: PermissionRequestHandler | undefined;
  /** Maps the hosted agent onto a daemon shared session (kind 'acp'). Optional — narrower embeds skip it. */
  readonly registerSession?: AcpSessionRegistrar | undefined;
  /** Injectable spawn seam for tests. Defaults to Bun.spawn. */
  readonly spawn?: ((cmd: string[], opts: { cwd: string }) => ReturnType<typeof Bun.spawn>) | undefined;
  /** Handshake bound (spawn→initialize→session). Default 15s — a bad binary becomes a structured failure, never a hung row. */
  readonly handshakeTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const PROGRESS_TAIL_CHARS = 400;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

export class AcpHostService {
  private readonly records = new Map<string, HostedRecord>();
  private readonly deps: AcpHostServiceDeps;
  private readonly now: () => number;

  constructor(deps: AcpHostServiceDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  list(): HostedAcpAgent[] {
    return [...this.records.values()].map((record) => ({ ...record.info }));
  }

  get(id: string): HostedAcpAgent | null {
    const record = this.records.get(id);
    return record ? { ...record.info } : null;
  }

  /**
   * Spawn a discovered agent into a working directory as a hosted session.
   * Resolves once the ACP handshake + session creation completed (state
   * 'idle', ready for prompts) or failed (state 'failed' with the structured
   * error). An initial prompt, when given, is fired after the handshake
   * without being awaited — the row streams like any live agent.
   */
  async spawnAgent(input: {
    readonly agent: DiscoveredAcpAgent;
    readonly cwd: string;
    readonly title?: string | undefined;
    readonly prompt?: string | undefined;
  }): Promise<HostedAcpAgent> {
    const id = `acp-host-${randomUUID().slice(0, 10)}`;
    const sessionId = `acp-${id}`;
    const record: HostedRecord = {
      info: {
        id,
        agentId: input.agent.id,
        title: input.title ?? `${input.agent.title}: ${input.cwd}`,
        binaryPath: input.agent.binaryPath,
        cwd: input.cwd,
        state: 'starting',
        startedAt: this.now(),
        promptCount: 0,
      },
      child: null,
      conn: null,
      acpSessionId: null,
    };
    this.records.set(id, record);
    const timeoutMs = this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const spawn = this.deps.spawn ?? ((cmd: string[], opts: { cwd: string }) => Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));

    let stage: AcpHostError['stage'] = 'spawn';
    try {
      record.child = spawn([input.agent.binaryPath, ...input.agent.args], { cwd: input.cwd });
      if (!record.child.stdin || !record.child.stdout) {
        throw new Error('subprocess stdio not available (stdin/stdout must be piped)');
      }
      const bunStdin = record.child.stdin as import('bun').FileSink;
      const stdinStream = new WritableStream<Uint8Array>({
        write(chunk) { bunStdin.write(chunk); },
        close() { bunStdin.end(); },
        abort() { bunStdin.end(); },
      });
      const stream = ndJsonStream(stdinStream, record.child.stdout as unknown as ReadableStream<Uint8Array>);
      record.conn = new ClientSideConnection((_agent: Agent) => this.buildClient(record), stream);

      stage = 'initialize';
      await withTimeout(record.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-daemon', version: VERSION },
        clientCapabilities: {},
      }), timeoutMs, 'ACP initialize');

      stage = 'session';
      const session = await withTimeout<NewSessionResponse>(record.conn.newSession({ cwd: input.cwd, mcpServers: [] }), timeoutMs, 'ACP session/new');
      record.acpSessionId = session.sessionId;

      record.info.sessionId = sessionId;
      record.info.state = 'idle';
      try {
        this.deps.registerSession?.({ id: sessionId, title: record.info.title, agentTitle: input.agent.title, cwd: input.cwd });
      } catch (error) {
        logger.warn('AcpHostService: shared-session registration failed', { id, error: summarizeError(error) });
      }
      if (input.prompt) void this.prompt(id, input.prompt);
      return { ...record.info };
    } catch (error) {
      record.info.state = 'failed';
      record.info.completedAt = this.now();
      record.info.error = {
        binary: input.agent.binaryPath,
        stage,
        message: summarizeError(error),
      };
      this.teardown(record);
      return { ...record.info };
    }
  }

  /**
   * Send a prompt (a steer) to a hosted agent's live ACP session. Honest
   * refusal for a row that cannot take one. Resolves queued immediately; the
   * turn streams in the background and the state returns to 'idle' when the
   * agent's turn ends.
   */
  prompt(id: string, text: string): { queued: true } | { queued: false; reason: string } {
    const record = this.records.get(id);
    if (!record) return { queued: false, reason: 'no such hosted agent' };
    if (!record.conn || !record.acpSessionId) return { queued: false, reason: 'hosted agent has no live ACP session' };
    if (record.info.state === 'failed' || record.info.state === 'stopped') {
      return { queued: false, reason: `hosted agent is ${record.info.state}` };
    }
    record.info.state = 'prompting';
    record.info.promptCount += 1;
    const conn = record.conn;
    const sessionId = record.acpSessionId;
    void conn.prompt({ sessionId, prompt: [{ type: 'text' as const, text }] })
      .then((response: PromptResponse) => {
        if (record.info.state === 'prompting' || record.info.state === 'awaiting-approval') {
          record.info.state = response.stopReason === 'cancelled' ? 'stopped' : 'idle';
          if (record.info.state === 'stopped') record.info.completedAt = this.now();
        }
      })
      .catch((error: unknown) => {
        if (record.info.state === 'stopped') return; // stop() raced the in-flight turn — not a failure
        record.info.state = 'failed';
        record.info.completedAt = this.now();
        record.info.error = { binary: record.info.binaryPath, stage: 'prompt', message: summarizeError(error) };
        this.teardown(record);
      });
    return { queued: true };
  }

  /** Stop a hosted agent: ACP cancel (best effort) then kill; state 'stopped'. */
  async stop(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.info.state === 'stopped' || record.info.state === 'failed') return false;
    if (record.conn && record.acpSessionId) {
      try {
        await record.conn.cancel({ sessionId: record.acpSessionId });
      } catch (error) {
        logger.warn('AcpHostService.stop: ACP cancel failed; killing the process', { id, error: summarizeError(error) });
      }
    }
    record.info.state = 'stopped';
    record.info.completedAt = this.now();
    record.info.pendingPermission = undefined;
    this.teardown(record);
    return true;
  }

  /** Drop terminal records (a panel dismiss); live rows are untouched. */
  dismiss(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.info.state !== 'stopped' && record.info.state !== 'failed') return false;
    this.records.delete(id);
    return true;
  }

  private teardown(record: HostedRecord): void {
    try {
      record.child?.kill();
    } catch (error) {
      logger.warn('AcpHostService: child kill failed', { id: record.info.id, error: summarizeError(error) });
    }
    record.child = null;
    record.conn = null;
    record.acpSessionId = null;
  }

  private buildClient(record: HostedRecord): Client {
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const toolTitle = params.toolCall?.title ?? 'unknown tool';
        const approveOptionId = params.options[0]?.optionId ?? 'allow';
        // Waiting-on-human: the row classifies as awaiting-approval while the
        // ask is pending — glyph/count/jump/push inherit from the fleet
        // attention classification.
        const priorState = record.info.state;
        record.info.state = 'awaiting-approval';
        record.info.pendingPermission = toolTitle;
        const handler = this.deps.requestPermission ?? (async () => ({ approved: false, remember: false }));
        try {
          const { approved } = await handler({
            callId: `acp-host-${record.info.id}-${this.now()}`,
            tool: toolTitle,
            args: (params.toolCall?.rawInput as Record<string, unknown>) ?? {},
            category: 'delegate',
            analysis: analyzePermissionRequest(toolTitle, (params.toolCall?.rawInput as Record<string, unknown>) ?? {}, 'delegate'),
          });
          return approved
            ? { outcome: { outcome: 'selected', optionId: approveOptionId } } as RequestPermissionResponse
            : { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse;
        } finally {
          if (record.info.state === 'awaiting-approval') {
            record.info.state = priorState === 'awaiting-approval' ? 'prompting' : priorState;
          }
          record.info.pendingPermission = undefined;
        }
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update as { sessionUpdate?: unknown; content?: unknown };
        if (update.sessionUpdate !== 'agent_message_chunk') return;
        // ACP sends `content` as ONE ContentBlock; tolerate the array shape too.
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        const text = blocks
          .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (text) {
          record.info.progress = ((record.info.progress ?? '') + text).slice(-PROGRESS_TAIL_CHARS);
        }
      },
    };
  }
}
