import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ContentPart, LLMProvider } from '../providers/interface.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { SessionLineageTracker } from './session-lineage.js';
import type { IdempotencyStore } from '../runtime/idempotency/index.js';
import { estimateTokens } from './context-compaction.js';
import type { AdaptivePlanner } from './adaptive-planner.js';
import type { ExecutionPlanManager } from './execution-plan.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { FavoritesStore } from '../providers/favorites.js';
import type { TurnKnowledgeRegistrySource, TurnCodeIndexSource } from '../agents/turn-knowledge-injection.js';
import type { CodeIndexReindexScheduler } from '../state/code-index-reindex.js';

export type OrchestratorCoreServices = {
  configManager?: Pick<ConfigManager, 'get' | 'getCategory' | 'getWorkingDirectory'> | undefined;
  providerRegistry?: ProviderRegistry | undefined;
  cacheHitTracker?: Pick<CacheHitTracker, 'getMetrics'> | undefined;
  sessionLineageTracker?: SessionLineageTracker | undefined;
  idempotencyStore?: IdempotencyStore | undefined;
  planManager?: Pick<
    ExecutionPlanManager,
    | 'getActive'
    | 'getSummary'
    | 'getNextItems'
    | 'toMarkdown'
    | 'create'
    | 'save'
    | 'parseFromMarkdown'
    | 'replaceItems'
    | 'load'
    | 'updateItem'
  >;
  adaptivePlanner?: Pick<
    AdaptivePlanner,
    'select' | 'getMode' | 'setMode' | 'explain' | 'override' | 'clearOverride' | 'getOverride' | 'getLatest'
  >;
  sessionMemoryStore?: Pick<SessionMemoryStore, 'list'> | undefined;
  favoritesStore?: Pick<FavoritesStore, 'recordUsage'> | undefined;
  /**
   * Narrow injection seam for the MAIN interactive session's per-turn
   * passive knowledge injection (see core/orchestrator-turn-loop.ts). Optional/undefined
   * is a hard no-op — the feature never runs and the base system prompt is
   * byte-identical, matching the agent path's `memoryRegistry` semantics. Wired
   * in post-construction via `Orchestrator.setCoreServices({ memoryRegistry })` since,
   * like `sessionMemoryStore`/`planManager` above, it is not required at construction
   * time.
   */
  memoryRegistry?: TurnKnowledgeRegistrySource | undefined;
  /**
   * Stage B code-index injection seam for the MAIN interactive session. Optional/
   * undefined is a hard no-op (memory-only injection, base prompt byte-identical). Whether code
   * hits are actually injected is additionally gated by the `agent-passive-code-injection`
   * gate (off by default via agents.passiveInjection.code) and `isCodeInjectionSettingEnabled` below — both must hold.
   */
  codeIndex?: TurnCodeIndexSource | undefined;
  /**
   * Live gate for the embedder's storage.codeIndexEnabled setting. Undefined defaults to
   * "allowed" — the capability gate alone then governs. ANDed with the gate each turn so a runtime
   * toggle of either takes effect without reconstructing the orchestrator.
   */
  isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  /**
   * Stage B tool-site reindex scheduler. Optional/undefined is a hard no-op. When wired,
   * a successful write/edit tool call schedules a debounced incremental reindex of the touched
   * path(s) (never blocking the tool result).
   */
  codeIndexReindexScheduler?: Pick<CodeIndexReindexScheduler, 'onToolExecuted'> | undefined;
};

export function normalizeUsage(
  usage: Awaited<ReturnType<LLMProvider['chat']>>['usage'],
): Awaited<ReturnType<LLMProvider['chat']>>['usage'] {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const hasExplicitCacheBreakout = Object.prototype.hasOwnProperty.call(usage, 'cacheWriteTokens');
  const freshInputTokens = hasExplicitCacheBreakout
    ? usage.inputTokens
    : Math.max(0, usage.inputTokens - cacheReadTokens);
  return {
    ...usage,
    inputTokens: freshInputTokens,
  };
}

export function estimateFreshTurnInputTokens(
  lastInputTokens: number,
  currentEstimatedTokens: number,
  text: string,
  content?: ContentPart[],
): number {
  const explicitContentTokens = content?.reduce((sum, part) => {
    if (part.type === 'text') return sum + estimateTextTokens(part.text);
    return sum;
  }, 0) ?? 0;
  const currentTurnPayloadTokens = Math.max(explicitContentTokens, estimateTextTokens(text));

  if (lastInputTokens <= 0) {
    return Math.max(currentEstimatedTokens, currentTurnPayloadTokens);
  }

  const deltaFromPreviousContext = currentEstimatedTokens - lastInputTokens;
  if (deltaFromPreviousContext > 0) {
    return Math.max(deltaFromPreviousContext, currentTurnPayloadTokens);
  }

  if (currentEstimatedTokens < Math.floor(lastInputTokens * 0.8)) {
    return Math.max(currentEstimatedTokens, currentTurnPayloadTokens);
  }

  return currentTurnPayloadTokens;
}

export function getSessionLineageTracker(
  services: OrchestratorCoreServices,
  ownedSessionLineageTracker: SessionLineageTracker,
): SessionLineageTracker {
  return services.sessionLineageTracker ?? ownedSessionLineageTracker;
}

export function getIdempotencyStore(
  services: OrchestratorCoreServices,
  ownedIdempotencyStore: IdempotencyStore,
): IdempotencyStore {
  return services.idempotencyStore ?? ownedIdempotencyStore;
}

export function requireConfigManager(
  services: OrchestratorCoreServices,
): Pick<ConfigManager, 'get' | 'getCategory' | 'getWorkingDirectory'> {
  if (!services.configManager) {
    throw new Error('Orchestrator requires configManager in core services');
  }
  return services.configManager;
}

export function requireProviderRegistry(services: OrchestratorCoreServices): ProviderRegistry {
  if (!services.providerRegistry) {
    throw new Error('Orchestrator requires providerRegistry in core services');
  }
  return services.providerRegistry;
}

export function getCacheHitTracker(
  services: OrchestratorCoreServices,
  ownedCacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>,
): Pick<CacheHitTracker, 'getMetrics'> {
  return services.cacheHitTracker ?? ownedCacheHitTracker;
}

export function createEmitterContext(
  sessionId: string,
  turnId: string,
): import('../runtime/emitters/index.js').EmitterContext {
  return {
    sessionId,
    traceId: `${sessionId}:${turnId}`,
    source: 'orchestrator',
  };
}

function estimateTextTokens(text: string): number {
  return estimateTokens(text);
}
