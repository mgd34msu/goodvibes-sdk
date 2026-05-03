import { logger } from '../utils/logger.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentEvent } from '../../events/agents.js';

export type SharedSessionAgentCompletion = (
  sessionId: string,
  agentId: string,
  body: string,
  metadata?: Record<string, unknown>,
) => Promise<unknown>;

export class SharedSessionRuntimeBusBridge {
  private busAttached = false;
  private busUnsubs: Array<() => void> = [];

  attach(
    bus: RuntimeEventBus,
    sessionResolver: (agentId: string) => string | null,
    completeAgent: SharedSessionAgentCompletion,
  ): () => void {
    if (this.busAttached) {
      logger.warn('[SharedSessionBroker] attachRuntimeBus called more than once — ignoring duplicate call', {});
      return () => {};
    }
    this.busAttached = true;
    const onCompleted = bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>(
      'AGENT_COMPLETED',
      (envelope) => {
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.output ?? '',
          { status: 'completed', durationMs: envelope.payload.durationMs },
        ).catch((error) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_COMPLETED', { error: String(error) });
        });
      },
    );
    const onFailed = bus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>(
      'AGENT_FAILED',
      (envelope) => {
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.error,
          { status: 'failed', durationMs: envelope.payload.durationMs },
        ).catch((error) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_FAILED', { error: String(error) });
        });
      },
    );
    const onCancelled = bus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>(
      'AGENT_CANCELLED',
      (envelope) => {
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.reason ?? 'cancelled',
          { status: 'cancelled' },
        ).catch((error) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_CANCELLED', { error: String(error) });
        });
      },
    );
    this.busUnsubs.push(onCompleted, onFailed, onCancelled);
    return () => {
      onCompleted();
      onFailed();
      onCancelled();
      this.busAttached = false;
      this.busUnsubs = this.busUnsubs.filter(
        (fn) => fn !== onCompleted && fn !== onFailed && fn !== onCancelled,
      );
    };
  }

  stopAll(): void {
    for (const unsubscribe of this.busUnsubs) {
      try {
        unsubscribe();
      } catch (error) {
        logger.warn('SharedSessionBroker bus unsubscribe failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.busUnsubs = [];
    this.busAttached = false;
  }
}
