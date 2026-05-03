import { createUuidV4 } from './uuid.js';

export interface EventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly ts: number;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly source?: string;
  readonly payload: TPayload;
}

export interface EventEnvelopeContext {
  readonly sessionId: string;
  readonly source: string;
  readonly traceId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
}

export function createEventEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: EventEnvelopeContext,
): EventEnvelope<TType, TPayload> {
  return Object.freeze({
    type,
    ts: Date.now(),
    // Callers that want multiple fan-out envelopes correlated under one trace
    // must provide a shared traceId; this helper only creates a traceId when no
    // correlation context was supplied.
    traceId: context.traceId ?? createUuidV4(),
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.agentId,
    taskId: context.taskId,
    source: context.source,
    payload,
  });
}
