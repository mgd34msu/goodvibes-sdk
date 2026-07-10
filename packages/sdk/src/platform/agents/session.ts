import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { ConversationManager } from '../core/conversation.js';
import { KVState } from '../state/kv-state.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  type AtRestPolicy,
  DEFAULT_AT_REST_POLICY,
  redactAtRestLine,
  enforceJournalDirectoryRetention,
} from '../runtime/at-rest-persistence.js';

export interface AgentSessionPaths {
  readonly sessionsDir: string;
  readonly stateDir: string;
}

function resolveAgentSessionPaths(paths: AgentSessionPaths): AgentSessionPaths {
  if (!paths.sessionsDir || paths.sessionsDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty sessionsDir');
  }
  if (!paths.stateDir || paths.stateDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty stateDir');
  }
  return paths;
}

/**
 * AgentSession — Isolated session context for a spawned agent.
 *
 * Each agent gets its own ConversationManager, KVState namespace,
 * and JSONL message log file.
 */
export class AgentSession {
  /** The agent's unique identifier. */
  readonly agentId: string;

  /** Guard to ensure session directory is only created once. */
  private dirCreated = false;

  /** Isolated conversation history for this agent. */
  readonly conversation: ConversationManager;

  /** KV state namespaced under agentId. */
  readonly kvState: KVState;

  /** Path to the agent's JSONL message log. */
  readonly sessionFile: string;

  /** The at-rest redaction + retention policy for this journal. */
  private readonly atRestPolicy: AtRestPolicy;

  constructor(
    agentId: string,
    model: string,
    provider: string,
    paths: AgentSessionPaths,
    atRestPolicy: AtRestPolicy = DEFAULT_AT_REST_POLICY,
  ) {
    this.agentId = agentId;
    this.atRestPolicy = atRestPolicy;
    const resolvedPaths = resolveAgentSessionPaths(paths);

    // Retention enforcement point (checkpoint-gc lesson: gc that is never called
    // reclaims nothing). Each new agent journal prunes stale/oversized sibling
    // journals in the sessions dir before it starts writing its own.
    try {
      enforceJournalDirectoryRetention(resolvedPaths.sessionsDir, this.atRestPolicy);
    } catch (err) {
      logger.debug('AgentSession journal retention skipped', { agentId, error: summarizeError(err) });
    }

    // Own ConversationManager — not shared with main session
    this.conversation = new ConversationManager();

    // KV state namespaced to this agent
    this.kvState = new KVState({ sessionId: agentId, stateDir: resolvedPaths.stateDir });

    // JSONL log path
    this.sessionFile = join(resolvedPaths.sessionsDir, `${agentId}.jsonl`);

    // Write a session-start entry
    this._ensureSessionDir();
    this.appendMessage({
      type: 'meta',
      agentId,
      model,
      provider,
      title: '',
      timestamp: Date.now(),
    });

    logger.debug('AgentSession created', { agentId, model, provider });
  }

  /**
   * Append a message record to the agent's JSONL log.
   * Each record is written as a single JSON line.
   */
  appendMessage(msg: Record<string, unknown>): void {
    try {
      if (!this.dirCreated) {
        this._ensureSessionDir();
      }
      const serialized = JSON.stringify(msg);
      const line = this.atRestPolicy.redact ? redactAtRestLine(serialized) : serialized;
      appendFileSync(this.sessionFile, line + '\n', 'utf-8');
    } catch (err) {
      logger.error('AgentSession.appendMessage failed', { agentId: this.agentId, error: summarizeError(err) });
    }
  }

  /**
   * Clean up resources held by this session.
   * Flushes and disposes the KV state.
   */
  async dispose(): Promise<void> {
    try {
      await this.kvState.dispose();
    } catch (err) {
      logger.error('AgentSession.dispose failed', { agentId: this.agentId, error: summarizeError(err) });
    }
    logger.debug('AgentSession disposed', { agentId: this.agentId });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _ensureSessionDir(): void {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    this.dirCreated = true;
  }
}
