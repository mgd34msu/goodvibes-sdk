/**
 * routes/attribution-ingest.ts — the runtime-bus → cost-attribution ingest.
 *
 * LLM usage lands from LLM_RESPONSE_RECEIVED turn events (with agent /
 * tool / hook / MCP origin dimensions and quota-window snapshots from
 * rate-limit headers). Metered VOICE spend rides the same ledger from
 * PROVIDER_VOICE_USAGE events: the billable unit count lands on inputTokens
 * under a voice-scoped model key (e.g. `elevenlabs:voice-tts:characters`),
 * honestly UNPRICED until the one-key manual price (pricing.modelPrices)
 * names the USD per 1M units. Local voice engines never emit the event —
 * no billing dimension at all, never a fake $0.00.
 */
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { CostAttributionService } from '../../runtime/cost/attribution.js';
import type { QuotaWindowTracker } from '../../runtime/cost/quota-window.js';

export function bindCostAttributionIngest(
  bus: Pick<RuntimeEventBus, 'onDomain'>,
  costAttribution: Pick<CostAttributionService, 'record'>,
  quotaWindow: Pick<QuotaWindowTracker, 'record'>,
): void {
  bus.onDomain('providers', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'PROVIDER_VOICE_USAGE') {
      costAttribution.record({
        at: Date.now(),
        provider: event.provider,
        model: `${event.provider}:voice-${event.kind}:${event.unit}`,
        sessionId: envelope.sessionId,
        inputTokens: event.billableUnits,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  });
  bus.onDomain('turn', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'LLM_RESPONSE_RECEIVED') {
      costAttribution.record({
        at: Date.now(),
        provider: event.provider,
        model: event.model,
        sessionId: envelope.sessionId,
        // Attribution dimensions: the agent (from the envelope) and the
        // tool/hook/MCP-server cause (stamped by the cost-origin scope); each
        // stays undefined when the emit carried no such origin.
        ...(envelope.agentId !== undefined ? { agentId: envelope.agentId } : {}),
        ...(event.originTool !== undefined ? { tool: event.originTool } : {}),
        ...(event.originHook !== undefined ? { hook: event.originHook } : {}),
        ...(event.originMcpServer !== undefined ? { mcpServer: event.originMcpServer } : {}),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheWriteTokens ?? 0,
      });
      // Quota snapshot from rate-limit headers on THIS (successful) response —
      // the pre-limit signal, not just the post-429 cooldown.
      if (event.rateLimit) {
        quotaWindow.record({
          provider: event.provider,
          at: Date.now(),
          ...(event.rateLimit.limit !== undefined ? { limit: event.rateLimit.limit } : {}),
          ...(event.rateLimit.remaining !== undefined ? { remaining: event.rateLimit.remaining } : {}),
          ...(event.rateLimit.resetAt !== undefined ? { resetAt: event.rateLimit.resetAt } : {}),
          ...(event.rateLimit.retryAfterMs !== undefined ? { retryAfterMs: event.rateLimit.retryAfterMs } : {}),
        });
      }
    } else if (event.type === 'STREAM_RETRY' && isRateLimitReason(event.reason)) {
      // A rate-limit retry carries the provider's requested backoff — the real
      // cooldown window the fan-out assessment reasons over.
      quotaWindow.record({ provider: event.provider, at: Date.now(), retryAfterMs: event.delayMs });
    }
  });
}

/** Whether a STREAM_RETRY reason names a rate-limit/quota condition. */
function isRateLimitReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return lower.includes('rate') || lower.includes('quota') || lower.includes('429') || lower.includes('limit') || lower.includes('overloaded');
}
