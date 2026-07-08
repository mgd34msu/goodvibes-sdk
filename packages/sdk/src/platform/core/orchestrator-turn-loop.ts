import type { ConversationManager } from './conversation.js';
import type { ExecutionPlan } from './execution-plan.js';
import { ConsecutiveErrorBreaker } from './circuit-breaker.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { ConfigManager } from '../config/manager.js';
import { estimateConversationTokens, estimateTokens } from './context-compaction.js';
import { ProviderError, isContextSizeExceededError, isNonTransientProviderFailure } from '../types/errors.js';
import { formatProviderError } from '../utils/error-display.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { ContentPart, LLMProvider, StreamDelta } from '../providers/interface.js';
import { isContextOverflowSignal } from '../providers/stop-reason-maps.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import {
  emitOpsCacheMetrics,
  emitOpsHelperUsage,
  emitLlmRequestStarted,
  emitLlmResponseReceived,
  emitPreflightFail,
  emitPreflightOk,
  emitStreamDelta,
  emitStreamEnd,
  emitStreamRetry,
  emitStreamStart,
  emitTurnError,
} from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { HelperModel } from '../config/helper-model.js';
import type { ModelDefinition } from '../providers/registry.js';
import type { FavoritesStore } from '../providers/favorites.js';
import { logger } from '../utils/logger.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ExecutionPlanManager } from './execution-plan.js';
import {
  emitMalformedToolUseWarning,
  handleFinalResponseOutcome,
  handleToolResponseOutcome,
  type ChatResponseWithReasoning,
} from './orchestrator-turn-helpers.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { buildWrfcWorkflowRoutingPrompt } from './wrfc-routing.js';
import {
  buildPerTurnKnowledgeInjection,
  defaultTurnKnowledgeBudgetTokens,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
  type TurnInjectionRecord,
  type TurnKnowledgeRegistrySource,
  type TurnCodeIndexSource,
} from '../agents/turn-knowledge-injection.js';

const AUTO_SPAWN_FALLBACK_DELAY_MS = 5_000;
/**
 * Per-turn passive-injection headroom clamp for the MAIN interactive
 * session. Mirrors agents/orchestrator-runner.ts's CONTEXT_COMPACT_THRESHOLD (0.85) —
 * deliberately NOT derived from this loop's own configurable `behavior.autoCompactThreshold`
 * (default 80, see config/schema-domain-core.ts), which governs CONVERSATION compaction and
 * can be user-tuned or disabled (0) independently of this feature. Keeping this fixed keeps
 * the injection block's safety margin identical to the agent-runner's regardless of what the
 * operator has configured for compaction.
 */
const PASSIVE_KNOWLEDGE_INJECTION_CONTEXT_THRESHOLD = 0.85;

interface HookDispatcherLike {
  fire(event: HookEvent): Promise<HookResult>;
}

type EmitterContext = import('../runtime/emitters/index.js').EmitterContext;

