/**
 * agents/orchestrator-runner-context-window.ts
 *
 * How a single agent turn is kept inside the active model's context window,
 * and how the model backing that window is identified in the first place.
 *
 * Split out of orchestrator-runner.ts, which had reached its grandfathered
 * ceiling. The runner keeps the turn loop; this module owns the two questions
 * the loop asks once per turn and nothing else:
 *
 *  - WHICH model definition is actually in play. A route can name its model
 *    provider-qualified (`provider:key`) or bare, and the requested id and the
 *    resolved id can differ after a fallback, so the registry is searched by
 *    exact provider+registryKey first and only then by bare model id — a bare
 *    match on the wrong provider would report someone else's context window.
 *  - WHETHER this turn still fits, and what to drop when it does not. The
 *    estimate covers messages, system prompt and tool schemas together, because
 *    a turn is refused for their SUM; compaction takes the conversation first
 *    and only trims the system prompt when the messages alone did not free
 *    enough room.
 *
 * The compaction threshold is read from config per call rather than captured,
 * so `agents.contextCompactThreshold` is a live setting rather than a
 * restart-only one.
 */
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelDefinition } from '../providers/registry-types.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';
import { logger } from '../utils/logger.js';
import {
  estimateTokens,
  estimateConversationTokens,
  compactSmallWindow,
} from '../core/context-compaction.js';
import { ConversationManager } from '../core/conversation.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { LLMProvider } from '../providers/interface.js';
import { buildLayeredOrchestratorSystemPrompt } from './orchestrator-prompts.js';
import type { AgentOrchestratorRunContext } from './orchestrator-runner.js';

/** Fraction of the context window at which compaction is triggered (default fallback). */
const CONTEXT_COMPACT_THRESHOLD = 0.85;
/** Don't attempt LLM-driven compaction below this token floor. */
const MIN_WINDOW_FOR_LLM_COMPACT = 12_000;

/**
 * Fraction of the context window at which compaction is triggered — from config
 * (agents.contextCompactThreshold) when a config source is present, else the
 * module default (identical value, so behaviour is unchanged by default).
 */
export function resolveContextCompactThreshold(context: AgentOrchestratorRunContext): number {
  return context.configManager?.get('agents.contextCompactThreshold') ?? CONTEXT_COMPACT_THRESHOLD;
}

export type ActiveProviderRoute = {
  readonly provider: Pick<LLMProvider, 'name'>;
  readonly modelId: string;
  readonly requestedModelId: string;
};

function parseProviderQualifiedRouteId(modelId: string | undefined): { providerId: string; registryKey: string } | null {
  const trimmed = modelId?.trim();
  if (!trimmed?.includes(':')) return null;
  try {
    const { providerId } = splitModelRegistryKey(trimmed);
    return { providerId, registryKey: trimmed };
  } catch {
    return null;
  }
}

export function providerQualifiedRouteLabel(activeRoute: ActiveProviderRoute): string {
  return (
    parseProviderQualifiedRouteId(activeRoute.requestedModelId)?.registryKey
    ?? parseProviderQualifiedRouteId(activeRoute.modelId)?.registryKey
    ?? `${activeRoute.provider.name}:${activeRoute.requestedModelId || activeRoute.modelId}`
  );
}

export function resolveContextWindowModelDefinition(
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'listModels'>,
  activeRoute: ActiveProviderRoute,
): ModelDefinition {
  const models = providerRegistry.listModels();
  const providerQualifiedRouteIds = [
    parseProviderQualifiedRouteId(activeRoute.requestedModelId),
    parseProviderQualifiedRouteId(activeRoute.modelId),
  ].filter((routeId): routeId is { providerId: string; registryKey: string } => routeId !== null);

  for (const routeId of providerQualifiedRouteIds) {
    const exactRegistryMatch = models.find(
      (model) => model.provider === routeId.providerId && model.registryKey === routeId.registryKey,
    );
    if (exactRegistryMatch) return exactRegistryMatch;
  }

  const routeProviderId = providerQualifiedRouteIds[0]?.providerId ?? activeRoute.provider.name;
  return models.find(
    (model) =>
      model.provider === routeProviderId &&
      (
        model.id === activeRoute.modelId ||
        model.id === activeRoute.requestedModelId
      ),
  ) ?? providerRegistry.getCurrentModel();
}

export function applyContextWindowAwareness(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  modelId: string,
  modelWindow: number,
  conversation: ConversationManager,
  systemPrompt: string,
  toolTokens: number,
  turn: number,
): string {
  if (!(context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true)) {
    return systemPrompt;
  }

  if (modelWindow === 0) {
    logger.debug(`[agent-context-window-awareness] Context window is 0/unknown for model ${modelId}, skipping context validation`);
    return systemPrompt;
  }

  const compactThreshold = resolveContextCompactThreshold(context);
  const messages = conversation.getMessagesForLLM();
  const msgTokens = estimateConversationTokens(messages);
  const sysTokens = estimateTokens(systemPrompt);
  const totalEstimate = msgTokens + sysTokens + toolTokens;
  const threshold = Math.floor(modelWindow * compactThreshold);

  if (totalEstimate <= threshold) {
    return systemPrompt;
  }

  logger.warn(
    `[AgentOrchestrator] context-window awareness: estimated ${totalEstimate} tokens exceeds ${threshold} (${Math.round(compactThreshold * 100)}% of ${modelWindow}) - compacting`,
    { agentId: record.id, turn, msgTokens, sysTokens, toolTokens, contextWindow: modelWindow },
  );
  record.progress = `Turn ${turn} · Compacting context…`;

  if (modelWindow <= MIN_WINDOW_FOR_LLM_COMPACT) {
    conversation.replaceMessagesForLLM(compactSmallWindow(messages));
  } else {
    conversation.replaceMessagesForLLM(compactSmallWindow(messages, Math.max(10, Math.floor(messages.length / 2))));
  }

  const remainingAfterMsgs = modelWindow - estimateConversationTokens(conversation.getMessagesForLLM()) - toolTokens;
  const currentSysTokens = estimateTokens(systemPrompt);
  if (currentSysTokens > remainingAfterMsgs * compactThreshold) {
    logger.warn(
      `[AgentOrchestrator] context-window awareness: system prompt (${currentSysTokens} tokens) too large for remaining window (${remainingAfterMsgs}) - applying layered trim`,
      { agentId: record.id },
    );
    return buildLayeredOrchestratorSystemPrompt(record, remainingAfterMsgs, context);
  }

  return systemPrompt;
}
