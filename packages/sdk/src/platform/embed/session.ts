/**
 * embed/session.ts
 *
 * The thin, in-process embedding facade over the existing daemon boot factory.
 * It invents no runtime machinery: it wires `bootDaemon` to the daemon's
 * already-exposed runtime event bus, shared session broker, and approval broker,
 * and adds one convenience — bridging an injected `PermissionRequestHandler`
 * onto the broker so an embedder can answer permission asks with a callback
 * instead of driving the HTTP approvals routes.
 *
 * This is the substrate the ACP adapter (`../acp/agent`) drives: create a
 * session against a workspace, submit input, subscribe to typed events, answer
 * permission asks, and shut down.
 */

import { randomUUID } from 'node:crypto';
import { bootDaemon, type BootDaemonOptions } from '../daemon/boot.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ApprovalBroker, SharedSessionBroker } from '../control-plane/index.js';
import type { SharedSessionSubmission } from '../control-plane/session-types.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { PermissionRequestHandler } from '../permissions/prompt.js';
import type { McpServerConfig } from '../mcp/config.js';
import { logger } from '../utils/logger.js';

/** Options for {@link createEmbeddedSession}. */
export interface EmbedSessionOptions {
  /** The workspace / project root the session operates against. */
  readonly workspace: string;
  /** Injected home directory — the daemon stays entirely inside it. */
  readonly homeDirectory: string;
  /** Bearer token required by the HTTP surface. Omit for session-based auth. */
  readonly token?: string | undefined;
  /**
   * A callback that answers permission asks. When provided, every pending
   * approval on the session's broker is routed to it and resolved with its
   * decision. Omit to resolve approvals another way (HTTP routes, direct broker).
   */
  readonly requestPermission?: PermissionRequestHandler | undefined;
  /** Transport surface kind attributed to submitted input. Default `webhook`. */
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  /** Stable surface id for this embedder. Default a generated `embed-<uuid>`. */
  readonly surfaceId?: string | undefined;
  /**
   * MCP servers to connect into the session's tool surface at boot (e.g. the
   * servers an ACP client declares in `session/new`). Each is connected through
   * the daemon's live MCP registry (tools namespaced `mcp:<name>:<tool>`). stdio
   * transport only — the registry spawns a process. A server that fails to
   * connect is logged and skipped; it never aborts session creation.
   */
  readonly mcpServers?: readonly McpServerConfig[] | undefined;
  /** Escape hatch for the remaining boot options (port, host, serveFactory…). */
  readonly boot?: Partial<Omit<BootDaemonOptions, 'workingDir' | 'homeDirectory' | 'token'>> | undefined;
}

/** Structured input to {@link EmbeddedSession.submit}. */
export interface EmbeddedSessionInput {
  readonly body: string;
  readonly title?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** A live embedded GoodVibes session. */
export interface EmbeddedSession {
  /** The workspace this session operates against. */
  readonly workspace: string;
  /** Base URL of the underlying daemon's HTTP surface. */
  readonly url: string;
  /** The runtime event bus — subscribe with `.on(type, cb)` / `.onDomain(domain, cb)`. */
  readonly events: RuntimeEventBus;
  /** The approval broker — the seam permission asks flow through. */
  readonly approvals: ApprovalBroker;
  /** The shared session broker backing this session. */
  readonly sessions: SharedSessionBroker;
  /** Submit input to the session. Returns the broker's submission record. */
  submit(input: string | EmbeddedSessionInput): Promise<SharedSessionSubmission>;
  /**
   * Cancel the in-flight work for one or more running agents (the agent ids a
   * submission reported as `activeAgentId`). This is a REAL cancellation: it
   * aborts the agent's in-flight provider call so the turn stops mid-flight and
   * emits its cancelled outcome, rather than only cancelling a still-queued
   * input. Unknown ids are ignored. Returns the number of agents actually
   * cancelled.
   */
  cancelActive(agentIds: Iterable<string>): number;
  /** Tear down the session and release the port. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Create an embedded GoodVibes session bound to a workspace. Boots an in-process
 * daemon, exposes its runtime bus / session broker / approval broker, and — when
 * a `requestPermission` callback is given — bridges pending approvals to it.
 */
export async function createEmbeddedSession(options: EmbedSessionOptions): Promise<EmbeddedSession> {
  const daemon = await bootDaemon({
    workingDir: options.workspace,
    homeDirectory: options.homeDirectory,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.boot ?? {}),
  });
  const server = daemon.server;
  const events = server.eventBus;
  const sessions = server.sessions;
  const approvals = daemon.approvals;
  const surfaceKind: AutomationSurfaceKind = options.surfaceKind ?? 'webhook';
  const surfaceId = options.surfaceId ?? `embed-${randomUUID()}`;

  // Connect any embedder-declared MCP servers (e.g. an ACP client's session/new
  // servers) into the live MCP registry so their tools join the session surface.
  // A single server's failure is logged and skipped — it never aborts the session.
  for (const mcpServer of options.mcpServers ?? []) {
    try {
      await server.registerMcpServer(mcpServer);
    } catch (error) {
      logger.warn('createEmbeddedSession: failed to connect declared MCP server', {
        server: mcpServer.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Bridge an injected permission callback onto the broker: each pending
  // approval is answered by the callback and resolved with its decision.
  let unsubscribe: (() => void) | undefined;
  if (options.requestPermission) {
    const handler = options.requestPermission;
    const handled = new Set<string>();
    unsubscribe = approvals.subscribe((approval) => {
      if (approval.status !== 'pending' || handled.has(approval.id)) return;
      handled.add(approval.id);
      void handler(approval.request)
        .then((decision) =>
          approvals.resolveApproval(approval.id, {
            approved: decision.approved,
            actor: 'embed',
            actorSurface: 'embed',
            ...(decision.remember !== undefined ? { remember: decision.remember } : {}),
            ...(decision.modifiedArgs !== undefined ? { modifiedArgs: decision.modifiedArgs } : {}),
          }),
        )
        .catch(() => approvals.resolveApproval(approval.id, { approved: false, actor: 'embed', actorSurface: 'embed' }));
    });
  }

  return {
    workspace: options.workspace,
    url: daemon.url,
    events,
    approvals,
    sessions,
    submit: (input) => {
      const body = typeof input === 'string' ? input : input.body;
      const structured = typeof input === 'string' ? undefined : input;
      return sessions.submitMessage({
        surfaceKind,
        surfaceId,
        body,
        ...(structured?.sessionId !== undefined ? { sessionId: structured.sessionId } : {}),
        ...(structured?.title !== undefined ? { title: structured.title } : {}),
        ...(structured?.metadata !== undefined ? { metadata: structured.metadata } : {}),
      });
    },
    cancelActive: (agentIds) => {
      let cancelled = 0;
      for (const agentId of agentIds) {
        if (server.cancelAgent(agentId)) cancelled += 1;
      }
      return cancelled;
    },
    stop: async () => {
      unsubscribe?.();
      await daemon.stop();
    },
  };
}