export interface OrchestratorTurnLoopContext {
  readonly conversation: ConversationManager;
  readonly toolRegistry: ToolRegistry;
  readonly getSystemPrompt: () => string;
  readonly getAbortSignal: () => AbortSignal | undefined;
  readonly hookDispatcher: HookDispatcherLike | null;
  readonly requestRender: () => void;
  readonly runtimeBus: RuntimeEventBus | null;
  readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'require' | 'getCurrentModel' | 'getForModel' | 'getTokenLimitsForModel' | 'getContextWindowForModel' | 'recordContextWindowRejection' | 'reconcileObservedContextWindow'>;
  readonly favoritesStore?: Pick<FavoritesStore, 'recordUsage'> | undefined;
  readonly cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>;
  readonly helperModel: HelperModel;
  readonly sessionId: string;
  readonly preTurnPlan: ExecutionPlan | null;
  readonly planManager: Pick<
    ExecutionPlanManager,
    'getActive' | 'getSummary' | 'getNextItems' | 'toMarkdown' | 'create' | 'save' | 'parseFromMarkdown' | 'replaceItems' | 'load' | 'updateItem'
  > | null;
  readonly text: string;
  readonly content?: ContentPart[] | undefined;
  readonly turnId: string;
  readonly emitterContext: (turnId: string) => EmitterContext;
  readonly executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  readonly checkContextWindowPreflight: (turnId: string, model: ModelDefinition) => Promise<'ok' | 'compacted' | 'error'>;
  readonly normalizeUsage: (usage: Awaited<ReturnType<LLMProvider['chat']>>['usage']) => Awaited<ReturnType<LLMProvider['chat']>>['usage'];
  readonly estimateFreshTurnInputTokens: (
    currentEstimatedTokens: number,
    text: string,
    content?: ContentPart[],
  ) => number;
  readonly getMessageQueueLength: () => number;
  readonly isReconciliationEnabled: () => boolean;
  readonly setPendingToolCalls: (calls: ToolCall[]) => void;
  readonly setAutoSpawnTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;
  readonly setStreamingActive: (value: boolean) => void;
  readonly setStreamingInputTokens: (value: number) => void;
  readonly addStreamingOutputTokens: (value: number) => void;
  readonly setLastRequestInputTokens: (value: number) => void;
  readonly setLastInputTokens: (value: number) => void;
  readonly markTurnFailed: () => void;
  /**
   * The model/provider reported its context window filled (see
   * isContextOverflowSignal). The orchestrator must compact at the next
   * opportunity regardless of locally estimated usage — the provider's own
   * report is authoritative over the estimate.
   */
  readonly noteModelContextWindowWarning: (details: {
    provider: string;
    model: string;
    providerStopReason?: string | undefined;
  }) => void;
  readonly usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /**
   * Per-turn passive-injection wiring for the MAIN interactive session —
   * the sibling of the agent-runner's runAgentTask wiring in agents/orchestrator-runner.ts,
   * gated on the SAME `agent-passive-knowledge-injection` feature flag (its description
   * already promised "the EVOLVING main-session conversation" coverage; see
   * runtime/feature-flags/flags.ts). `memoryRegistry` undefined is a hard no-op, matching
   * the agent path. Budget/floor default to the same derived defaults
   * (defaultTurnKnowledgeBudgetTokens / DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR) when
   * omitted.
   */
  readonly memoryRegistry?: TurnKnowledgeRegistrySource | undefined;
  readonly isPassiveKnowledgeInjectionEnabled: () => boolean;
  readonly passiveKnowledgeInjectionBudgetTokens?: number | undefined;
  readonly passiveKnowledgeInjectionRelevanceFloor?: number | undefined;
  /**
   * Stage B — repo code index for the main session's per-turn injection. Undefined is a
   * hard no-op. `isPassiveCodeInjectionEnabled` resolves the combined gate (flag AND setting);
   * both it and the source must be present for code hits to be considered this turn.
   */
  readonly codeIndex?: TurnCodeIndexSource | undefined;
  readonly isPassiveCodeInjectionEnabled: () => boolean;
  /**
   * The main session has no spawn-time `AgentRecord.knowledgeInjections` baseline, so this
   * starts empty and grows monotonically for the life of the Orchestrator — no record is
   * ever surfaced twice across the whole interactive session (mirrors the agent-runner's
   * knowledgeIdsAlreadySurfaced, but session-lifetime instead of one-agent-run-lifetime).
   */
  readonly getAlreadyInjectedKnowledgeIds: () => readonly string[];
  readonly addInjectedKnowledgeIds: (ids: readonly string[]) => void;
  /** Bounded ring (see recordTurnInjection) backing Orchestrator.getTurnInjections(). */
  readonly recordTurnKnowledgeInjection: (record: TurnInjectionRecord) => void;
  /** Monotonic per-Orchestrator-lifetime sequence number for TurnInjectionRecord.turn. */
  readonly nextTurnKnowledgeSequence: () => number;
}

