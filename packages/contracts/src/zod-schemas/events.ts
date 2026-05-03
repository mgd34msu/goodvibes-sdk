import { z } from 'zod/v4';

/**
 * Schema for the SSE / WebSocket serialized event envelope that wraps all
 * realtime domain events.
 *
 * Matches `SerializedEventEnvelope<unknown>` from transport-realtime.
 */
export const SerializedEventEnvelopeSchema = z.object({
  type: z.string(),
  ts: z.number().optional(),
  traceId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  payload: z.unknown(),
});

export type SerializedEventEnvelopeShape = z.infer<typeof SerializedEventEnvelopeSchema>;

/**
 * Schema for a typed SSE / WS event envelope where the payload is a known
 * runtime event record (has a `type` discriminant string).
 */
export const RuntimeEventRecordSchema = z.object({
  type: z.string(),
}).catchall(z.unknown());

export const TypedSerializedEventEnvelopeSchema = SerializedEventEnvelopeSchema.extend({
  payload: RuntimeEventRecordSchema,
});

export type TypedSerializedEventEnvelopeShape = z.infer<typeof TypedSerializedEventEnvelopeSchema>;
