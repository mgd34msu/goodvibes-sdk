import type { ConversationManager } from './conversation.js';
import type { ConfigManager } from '../config/manager.js';
import type { ModelDefinition, ProviderRegistry } from '../providers/registry.js';
import { logger } from '../utils/logger.js';
import { estimateConversationTokens, COMPACTION_BUFFER_TOKENS, SMALL_WINDOW_THRESHOLD, compactSmallWindow, getAutoCompactDecision } from './context-compaction.js';
import type { CompactionContext } from './context-compaction.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { SessionLineageTracker } from './session-lineage.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { WrfcController } from '../agents/wrfc-controller.js';
import type { ExecutionPlanManager } from './execution-plan.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitOpsContextWarning, emitCompactionReceipt } from '../runtime/emitters/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import type { CompactionReceipt, CompactionStrategyChoice } from './compaction-types.js';
import { CompactionQualityError } from './compaction-types.js';
import { summarizeError } from '../utils/error-display.js';

type EmitterContextFactoryLike = { runtimeBus: RuntimeEventBus | null; emitterContext: EmitterContextFactory; sessionId: string };

/** Emit the mandatory post-compaction receipt so a compaction is never silent. */
function emitReceipt(deps: EmitterContextFactoryLike, turnId: string, receipt: CompactionReceipt): void {
  if (!deps.runtimeBus) return;
  emitCompactionReceipt(deps.runtimeBus, deps.emitterContext(turnId), { sessionId: deps.sessionId, ...receipt });
}

/** Build a `failed` receipt for a compaction that threw before producing a result. */
function failedReceipt(trigger: 'auto' | 'manual', strategy: string, detail: string): CompactionReceipt {
  return {
    trigger, strategy, tokensBefore: 0, tokensAfter: 0, messagesBefore: 0, messagesAfter: 0,
    qualityScore: 0, qualityGrade: 'F', lowQuality: true, instructionsReinjected: false,
    validationPassed: false, sectionsIncluded: [], outcome: 'failed', detail,
  };
}

/** Emit the receipt for a thrown compaction — the guard's kept-original receipt or a failed one. */
function emitCompactionFailureReceipt(deps: EmitterContextFactoryLike, turnId: string, err: unknown, trigger: 'auto' | 'manual', strategy: string): void {
  if (err instanceof CompactionQualityError) emitReceipt(deps, turnId, err.receipt);
  else emitReceipt(deps, turnId, failedReceipt(trigger, strategy, summarizeError(err)));
}

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.js').EmitterContext;

type CatalogTier = 'free' | 'paid' | 'subscription';

function normalizeCatalogTier(tier: ModelDefinition['tier']): CatalogTier | undefined {
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  if (tier === 'standard' || tier === 'premium') return 'paid';
  return undefined;
}

function findLargerContextModels(
  providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>,
  minContext: number,
  tier?: CatalogTier,
  limit = 3,
): Array<{ id: string; displayName: string; context: number }> {
  return providerRegistry
    .listModels()
      .filter((model) => model.selectable)
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        context: providerRegistry.getContextWindowForModel(model),
        tier: normalizeCatalogTier(model.tier),
      }))
    .filter((model) => model.context > minContext && (tier === undefined || model.tier === tier))
    .sort((a, b) => b.context - a.context)
    .slice(0, limit)
    .map(({ id, displayName, context }) => ({ id, displayName, context }));
}