export async function executeOrchestratorTurnLoop(context: OrchestratorTurnLoopContext): Promise<void> {
  const helperModel = context.helperModel;
  const model = context.providerRegistry.getCurrentModel();
  const provider: LLMProvider = context.providerRegistry.getForModel(model.registryKey, model.provider);
  const toolDefinitions = context.toolRegistry.getToolDefinitions();
  const streamEnabled = context.configManager.get('display.stream') as boolean;

  let continueLoop = true;
  // One compact-and-retry per runTurn() when the provider rejects a request
  // as exceeding the context window; a second rejection surfaces as an error.
  let contextOverflowRetried = false;
  const circuitBreaker = new ConsecutiveErrorBreaker();
  // True only for the FIRST LLM call this executeOrchestratorTurnLoop()
  // invocation makes (see the per-iteration gate below for why this is the main loop's
  // analog of the agent-runner's "new user input this turn").
  let isFirstIterationOfThisCall = true;
  // The last successfully-built per-turn knowledge block, reused verbatim
  // on tool-continuation iterations of THIS call where nothing new arrived (mirrors
  // the agent-runner's priorTurnKnowledgeBlock) — declared OUTSIDE the while loop so a block built on
  // iteration 1 (the human message that started this runTurn()) stays available to every
  // later tool round of the SAME call, not just the first LLM call. It is composed onto
  // the CURRENT `composedBaseSystemPrompt` fresh every iteration (see
  // composeTurnSystemPrompt below), never written back into any cached base string, so it
  // cannot compound. Reset implicitly to null on every NEW executeOrchestratorTurnLoop()
  // call (a fresh runTurn() always recomputes from scratch on its own iteration 1).
  let turnKnowledgeBlock: string | null = null;

  while (continueLoop) {
    let streamAccumulated = '';
    let reasoningAccumulated = '';
    let streamSessionStarted = false;
    const onDelta = (delta: StreamDelta) => {
      if (delta.content) {
        streamAccumulated += delta.content;
        if (streamEnabled) {
          context.conversation.updateStreamingBlock(streamAccumulated);
        }
      }
      if (delta.reasoning) {
        reasoningAccumulated += delta.reasoning;
      }
      if (delta.content || delta.reasoning) {
        context.addStreamingOutputTokens(Math.max(
          1,
          estimateTokens(delta.content ?? delta.reasoning ?? ''),
        ));
      }
      if (context.runtimeBus) {
        emitStreamDelta(context.runtimeBus, context.emitterContext(context.turnId), {
          turnId: context.turnId,
          content: delta.content ?? '',
          accumulated: streamAccumulated,
          ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}),
          ...(delta.toolCalls !== undefined ? { toolCalls: delta.toolCalls } : {}),
        });
      }
      context.requestRender();
    };

    const preflightResult = await context.checkContextWindowPreflight(context.turnId, model);
    if (preflightResult === 'error') {
      if (streamEnabled) {
        context.setStreamingActive(false);
        context.conversation.finalizeStreamingBlock();
      }
      if (context.runtimeBus) {
        emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
        emitPreflightFail(context.runtimeBus, context.emitterContext(context.turnId), {
          turnId: context.turnId,
          reason: 'context window preflight failed',
          stopReason: 'context_overflow',
        });
      }
      context.markTurnFailed();
      break;
    }
    if (context.runtimeBus) {
      emitPreflightOk(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }

    context.setStreamingInputTokens(
      context.estimateFreshTurnInputTokens(
        estimateConversationTokens(context.conversation.getMessagesForLLM()),
        context.text,
        context.content,
      ),
    );

    if (streamEnabled) {
      context.setStreamingActive(true);
      context.conversation.startStreamingBlock();
    }
    if (context.runtimeBus) {
      emitStreamStart(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }
    streamSessionStarted = true;

    const tokenLimits = context.providerRegistry.getTokenLimitsForModel(model);

    if (context.hookDispatcher) {
      const preEvent: HookEvent = {
        path: 'Pre:llm:chat',
        phase: 'Pre',
        category: 'llm',
        specific: 'chat',
        sessionId: context.sessionId,
        timestamp: Date.now(),
        payload: { model: model.id, provider: model.provider, messageCount: context.conversation.getMessagesForLLM().length },
      };
      const preResult = await context.hookDispatcher.fire(preEvent);
      if (preResult.decision === 'deny') {
        context.conversation.addSystemMessage(preResult.reason ?? 'LLM call blocked by hook');
        if (context.runtimeBus) {
          emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
            turnId: context.turnId,
            error: preResult.reason ?? 'LLM call blocked by hook',
            stopReason: 'hook_denied',
          });
        }
        context.markTurnFailed();
        break;
      }
    }

    // Per-turn passive knowledge injection for the MAIN interactive
    // session — the missing counterpart to the agent-runner's wiring in
    // agents/orchestrator-runner.ts. `newUserInputThisTurn` mirrors the agent-runner's
    // turn-1/steer-drain gate: it is true exactly on the FIRST LLM call this
    // executeOrchestratorTurnLoop() invocation makes (the fresh human message this
    // runTurn() call was invoked with) and false on every subsequent tool-continuation
    // iteration of the SAME call, since the main session never drains new human input
    // mid-call (handleUserInput queues a second message until the current runTurn()
    // completes — see orchestrator.ts). Retrieval reruns only when newUserInputThisTurn
    // is true; tool-continuation iterations reuse `turnKnowledgeBlock` as-is (declared
    // before the while loop) — exactly the agent-runner's reuse behavior for no-new-input
    // turns, just with a different trigger for what counts as "new".
    const newUserInputThisTurn = isFirstIterationOfThisCall;
    isFirstIterationOfThisCall = false;
    const passiveKnowledgeInjectionEnabled = context.isPassiveKnowledgeInjectionEnabled();
    let knowledgeContextWindow = 0;
    if (passiveKnowledgeInjectionEnabled && context.memoryRegistry) {
      knowledgeContextWindow = context.providerRegistry.getContextWindowForModel(model);
    }
    const baseSystemPromptForCall = appendGoodVibesRuntimeAwarenessPrompt(context.getSystemPrompt());
    const wrfcRoutingPromptForCall = buildWrfcWorkflowRoutingPrompt(context.text);
    const composedBaseSystemPrompt = wrfcRoutingPromptForCall
      ? `${baseSystemPromptForCall}\n\n${wrfcRoutingPromptForCall}`
      : baseSystemPromptForCall;
    if (passiveKnowledgeInjectionEnabled && newUserInputThisTurn && context.memoryRegistry) {
      const configuredBudget = context.passiveKnowledgeInjectionBudgetTokens
        ?? defaultTurnKnowledgeBudgetTokens(knowledgeContextWindow);
      let turnBudgetTokens = configuredBudget;
      if (knowledgeContextWindow > 0) {
        // Clamp to whatever headroom remains under the same fixed safety threshold this
        // block always uses (PASSIVE_KNOWLEDGE_INJECTION_CONTEXT_THRESHOLD) so base+block
        // can never silently exceed it, using LIVE token counts from the
        // post-preflight-compaction conversation state (checkContextWindowPreflight above
        // already ran this iteration) rather than turn-start estimates.
        const msgTokensForBudget = estimateConversationTokens(context.conversation.getMessagesForLLM());
        const sysTokensForBudget = estimateTokens(composedBaseSystemPrompt);
        const threshold = Math.floor(knowledgeContextWindow * PASSIVE_KNOWLEDGE_INJECTION_CONTEXT_THRESHOLD);
        const headroomTokens = threshold - msgTokensForBudget - sysTokensForBudget;
        turnBudgetTokens = Math.max(0, Math.min(configuredBudget, headroomTokens));
      }
      if (turnBudgetTokens > 0) {
        const relevanceFloor = context.passiveKnowledgeInjectionRelevanceFloor ?? DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR;
        // Stage B: code hits share this turn's SAME budget/floor. Gated on the separate
        // (default-off) code-injection flag AND the embedder's storage.codeIndexEnabled
        // setting, both folded into isPassiveCodeInjectionEnabled by the orchestrator.
        const codeInjectionEnabled = !!context.codeIndex && context.isPassiveCodeInjectionEnabled();
        const { block, record: turnInjectionRecord } = buildPerTurnKnowledgeInjection({
          memoryRegistry: context.memoryRegistry,
          // The main session has no frozen "task" distinct from the live conversation —
          // context.text (this call's originating human message) IS this turn's task, and
          // is also the latest user-role message already appended to the conversation
          // before the loop started (see prepareConversationForTurn), so
          // deriveTurnKnowledgeQuery collapses to it with no duplication — the same
          // turn-1 behavior documented for the agent path.
          task: context.text,
          conversationTail: context.conversation.getMessagesForLLM(),
          budgetTokens: turnBudgetTokens,
          relevanceFloor,
          alreadyInjectedIds: context.getAlreadyInjectedKnowledgeIds(),
          turn: context.nextTurnKnowledgeSequence(),
          codeIndex: context.codeIndex,
          codeInjectionEnabled,
        });
        turnKnowledgeBlock = block;
        if (turnInjectionRecord.injectedIds.length > 0) {
          context.addInjectedKnowledgeIds(turnInjectionRecord.injectedIds);
        }
        context.recordTurnKnowledgeInjection(turnInjectionRecord);
      } else {
        // Hard no-op: no budget headroom this call. Never call into retrieval for a
        // budget already known to be zero, and never keep claiming a stale block from an
        // earlier iteration that no longer fits — clear it so composeTurnSystemPrompt
        // falls back to the base prompt exactly (mirrors the agent-runner's identical branch).
        turnKnowledgeBlock = null;
      }
    }
    // Composed fresh at the call site (never a hoisted `const` reused across calls) so the
    // block is re-validated against LIVE tokens at the instant it is actually sent — the
    // same "never mutate the cached base, recompute at the call site" discipline the
    // agent-runner's composeTurnSystemPrompt established, even though this loop has no in-call
    // context-exceeded retry path to go stale across (compaction here is the PROACTIVE
    // checkContextWindowPreflight above, not a reactive mid-call retry-and-shrink).
    const composeTurnSystemPrompt = (base: string): string => {
      if (!turnKnowledgeBlock) return base;
      if (knowledgeContextWindow > 0) {
        const liveMsgTokens = estimateConversationTokens(context.conversation.getMessagesForLLM());
        const liveSysTokens = estimateTokens(base);
        const liveBlockTokens = estimateTokens(turnKnowledgeBlock);
        const threshold = Math.floor(knowledgeContextWindow * PASSIVE_KNOWLEDGE_INJECTION_CONTEXT_THRESHOLD);
        if (liveMsgTokens + liveSysTokens + liveBlockTokens > threshold) return base;
      }
      return `${base}\n\n${turnKnowledgeBlock}`;
    };

    let response: Awaited<ReturnType<typeof provider.chat>>;
    if (context.runtimeBus) {
      emitLlmRequestStarted(context.runtimeBus, context.emitterContext(context.turnId), {
        turnId: context.turnId,
        provider: model.provider,
        model: model.id,
        promptSummary: '<redacted-length-unknown>',
      });
    }
    const chatStartedAt = Date.now();
    let chatRetries = 0;
    try {
      response = await provider.chat({
        model: model.id,
        messages: context.conversation.getMessagesForLLM(),
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        systemPrompt: composeTurnSystemPrompt(composedBaseSystemPrompt),
        maxTokens: tokenLimits.maxOutputTokens,
        reasoningEffort: (() => {
          const configured = context.configManager.get('provider.reasoningEffort') as string | undefined;
          if (configured) return configured as 'instant' | 'low' | 'medium' | 'high';
          return model.capabilities.reasoning ? 'medium' : undefined;
        })(),
        signal: context.getAbortSignal(),
        onDelta,
        onRetry: (attempt, maxAttempts, delayMs, error) => {
          chatRetries = attempt;
          if (context.runtimeBus) {
            emitStreamRetry(context.runtimeBus, context.emitterContext(context.turnId), {
              turnId: context.turnId,
              provider: model.provider,
              attempt,
              maxAttempts,
              delayMs,
              reason: error.message,
            });
          }
        },
      });
    } catch (chatErr) {
      if (streamEnabled) {
        context.setStreamingActive(false);
        context.conversation.finalizeStreamingBlock();
      }
      if (streamSessionStarted && context.runtimeBus) {
        emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
      }
      if (isContextSizeExceededError(chatErr) && !contextOverflowRetried) {
        // The provider rejected the request as exceeding the model's context
        // window (e.g. openai-codex 'context_length_exceeded'). This is the
        // authoritative signal that the effective window is smaller than the
        // catalog claims: learn the rejected size as the model's practical
        // ceiling, then compact immediately and retry the request once —
        // never tell the user to run /compact by hand.
        contextOverflowRetried = true;
        const rejectedAtTokens = estimateConversationTokens(context.conversation.getMessagesForLLM());
        context.providerRegistry.recordContextWindowRejection(model.registryKey, rejectedAtTokens);
        context.noteModelContextWindowWarning({
          provider: model.provider,
          model: model.id,
          providerStopReason: 'context_length_exceeded (provider error)',
        });
        context.conversation.addSystemMessage(
          `${model.displayName} rejected the request as exceeding its context window (~${rejectedAtTokens.toLocaleString()} tokens sent). Learned this as the model's practical limit. Auto-compacting and retrying...`,
        );
        context.requestRender();
        continue;
      }
      if (chatErr instanceof ProviderError && chatErr.statusCode === 429 && model.provider === 'synthetic' && model.tier !== 'free') {
        context.conversation.addSystemMessage(
          `All providers for ${model.displayName} are currently exhausted.\n`
          + `Options:\n`
          + `  • Wait a few minutes for the rate limit to reset and retry\n`
          + `  • Switch to a different model with /model\n`
          + `  • Switch to a free model via /model and selecting the free tier`,
        );
        if (context.runtimeBus) {
          emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
            turnId: context.turnId,
            error: 'All providers for the selected synthetic model are exhausted',
            stopReason: 'provider_exhausted',
          });
        }
        context.markTurnFailed();
        context.requestRender();
        break;
      }
      if (context.hookDispatcher) {
        context.hookDispatcher.fire({
          path: 'Fail:llm:chat',
          phase: 'Fail',
          category: 'llm',
          specific: 'chat',
          sessionId: context.sessionId,
          timestamp: Date.now(),
          payload: { model: model.id, provider: model.provider, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
        }).catch((error) => logger.warn('Fail:llm:chat hook dispatch failed', {
          sessionId: context.sessionId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      throw chatErr;
    }

    if (streamEnabled) {
      context.setStreamingActive(false);
      context.conversation.finalizeStreamingBlock();
    }
    if (streamSessionStarted && context.runtimeBus) {
      emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }

    response = {
      ...response,
      usage: context.normalizeUsage(response.usage),
    };

    void context.favoritesStore?.recordUsage(model.registryKey).catch((err) => logger.warn('favoritesStore.recordUsage failed', {
      error: err instanceof Error ? err.message : String(err),
    }));
    context.usage.input += response.usage.inputTokens;
    context.usage.output += response.usage.outputTokens;
    context.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
    context.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;

    const cacheMetrics = context.cacheHitTracker.getMetrics();
    if (cacheMetrics.turns > 0 && context.runtimeBus) {
      emitOpsCacheMetrics(context.runtimeBus, context.emitterContext(context.turnId), {
        hitRate: cacheMetrics.hitRate,
        cacheReadTokens: cacheMetrics.cacheReadTokens,
        cacheWriteTokens: cacheMetrics.cacheWriteTokens,
        totalInputTokens: cacheMetrics.totalInputTokens,
        turns: cacheMetrics.turns,
      });
    }

    const helperUsage = helperModel.getUsage();
    if (helperUsage.calls > 0 && context.runtimeBus) {
      emitOpsHelperUsage(context.runtimeBus, context.emitterContext(context.turnId), {
        inputTokens: helperUsage.inputTokens,
        outputTokens: helperUsage.outputTokens,
        calls: helperUsage.calls,
      });
    }

    const hitRateThreshold = context.configManager.get('cache.hitRateWarningThreshold');
    if (
      cacheMetrics.turns >= 5
      && cacheMetrics.hitRate < hitRateThreshold
      && context.configManager.get('cache.monitorHitRate')
    ) {
      logger.info(`[Cache] Low hit rate: ${(cacheMetrics.hitRate * 100).toFixed(0)}% over ${cacheMetrics.turns} turns`);
    }

    context.setLastRequestInputTokens(response.usage.inputTokens);
    const realInputTokens = response.usage.inputTokens
      + (response.usage.cacheReadTokens ?? 0)
      + (response.usage.cacheWriteTokens ?? 0);
    context.setLastInputTokens(realInputTokens);
    // A successful request whose real billed input exceeds a learned context
    // ceiling proves that ceiling too pessimistic (estimates overshoot) —
    // raise it to what the provider demonstrably accepted.
    context.providerRegistry.reconcileObservedContextWindow(model.registryKey, realInputTokens);

    if (context.runtimeBus) {
      emitLlmResponseReceived(context.runtimeBus, context.emitterContext(context.turnId), {
        turnId: context.turnId,
        provider: model.provider,
        model: model.id,
        contentSummary: response.content,
        toolCallCount: response.toolCalls.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        durationMs: Date.now() - chatStartedAt,
        retries: chatRetries,
      });
    }

    if (context.hookDispatcher) {
      context.hookDispatcher.fire({
        path: 'Post:llm:chat',
        phase: 'Post',
        category: 'llm',
        specific: 'chat',
        sessionId: context.sessionId,
        timestamp: Date.now(),
        payload: {
          model: model.id,
          provider: model.provider,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          toolCallCount: response.toolCalls.length,
        },
      }).catch((error) => logger.warn('Post:llm:chat hook dispatch failed', {
        sessionId: context.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    const reasoningForMsg = reasoningAccumulated || undefined;
    const reasoningSummaryForMsg = response.reasoningSummary || undefined;

    if (isContextOverflowSignal(response.stopReason, response.providerStopReason)) {
      context.noteModelContextWindowWarning({
        provider: model.provider,
        model: model.id,
        providerStopReason: response.providerStopReason,
      });
    }

    if (response.stopReason === 'tool_call' && response.toolCalls.length === 0) {
      emitMalformedToolUseWarning({
        conversation: context.conversation,
        providerRegistry: context.providerRegistry,
        runtimeBus: context.runtimeBus,
        emitterContext: (id) => context.emitterContext(id),
        turnId: context.turnId,
        isReconciliationEnabled: context.isReconciliationEnabled(),
      });
    }

    if (response.toolCalls.length > 0) {
      const enrichedResponse: ChatResponseWithReasoning = {
        ...response,
        reasoning: reasoningForMsg,
        reasoningSummary: reasoningSummaryForMsg,
      };
      const results = await handleToolResponseOutcome({
        conversation: context.conversation,
        agentManager: context.agentManager,
        planManager: context.planManager,
        configManager: context.configManager,
        providerRegistry: context.providerRegistry,
        runtimeBus: context.runtimeBus,
        emitterContext: (id) => context.emitterContext(id),
        turnId: context.turnId,
        response: enrichedResponse,
        userText: context.text,
        executeToolCalls: (id, calls) => context.executeToolCalls(id, calls),
        setPendingToolCalls: (calls) => { context.setPendingToolCalls(calls); },
        messageQueueLength: context.getMessageQueueLength(),
        requestRender: context.requestRender,
        sessionId: context.sessionId,
      });

      const allFailed = results.results.length > 0 && results.results.every((result) => result.success === false);
      if (allFailed) {
        const breakerResult = circuitBreaker.recordAllFailed();
        logger.warn(`Orchestrator: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
        if (breakerResult === 'break') {
          logger.warn(`Orchestrator: circuit breaker tripped at ${circuitBreaker.consecutiveErrors} consecutive all-error turns`);
          context.conversation.addSystemMessage(
            `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. `
            + `The loop is stopping to prevent an infinite failure cycle. `
            + `Please reassess your approach and try a completely different strategy.`,
          );
          if (context.runtimeBus) {
            emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
              turnId: context.turnId,
              error: 'Consecutive all-failed tool turns tripped the circuit breaker',
              stopReason: 'tool_loop_circuit_breaker',
            });
          }
          context.markTurnFailed();
          break;
        } else if (breakerResult === 'warn') {
          context.conversation.addSystemMessage(
            `WARNING: You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. `
            + `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, `
            + `then try a completely different strategy.`,
          );
        }
      } else if (results.results.length > 0) {
        circuitBreaker.recordSuccess();
      }
      continueLoop = results.continueLoop;
      continue;
    }

    const enrichedResponse: ChatResponseWithReasoning = {
      ...response,
      reasoning: reasoningForMsg,
      reasoningSummary: reasoningSummaryForMsg,
    };
    continueLoop = handleFinalResponseOutcome({
      conversation: context.conversation,
      agentManager: context.agentManager,
      planManager: context.planManager,
      configManager: context.configManager,
      providerRegistry: context.providerRegistry,
      runtimeBus: context.runtimeBus,
      emitterContext: (id) => context.emitterContext(id),
      turnId: context.turnId,
      response: enrichedResponse,
      preTurnPlan: context.preTurnPlan,
      requestRender: context.requestRender,
      setAutoSpawnTimeout: (timeout) => { context.setAutoSpawnTimeout(timeout); },
      autoSpawnTimeoutMs: AUTO_SPAWN_FALLBACK_DELAY_MS,
      sessionId: context.sessionId,
    });
  }
}
