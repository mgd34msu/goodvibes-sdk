// Synced from packages/transport-core/src/event-envelope.ts
export interface EventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly ts: number;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly source: string;
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

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEventEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: EventEnvelopeContext,
): EventEnvelope<TType, TPayload> {
  return Object.freeze({
    type,
    ts: Date.now(),
    traceId: context.traceId ?? generateTraceId(),
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.agentId,
    taskId: context.taskId,
    source: context.source,
    payload,
  });
}