function readAutoCompactThreshold(configManager: Pick<ConfigManager, 'get'>): number {
  const raw = Number(configManager.get('behavior.autoCompactThreshold') ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function formatAutoCompactTrigger(decision: ReturnType<typeof getAutoCompactDecision>): string {
  if (decision.reason === 'safety-buffer') {
    return `leaving ${decision.remainingTokens.toLocaleString()} tokens, inside the ${decision.safetyBufferTokens.toLocaleString()} token safety buffer`;
  }
  return `crossing the ${decision.thresholdPercent}% auto-compact threshold`;
}

/**
 * Set when the model/provider itself reported context exhaustion on a response
 * (see isContextOverflowSignal). Forces compaction at the next opportunity,
 * regardless of locally estimated usage and even when the percentage threshold
 * is disabled — the provider's own report is authoritative over estimates,
 * matching how the reactive strategy treats prompt-too-long errors.
 */
export type ModelContextWarning = {
  provider: string;
  model: string;
  providerStopReason?: string | undefined;
};

function describeModelContextWarning(warning: ModelContextWarning): string {
  const detail = warning.providerStopReason ? ` (${warning.providerStopReason})` : '';
  return `${warning.model} reported its context window is full${detail}`;
}

type AutoCompactionDeps = {
  sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null;
  sessionLineageTracker: Pick<SessionLineageTracker, 'getEntries' | 'getCompactionCount' | 'getOriginalTask'>;
  agentManager: Pick<AgentManager, 'list'>;
  wrfcController: Pick<WrfcController, 'listChains'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  sessionId: string;
  /** Returns the standing system instruction chain to re-inject at compaction. */
  getSystemPrompt?: (() => string) | undefined;
  /** Returns the active skill's frontmatter to re-inject at compaction, if any. */
  getActiveSkillFrontmatter?: (() => string | null | undefined) | undefined;
  /**
   * Resolves the effective compaction strategy (config value gated by the
   * distiller feature flag). Absent → the structured default.
   */
  getCompactionStrategy?: (() => CompactionStrategyChoice) | undefined;
};

function buildAutoCompactionContext(
  deps: AutoCompactionDeps,
  params: {
    messages: CompactionContext['messages'];
    contextWindow: number;
    extractionModelId: string;
    extractionProvider?: string;
  },
): CompactionContext {
  const instructionChain = deps.getSystemPrompt?.().trim() || undefined;
  const activeSkillFrontmatter = deps.getActiveSkillFrontmatter?.()?.trim() || undefined;
  return {
    messages: params.messages,
    sessionMemories: deps.sessionMemoryStore?.list() ?? [],
    lineageEntries: deps.sessionLineageTracker.getEntries(),
    agents: deps.agentManager.list(),
    wrfcChains: deps.wrfcController.listChains(),
    activePlan: deps.planManager?.getActive(deps.sessionId) ?? null,
    compactionCount: deps.sessionLineageTracker.getCompactionCount(),
    originalTask: deps.sessionLineageTracker.getOriginalTask() ?? undefined,
    contextWindow: params.contextWindow,
    trigger: 'auto',
    extractionModelId: params.extractionModelId,
    extractionProvider: params.extractionProvider,
    instructionChain,
    activeSkillFrontmatter,
    strategy: deps.getCompactionStrategy?.() ?? 'structured',
  };
}

export type PreflightDeps = {
  conversation: ConversationManager;
  requestRender: () => void;
  hookDispatcher: HookDispatcherLike | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: ProviderRegistry;
  sessionLineageTracker: Pick<SessionLineageTracker, 'getEntries' | 'getCompactionCount' | 'getOriginalTask'>;
  sessionId: string;
  agentManager: Pick<AgentManager, 'list'>;
  wrfcController: Pick<WrfcController, 'listChains'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  isCompacting: boolean;
  setIsCompacting: (value: boolean) => void;
  modelContextWarning?: ModelContextWarning | null | undefined;
  clearModelContextWarning?: (() => void) | undefined;
  getSystemPrompt?: (() => string) | undefined;
  getActiveSkillFrontmatter?: (() => string | null | undefined) | undefined;
  getCompactionStrategy?: (() => CompactionStrategyChoice) | undefined;
};

export async function checkContextWindowPreflight(
  deps: PreflightDeps,
  turnId: string,
  model: ModelDefinition,
): Promise<'ok' | 'compacted' | 'error'> {
  const contextWindow = deps.providerRegistry.getContextWindowForModel(model);
  const tier = normalizeCatalogTier(model.tier);

  if (contextWindow <= 0) return 'ok';

  const messages = deps.conversation.getMessagesForLLM();
  const estimatedTokens = estimateConversationTokens(messages);
  const threshold = readAutoCompactThreshold(deps.configManager);
  const autoCompactEnabled = threshold > 0;
  const preflightDecision = getAutoCompactDecision({
    currentTokens: estimatedTokens,
    contextWindow,
    isCompacting: deps.isCompacting,
    thresholdPercent: threshold,
  });
  const modelWarning = deps.modelContextWarning ?? null;
  const forcedByModelWarning = modelWarning !== null && !deps.isCompacting;
  if (!forcedByModelWarning && !preflightDecision.shouldCompact && estimatedTokens <= contextWindow) return 'ok';

  if (forcedByModelWarning || (autoCompactEnabled && !deps.isCompacting && preflightDecision.shouldCompact)) {
    deps.clearModelContextWarning?.();
    logger.info('Orchestrator: context window pre-flight - auto-compacting before chat call', {
      modelId: model.id,
      estimatedTokens,
      contextWindow,
      usagePct: Math.round(preflightDecision.usagePct),
      thresholdPercent: preflightDecision.thresholdPercent,
      thresholdTokens: preflightDecision.thresholdTokens,
      remainingTokens: preflightDecision.remainingTokens,
      safetyBufferTokens: preflightDecision.safetyBufferTokens,
      reason: forcedByModelWarning ? 'model-warning' : preflightDecision.reason,
      ...(modelWarning?.providerStopReason ? { providerStopReason: modelWarning.providerStopReason } : {}),
    });

    deps.setIsCompacting(true);
    deps.conversation.addSystemMessage(
      forcedByModelWarning && modelWarning
        ? `${describeModelContextWarning(modelWarning)}. Auto-compacting before the next request, regardless of the ~${Math.round(preflightDecision.usagePct)}% estimated usage...`
        : `Context pre-check: request is at ${Math.round(preflightDecision.usagePct)}% (${estimatedTokens}/${contextWindow} tokens), ${formatAutoCompactTrigger(preflightDecision)}. Auto-compacting...`
    );
    deps.requestRender();

    if (deps.hookDispatcher) {
      const preResult = await deps.hookDispatcher.fire({
        path: 'Pre:compact:preflight',
        phase: 'Pre',
        category: 'compact',
        specific: 'preflight',
        sessionId: deps.sessionId,
        timestamp: Date.now(),
        payload: {
          trigger: 'preflight',
          estimatedTokens,
          contextWindow,
          usagePct: Math.round(preflightDecision.usagePct),
          thresholdPercent: preflightDecision.thresholdPercent,
          thresholdTokens: preflightDecision.thresholdTokens,
          remainingTokens: preflightDecision.remainingTokens,
          safetyBufferTokens: preflightDecision.safetyBufferTokens,
          reason: forcedByModelWarning ? 'model-warning' : preflightDecision.reason,
        },
      }).catch((err: unknown): HookResult => {
        logger.warn('Pre:compact:preflight hook error', { error: summarizeError(err) });
        return { ok: true };
      });
      if (preResult.decision === 'deny') {
        deps.setIsCompacting(false);
        logger.info('Orchestrator: Pre:compact:preflight denied by hook - skipping preflight compact', { reason: preResult.reason });
        return 'ok';
      }
    }

    try {
      const preflightCtx = buildAutoCompactionContext(deps, {
        messages,
        contextWindow,
        extractionModelId: model.registryKey,
        extractionProvider: model.provider,
      });
      const preflightReceipt = await deps.conversation.compact(deps.providerRegistry, model.registryKey, 'auto', model.provider, preflightCtx);
      if (preflightReceipt) emitReceipt(deps, turnId, preflightReceipt);
      deps.conversation.addSystemMessage('Context compacted. Retrying request...');
      if (deps.hookDispatcher) {
        deps.hookDispatcher.fire({
          path: 'Post:compact:preflight',
          phase: 'Post',
          category: 'compact',
          specific: 'preflight',
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: {
            trigger: 'preflight',
            estimatedTokens,
            contextWindow,
            usagePct: Math.round(preflightDecision.usagePct),
            thresholdPercent: preflightDecision.thresholdPercent,
            thresholdTokens: preflightDecision.thresholdTokens,
            remainingTokens: preflightDecision.remainingTokens,
            safetyBufferTokens: preflightDecision.safetyBufferTokens,
            reason: forcedByModelWarning ? 'model-warning' : preflightDecision.reason,
          },
        }).catch((err: unknown) => { logger.warn('Post:compact:preflight hook error', { error: summarizeError(err) }); });
      }
    } catch (compactErr) {
      const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
      logger.error('Orchestrator: pre-flight compact failed', { error: msg });
      emitCompactionFailureReceipt(deps, turnId, compactErr, 'auto', 'structured');
      deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}.`);
      if (deps.hookDispatcher) {
        deps.hookDispatcher.fire({
          path: 'Fail:compact:preflight',
          phase: 'Fail',
          category: 'compact',
          specific: 'preflight',
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: {
            trigger: 'preflight',
            estimatedTokens,
            contextWindow,
            usagePct: Math.round(preflightDecision.usagePct),
            thresholdPercent: preflightDecision.thresholdPercent,
            thresholdTokens: preflightDecision.thresholdTokens,
            remainingTokens: preflightDecision.remainingTokens,
            safetyBufferTokens: preflightDecision.safetyBufferTokens,
            reason: forcedByModelWarning ? 'model-warning' : preflightDecision.reason,
            error: msg,
          },
        }).catch((err: unknown) => { logger.warn('Fail:compact:preflight hook error', { error: summarizeError(err) }); });
      }
    } finally {
      deps.setIsCompacting(false);
    }

    const tokensAfter = estimateConversationTokens(deps.conversation.getMessagesForLLM());
    if (tokensAfter <= contextWindow) {
      return 'compacted';
    }

    emitContextOverflowError(
      deps.conversation,
      deps.requestRender,
      turnId,
      estimatedTokens,
      contextWindow,
      model.displayName,
      deps.providerRegistry,
      tier,
    );
    return 'error';
  }

  emitContextOverflowError(
    deps.conversation,
    deps.requestRender,
    turnId,
    estimatedTokens,
    contextWindow,
    model.displayName,
    deps.providerRegistry,
    tier,
  );
  return 'error';
}

export function emitContextOverflowError(
  conversation: { addSystemMessage: (message: string) => void },
  requestRender: () => void,
  _turnId: string,
  estimatedTokens: number,
  contextWindow: number,
  modelDisplayName: string,
  providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>,
  tier?: CatalogTier,
): void {
  const requestK = Math.round(estimatedTokens / 1000);
  const contextK = Math.round(contextWindow / 1000);
  const alternatives = findLargerContextModels(providerRegistry, contextWindow, tier, 3);

  let msg =
    `Request (~${requestK}K tokens) exceeds ${modelDisplayName} context window (${contextK}K). ` +
    `Use /compact to reduce context or switch to a larger model.`;

  if (alternatives.length > 0) {
    const altNames = alternatives.map(a => `${a.displayName} (${Math.round(a.context / 1000)}K)`).join(', ');
    msg += ` Larger-context alternatives: ${altNames}.`;
  }

  logger.warn('Orchestrator: context window overflow', {
    estimatedTokens,
    contextWindow,
    modelDisplayName,
    alternatives: alternatives.map(a => a.id),
  });

  conversation.addSystemMessage(msg);
  requestRender();
}

export type PostTurnContextDeps = {
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list'>;
  wrfcController: Pick<WrfcController, 'listChains'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  hookDispatcher: HookDispatcherLike | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: ProviderRegistry;
  sessionLineageTracker: Pick<SessionLineageTracker, 'getEntries' | 'getCompactionCount' | 'getOriginalTask'>;
  sessionId: string;
  requestRender: () => void;
  isCompacting: boolean;
  setIsCompacting: (value: boolean) => void;
  lastWarningBracket: number;
  setLastWarningBracket: (value: number) => void;
  modelContextWarning?: ModelContextWarning | null | undefined;
  clearModelContextWarning?: (() => void) | undefined;
  getSystemPrompt?: (() => string) | undefined;
  getActiveSkillFrontmatter?: (() => string | null | undefined) | undefined;
};

export async function handlePostTurnContextMaintenance(
  deps: PostTurnContextDeps,
  turnId: string,
  totalTokens: number,
): Promise<void> {
  const currentModel = deps.providerRegistry.getCurrentModel();
  const maxTokens = deps.providerRegistry.getContextWindowForModel(currentModel);
  if (maxTokens <= 0) return;

  const configuredThreshold = readAutoCompactThreshold(deps.configManager);
  const warningsEnabled = deps.configManager.get('behavior.staleContextWarnings') as boolean;
  const autoCompactEnabled = configuredThreshold > 0;
  const autoDecision = getAutoCompactDecision({
    currentTokens: totalTokens,
    contextWindow: maxTokens,
    isCompacting: deps.isCompacting,
    thresholdPercent: configuredThreshold,
  });
  const usagePct = Math.round(autoDecision.usagePct);
  const bracket = Math.floor(usagePct / 10) * 10;
  const modelWarning = deps.modelContextWarning ?? null;
  const forcedByModelWarning = modelWarning !== null && !deps.isCompacting;

  if (
    forcedByModelWarning ||
    (autoCompactEnabled &&
    autoDecision.shouldCompact)
  ) {
    deps.clearModelContextWarning?.();
    deps.setIsCompacting(true);
    deps.conversation.addSystemMessage(
      forcedByModelWarning && modelWarning
        ? `${describeModelContextWarning(modelWarning)}. Auto-compacting now, regardless of the ~${usagePct}% estimated usage (${totalTokens}/${maxTokens} tokens)...`
        : `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens), ${formatAutoCompactTrigger(autoDecision)}. Auto-compacting conversation...`
    );
    if (deps.runtimeBus) {
      emitOpsContextWarning(deps.runtimeBus, deps.emitterContext(turnId), {
        usage: usagePct,
        threshold: autoDecision.thresholdPercent,
        currentTokens: totalTokens,
        contextWindow: maxTokens,
        thresholdTokens: autoDecision.thresholdTokens,
        remainingTokens: autoDecision.remainingTokens,
        safetyBufferTokens: autoDecision.safetyBufferTokens,
        reason: forcedByModelWarning ? 'model-warning' : (autoDecision.reason ?? 'threshold'),
      });
    }
    deps.requestRender();

    let skipAutoCompact = false;
    if (deps.hookDispatcher) {
      const preAutoResult = await deps.hookDispatcher.fire({
        path: 'Pre:compact:auto',
        phase: 'Pre',
        category: 'compact',
        specific: 'auto',
        sessionId: deps.sessionId,
        timestamp: Date.now(),
        payload: {
          trigger: 'auto',
          usagePct,
          totalTokens,
          maxTokens,
          thresholdPercent: autoDecision.thresholdPercent,
          thresholdTokens: autoDecision.thresholdTokens,
          remainingTokens: autoDecision.remainingTokens,
          safetyBufferTokens: autoDecision.safetyBufferTokens,
          reason: forcedByModelWarning ? 'model-warning' : autoDecision.reason,
        },
      }).catch((err: unknown): HookResult => {
        logger.warn('Pre:compact:auto hook error', { error: summarizeError(err) });
        return { ok: true };
      });
      if (preAutoResult.decision === 'deny') {
        deps.setIsCompacting(false);
        skipAutoCompact = true;
        logger.info('Orchestrator: Pre:compact:auto denied by hook - skipping auto-compact', { reason: preAutoResult.reason });
      }
    }

    try {
      const currentMsgs = deps.conversation.getMessagesForLLM();
      const useSmallWindow = maxTokens < SMALL_WINDOW_THRESHOLD;

      if (!skipAutoCompact && useSmallWindow) {
        try {
          const compactedMsgs = compactSmallWindow(currentMsgs, 10);
          deps.conversation.replaceMessagesForLLM(compactedMsgs);
          deps.setIsCompacting(false);
          deps.setLastWarningBracket(0);
          // Small-window keep-last-N is deterministic (not quality-scored); the
          // receipt still fires so this path is never silent either.
          emitReceipt(deps, turnId, {
            trigger: 'auto', strategy: 'small-window',
            tokensBefore: estimateConversationTokens(currentMsgs),
            tokensAfter: estimateConversationTokens(compactedMsgs),
            messagesBefore: currentMsgs.length, messagesAfter: compactedMsgs.length,
            qualityScore: 1, qualityGrade: 'A', lowQuality: false,
            instructionsReinjected: false, validationPassed: true,
            sectionsIncluded: [], outcome: 'applied', detail: 'small window: kept last 10 messages',
          });
          deps.conversation.addSystemMessage('Context auto-compacted (small window mode). Kept last 10 messages.');
          deps.requestRender();
        } catch (err: unknown) {
          deps.setIsCompacting(false);
          const msg = summarizeError(err);
          logger.error('Orchestrator: small-window auto-compact failed', { error: msg });
          emitCompactionFailureReceipt(deps, turnId, err, 'auto', 'small-window');
          deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}. Use /compact to retry manually.`);
          deps.requestRender();
        }
      } else if (!skipAutoCompact) {
        const compactionCtx = buildAutoCompactionContext(deps, {
          messages: currentMsgs,
          contextWindow: maxTokens,
          extractionModelId: currentModel.registryKey,
          extractionProvider: currentModel.provider,
        });
        void deps.conversation.compact(
          deps.providerRegistry,
          currentModel.registryKey,
          'auto',
          currentModel.provider,
          compactionCtx,
        ).then((receipt) => {
          deps.setIsCompacting(false);
          deps.setLastWarningBracket(0);
          if (receipt) emitReceipt(deps, turnId, receipt);
          deps.conversation.addSystemMessage('Context auto-compacted. Conversation history summarized to free context window.');
          deps.requestRender();
          logger.info('Orchestrator: auto-compact complete', {
            modelId: currentModel.registryKey,
            usagePct,
            totalTokens,
            maxTokens,
            thresholdPercent: autoDecision.thresholdPercent,
            thresholdTokens: autoDecision.thresholdTokens,
            remainingTokens: autoDecision.remainingTokens,
            safetyBufferTokens: autoDecision.safetyBufferTokens,
            reason: forcedByModelWarning ? 'model-warning' : autoDecision.reason,
          });
          if (deps.hookDispatcher) {
            deps.hookDispatcher.fire({
              path: 'Post:compact:auto',
              phase: 'Post',
              category: 'compact',
              specific: 'auto',
              sessionId: deps.sessionId,
              timestamp: Date.now(),
              payload: {
                trigger: 'auto',
                usagePct,
                totalTokens,
                maxTokens,
                thresholdPercent: autoDecision.thresholdPercent,
                thresholdTokens: autoDecision.thresholdTokens,
                remainingTokens: autoDecision.remainingTokens,
                safetyBufferTokens: autoDecision.safetyBufferTokens,
                reason: forcedByModelWarning ? 'model-warning' : autoDecision.reason,
              },
            }).catch((err: unknown) => { logger.warn('Post:compact:auto hook error', { error: summarizeError(err) }); });
          }
        }).catch((err: unknown) => {
          deps.setIsCompacting(false);
          const msg = summarizeError(err);
          logger.error('Orchestrator: auto-compact failed', { error: msg });
          emitCompactionFailureReceipt(deps, turnId, err, 'auto', 'structured');
          deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}. Use /compact to retry manually.`);
          deps.requestRender();
          if (deps.hookDispatcher) {
            deps.hookDispatcher.fire({
              path: 'Fail:compact:auto',
              phase: 'Fail',
              category: 'compact',
              specific: 'auto',
              sessionId: deps.sessionId,
              timestamp: Date.now(),
              payload: {
                trigger: 'auto',
                usagePct,
                totalTokens,
                maxTokens,
                thresholdPercent: autoDecision.thresholdPercent,
                thresholdTokens: autoDecision.thresholdTokens,
                remainingTokens: autoDecision.remainingTokens,
                safetyBufferTokens: autoDecision.safetyBufferTokens,
                reason: forcedByModelWarning ? 'model-warning' : autoDecision.reason,
                error: msg,
              },
            }).catch((err: unknown) => { logger.warn('Fail:compact:auto hook error', { error: summarizeError(err) }); });
          }
        });
      }
    } catch (compactErr: unknown) {
      deps.setIsCompacting(false);
      logger.error('Auto-compact failed', { error: String(compactErr) });
      emitCompactionFailureReceipt(deps, turnId, compactErr, 'auto', 'structured');
      deps.conversation.addSystemMessage(`[Compact] Auto-compaction failed: ${String(compactErr)}`);
      deps.requestRender();
    }
  } else if (
    warningsEnabled &&
    autoCompactEnabled &&
    usagePct >= Math.max(0, configuredThreshold - 10) &&
    bracket > deps.lastWarningBracket
  ) {
    deps.setLastWarningBracket(bracket);
    deps.conversation.addSystemMessage(
      `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Auto-compact will trigger at ${configuredThreshold}% or when the ${COMPACTION_BUFFER_TOKENS.toLocaleString()} token safety buffer is reached.`
    );
    if (deps.runtimeBus) {
      emitOpsContextWarning(deps.runtimeBus, deps.emitterContext(turnId), {
        usage: usagePct,
        threshold: configuredThreshold,
        currentTokens: totalTokens,
        contextWindow: maxTokens,
        thresholdTokens: autoDecision.thresholdTokens,
        remainingTokens: autoDecision.remainingTokens,
        safetyBufferTokens: autoDecision.safetyBufferTokens,
        reason: 'threshold',
      });
    }
    deps.requestRender();
  }
}
