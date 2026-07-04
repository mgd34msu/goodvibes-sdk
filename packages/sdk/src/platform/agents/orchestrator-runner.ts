// OrchestratorRunner — single-agent turn loop coordinator.
//
// This module implements the coordinator pattern: it orchestrates agent runs
// (LLM call → tool execution → loop) but delegates domain logic to imported
// collaborators (ConversationManager, ToolRegistry, AgentSession, etc.).
// It does not own any state beyond the duration of a single runAgentLoop() call.
import { ConversationManager, type ConversationMessageSnapshot } from '../core/conversation.js';
import { ToolRegistry } from '../tools/registry.js';
import { join } from 'node:path';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelDefinition } from '../providers/registry-types.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';
import { logger } from '../utils/logger.js';
import { ConsecutiveErrorBreaker } from '../core/circuit-breaker.js';
import { isRateLimitOrQuotaError, isContextSizeExceededError, isNetworkTransportError } from '../types/errors.js';
import { AgentSession } from './session.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import {
  estimateTokens,
  estimateConversationTokens,
  compactSmallWindow,
} from '../core/context-compaction.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { LLMProvider, StreamDelta } from '../providers/interface.js';
import type { ToolResult } from '../types/tools.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitCommunicationConsumed } from '../runtime/emitters/index.js';
import { summarizeToolArgs } from './orchestrator-utils.js';
import { buildLayeredOrchestratorSystemPrompt, buildOrchestratorSystemPrompt } from './orchestrator-prompts.js';
import {
  buildPerTurnKnowledgeInjection,
  defaultTurnKnowledgeBudgetTokens,
  recordTurnInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
} from './turn-knowledge-injection.js';
import type { AgentMessageBus } from './message-bus.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { ArchetypeLoader } from './archetypes.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';

const MAX_TURNS = 50; // hard cap per agent run to prevent unbounded loops
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]; // exponential back-off on transient network errors
const RATE_LIMIT_RETRY_DELAY_MS = 60_000; // fixed pause on 429/quota responses
const RATE_LIMIT_MAX_RETRIES = 3; // cap retries so a sustained quota violation terminates cleanly
const CONTEXT_COMPACT_THRESHOLD = 0.85; // fraction of context window at which compaction is triggered
const MIN_WINDOW_FOR_LLM_COMPACT = 12_000; // don't attempt LLM-driven compaction below this token floor

type EmitterContext = import('../runtime/emitters/index.js').EmitterContext;

export interface AgentOrchestratorRunContext {
  readonly workingDirectory: string;
  readonly surfaceRoot?: string | undefined;
  readonly runtimeBus: RuntimeEventBus | null;
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly emitterContext: (agentId: string) => EmitterContext;
  readonly emitAgentProgress: (recordId: string, progress: string) => void;
  readonly emitOrchestrationProgress: (record: AgentRecord, progress: string) => void;
  readonly emitAgentStarted: (recordId: string) => void;
  readonly emitAgentCancelledEvent: (recordId: string, reason: string) => void;
  readonly emitOrchestrationCancelled: (record: AgentRecord, reason: string) => void;
  readonly emitAgentFailedEvent: (recordId: string, error: string, durationMs: number) => void;
  readonly emitOrchestrationFailed: (record: AgentRecord, error: string) => void;
  readonly emitAgentCompletedEvent: (
    recordId: string,
    durationMs: number,
    output: string,
    toolCallsMade: number,
    usage: AgentRecord['usage'] | undefined,
  ) => void;
  readonly emitOrchestrationCompleted: (record: AgentRecord, output: string) => void;
  readonly emitStreamDelta: (recordId: string, content: string, accumulated: string) => void;
  /**
   * Wave-3 conversation-snapshot bridge (Part C6): register the running
   * agent's live snapshot accessor with AgentManager so
   * AgentManager.getConversationSnapshot(agentId) can serve a full-fidelity
   * live transcript to a fleet tab. Optional — contexts that don't wire a
   * manager (e.g. isolated tests) simply skip the bridge.
   */
  readonly registerConversationSource?: ((agentId: string, source: () => ConversationMessageSnapshot[]) => void) | undefined;
  /**
   * Release the live source at run end, freezing one final snapshot into
   * AgentManager's bounded retention ring (see manager.ts). Always safe to
   * call even when register was never called for this agentId.
   */
  readonly releaseConversationSource?: ((agentId: string) => void) | undefined;
  /**
   * Wave-4 cooperative cancellation bridge (wo701): look up the AbortSignal
   * an orchestration-engine work item registered for this agent, if any.
   * Threaded into `toolRegistry.execute` opts so opted-in tools (exec,
   * fetch) can abort an in-flight child process/request the instant
   * `engine.kill(itemId)` fires, instead of waiting for the next turn
   * boundary's `record.status === 'cancelled'` poll below. Optional —
   * contexts that don't wire an orchestration engine simply omit it and
   * every tool call runs with `opts` undefined, unchanged from before.
   */
  readonly getCancellationSignal?: ((agentId: string) => AbortSignal | undefined) | undefined;
  readonly processManager?: ProcessManager | undefined;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly knowledgeService?: Pick<KnowledgeService, 'buildPromptPacketSync'> | undefined;
  readonly memoryRegistry?: Pick<import('../state/index.js').MemoryRegistry, 'getAll' | 'searchSemantic' | 'vectorStats'> | undefined;
  /**
   * Wave-5 Stage B — repo code index for per-turn code injection in a spawned agent run.
   * Undefined is a hard no-op. Actual injection additionally requires the
   * `agent-passive-code-injection` flag (DEFAULT OFF) and `isCodeInjectionSettingEnabled`.
   */
  readonly codeIndex?: import('./turn-knowledge-injection.js').TurnCodeIndexSource | undefined;
  /** Live gate for the embedder's storage.codeIndexEnabled setting. Undefined defaults to allowed. */
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  /**
   * Wave-5 Stage B — called once per executed tool (toolName, args, success) so a code-index
   * reindex scheduler can debounce an incremental reindex of touched files. Never awaited.
   */
  readonly onToolExecuted?: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  /**
   * Wave-5 (wo801, W5.1) per-turn passive-injection knobs. Both optional —
   * undefined means "use the derived default" (see turn-knowledge-injection.ts:
   * defaultTurnKnowledgeBudgetTokens / DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR).
   * Setting passiveKnowledgeInjectionBudgetTokens to 0 is the config-level
   * hard no-op: the feature never runs and the base system prompt is
   * byte-identical, independent of the feature flag's own state.
   */
  readonly passiveKnowledgeInjectionBudgetTokens?: number | undefined;
  readonly passiveKnowledgeInjectionRelevanceFloor?: number | undefined;
  readonly archetypeLoader?: { loadArchetype(template: string): { systemPrompt?: string | undefined } | null | undefined } | undefined;
  readonly getFullRegistry: () => ToolRegistry;
  readonly buildScopedRegistry: (allowedNames: string[], fullRegistry: ToolRegistry) => ToolRegistry;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel'>;
  readonly providerOptimizer?: Pick<ProviderOptimizer, 'recordFallbackTransition'> | undefined;
  readonly resolveProviderForRecord: (
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string; registryKey: string },
  ) => { provider: LLMProvider; modelId: string; requestedModelId: string };
  readonly resolveFallbackModelRoutes: (
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string; registryKey: string },
    primaryRequestedModelId: string,
  ) => Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }>;
}

type ActiveProviderRoute = {
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

function providerQualifiedRouteLabel(activeRoute: ActiveProviderRoute): string {
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

function applyContextWindowAwareness(
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

  const messages = conversation.getMessagesForLLM();
  const msgTokens = estimateConversationTokens(messages);
  const sysTokens = estimateTokens(systemPrompt);
  const totalEstimate = msgTokens + sysTokens + toolTokens;
  const threshold = Math.floor(modelWindow * CONTEXT_COMPACT_THRESHOLD);

  if (totalEstimate <= threshold) {
    return systemPrompt;
  }

  logger.warn(
    `[AgentOrchestrator] context-window awareness: estimated ${totalEstimate} tokens exceeds ${threshold} (${Math.round(CONTEXT_COMPACT_THRESHOLD * 100)}% of ${modelWindow}) - compacting`,
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
  if (currentSysTokens > remainingAfterMsgs * CONTEXT_COMPACT_THRESHOLD) {
    logger.warn(
      `[AgentOrchestrator] context-window awareness: system prompt (${currentSysTokens} tokens) too large for remaining window (${remainingAfterMsgs}) - applying layered trim`,
      { agentId: record.id },
    );
    return buildLayeredOrchestratorSystemPrompt(record, remainingAfterMsgs, context);
  }

  return systemPrompt;
}

function cleanupLeakedProcesses(
  processManager: ProcessManager | undefined,
  preAgentProcessIds: Set<string>,
): void {
  const pm = processManager;
  if (!pm) return;
  for (const p of pm.list()) {
    if (!preAgentProcessIds.has(p.id)) {
      pm.stop(p.id);
    }
  }
}

async function disposeSession(session: AgentSession): Promise<void> {
  try {
    await session.dispose();
  } catch (error) {
    logger.warn('[AgentOrchestrator] session disposal failed', {
      error: summarizeError(error),
    });
  }
}

async function executeToolCalls(
  toolCalls: Awaited<ReturnType<LLMProvider['chat']>>['toolCalls'],
  toolRegistry: ToolRegistry,
  session: AgentSession,
  turn: number,
  record: AgentRecord,
  callHistory: string[],
  callHistoryWindow: number,
  context: AgentOrchestratorRunContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const originalCall of toolCalls) {
    const call = { ...originalCall, arguments: { ...originalCall.arguments } };
    const argsSummary = summarizeToolArgs(call.arguments as Record<string, unknown>);
    record.progress = `Turn ${turn} · ${call.name}${argsSummary}`;
    record.toolCallCount++;
    context.emitAgentProgress(record.id, record.progress);
    context.emitOrchestrationProgress(record, record.progress);

    if (call.name === 'exec' || call.name === 'precision_exec') {
      call.arguments = structuredClone(call.arguments);
      const execArgs = call.arguments as Record<string, unknown>;
      if (Array.isArray(execArgs.commands)) {
        for (const cmd of execArgs.commands as Record<string, unknown>[]) {
          cmd.background = false;
          if (!cmd.timeout_ms) cmd.timeout_ms = 600_000;
        }
      }
      if (!execArgs.timeout_ms) execArgs.timeout_ms = 600_000;
    }

    const callSig = `${call.name}::${JSON.stringify(call.arguments)}`;
    try {
      const signal = context.getCancellationSignal?.(record.id);
      const result = await toolRegistry.execute(call.id, call.name, call.arguments, signal ? { signal } : undefined);
      results.push({ ...result, callId: call.id });
      // Stage B: schedule a debounced reindex of any touched file(s). Never awaited.
      try {
        context.onToolExecuted?.(call.name, call.arguments as Record<string, unknown>, result.success !== false);
      } catch (hookErr) {
        logger.warn('onToolExecuted hook error', { tool: call.name, error: summarizeError(hookErr) });
      }
      session.appendMessage({
        type: 'tool_execution',
        turn,
        toolName: call.name,
        toolCallId: call.id,
        success: result.success !== false,
        args: JSON.stringify(call.arguments).slice(0, 500),
        resultPreview: (result.output ?? result.error ?? '').slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const toolErr = summarizeError(err);
      results.push({
        callId: call.id,
        success: false,
        error: toolErr,
      });
      session.appendMessage({
        type: 'tool_execution',
        turn,
        toolName: call.name,
        toolCallId: call.id,
        success: false,
        args: JSON.stringify(call.arguments).slice(0, 500),
        resultPreview: toolErr.slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    }

    callHistory.push(callSig);
    if (callHistory.length > callHistoryWindow) callHistory.shift();
  }

  return results;
}

async function finalizeAgentRun(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
): Promise<void> {
  const statusAfterLoop = (record as { status: string }).status;
  if (statusAfterLoop !== 'failed' && statusAfterLoop !== 'cancelled') {
    record.status = 'completed';
  }
  record.completedAt = Date.now();
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);

  if (context.runtimeBus && record.status !== 'failed' && statusAfterLoop !== 'cancelled') {
    context.emitAgentCompletedEvent(
      record.id,
      (record.completedAt ?? Date.now()) - record.startedAt,
      record.fullOutput ?? '',
      record.toolCallCount,
      record.usage,
    );
    context.emitOrchestrationCompleted(record, record.fullOutput ?? '');
  }

  if (record.status === 'failed') {
    context.emitAgentFailedEvent(
      record.id,
      record.error ?? 'Circuit breaker tripped',
      Date.now() - record.startedAt,
    );
    context.emitOrchestrationFailed(record, record.error ?? 'Circuit breaker tripped');
    logger.error(`Agent ${record.id} circuit-breaker terminated`, { error: record.error, toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'failed',
      error: record.error,
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  } else if (statusAfterLoop === 'cancelled') {
    context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
    context.emitOrchestrationCancelled(record, 'Agent cancelled');
    logger.info(`Agent ${record.id} cancelled (detected post-loop)`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'cancelled',
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  } else {
    logger.info(`Agent ${record.id} completed`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'completed',
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  }

  if (session) {
    await disposeSession(session);
  }
}

async function handleAgentRunFailure(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  conversation: ConversationManager | null,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
  err: unknown,
): Promise<void> {
  const message = summarizeError(err, {
    ...(record.provider ? { provider: record.provider } : {}),
  });
  if (conversation) {
    const lastMessages = conversation.getMessagesForLLM();
    const lastAssistant = [...lastMessages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
    }
  }
  record.status = 'failed';
  record.error = message;
  record.completedAt = Date.now();
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
  context.emitAgentFailedEvent(record.id, message, Date.now() - record.startedAt);
  context.emitOrchestrationFailed(record, message);
  logger.error(`Agent ${record.id} failed`, { error: message });
  if (session) {
    session.appendMessage({
      type: 'session_end',
      status: 'failed',
      error: message,
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
    await disposeSession(session);
  }
}

export async function runAgentTask(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
): Promise<void> {
  record.status = 'running';
  record.progress = 'Initialising…';
  record.usage = {
    inputTokens: record.usage?.inputTokens ?? 0,
    outputTokens: record.usage?.outputTokens ?? 0,
    cacheReadTokens: record.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: record.usage?.cacheWriteTokens ?? 0,
    ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
    llmCallCount: record.usage?.llmCallCount ?? 0,
    turnCount: record.usage?.turnCount ?? 0,
    reasoningSummaryCount: record.usage?.reasoningSummaryCount ?? 0,
  };
  context.emitAgentStarted(record.id);
  context.emitAgentProgress(record.id, record.progress);
  context.emitOrchestrationProgress(record, record.progress);

  let session: AgentSession | null = null;
  let conversation: ConversationManager | null = null;
  const preAgentProcessIds = new Set((context.processManager?.list() ?? []).map((p) => p.id));

  try {
    const providerRegistry = context.providerRegistry;
    const currentModel = providerRegistry.getCurrentModel();
    const primaryRoute = context.resolveProviderForRecord(providerRegistry, record, currentModel);
    let activeRoute = primaryRoute;
    let fallbackRouteIndex = 0;
    const fallbackRoutes = context.resolveFallbackModelRoutes(
      providerRegistry,
      record,
      currentModel,
      primaryRoute.requestedModelId,
    );
    const modelId = primaryRoute.modelId;
    record.model = record.model ?? primaryRoute.requestedModelId;
    record.provider = record.provider ?? activeRoute.provider.name;

    session = new AgentSession(record.id, modelId, record.provider ?? currentModel.provider ?? 'unknown', {
      sessionsDir: resolveScopedDirectory(context.workingDirectory, context.surfaceRoot, 'sessions'),
      stateDir: resolveScopedDirectory(context.workingDirectory, context.surfaceRoot, 'state'),
    });
    session.appendMessage({ type: 'session_config', template: record.template, task: record.task, tools: record.tools, model: modelId, provider: record.provider ?? 'unknown', timestamp: new Date().toISOString() });

    const toolRegistry = context.buildScopedRegistry(record.tools, context.getFullRegistry());
    const toolDefinitions = toolRegistry.getToolDefinitions();
    const toolTokens = toolDefinitions.length > 0
      ? estimateTokens(JSON.stringify(toolDefinitions))
      : 0;

    conversation = new ConversationManager();
    conversation.addUserMessage(record.task);
    // Wave-3 Part C6 bridge: hand AgentManager a live accessor onto THIS
    // ConversationManager instance so a fleet tab can render a full-fidelity
    // transcript while the agent runs. `activeConversation` is a separate
    // const (rather than closing over the outer `let conversation`) so the
    // closure's type is non-nullable without a runtime assertion.
    const activeConversation = conversation;
    context.registerConversationSource?.(record.id, () => activeConversation.getMessageSnapshot());

    let systemPrompt = buildOrchestratorSystemPrompt(record, undefined, context);

    // Wave-5 (wo801, W5.1) per-turn passive-injection state. `knowledgeIdsAlreadySurfaced`
    // seeds from the spawn-time baseline (record.knowledgeInjections, just populated by the
    // call above) and grows with every id a later turn injects, so no record is ever listed
    // twice across the whole run. `priorTurnKnowledgeBlock` is the last successfully-built
    // block, reused verbatim on turns where nothing new arrived (see newUserInputThisTurn
    // below) — it is composed onto the CURRENT `systemPrompt` fresh every turn (see
    // composeTurnSystemPrompt), never written back into the cached `systemPrompt` let itself.
    const knowledgeIdsAlreadySurfaced = new Set<string>((record.knowledgeInjections ?? []).map((entry) => entry.id));
    let priorTurnKnowledgeBlock: string | null = null;

    let continueLoop = true;
    let turn = 0;
    record.progress = 'Turn 1 · Thinking…';
    context.emitAgentProgress(record.id, record.progress);
    context.emitOrchestrationProgress(record, record.progress);

    const callHistory: string[] = [];
    const LOOP_SYSTEM_THRESHOLD = 3;
    const LOOP_USER_THRESHOLD = 5;
    const CALL_HISTORY_WINDOW = 20;
    const circuitBreaker = new ConsecutiveErrorBreaker();
    // Track which inter-agent messages have already been injected so a single
    // directive/broadcast is appended to the conversation exactly once (getMessages
    // returns all unexpired messages every turn until their TTL elapses).
    const injectedMessageIds = new Set<string>();
    // Iteration budget for the chat retry loop. Includes one slot per fallback
    // route so fallback-model transitions don't cannibalize the network/rate-limit
    // retry allowances.
    const maxChatRetryIterations =
      NETWORK_RETRY_DELAYS_MS.length + RATE_LIMIT_MAX_RETRIES + fallbackRoutes.length + 4;

    while (continueLoop) {
      if ((record as { status: string }).status === 'cancelled') {
        record.completedAt = Date.now();
        context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
        cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
        if (session) {
          session.appendMessage({ type: 'session_end', status: 'cancelled', turn, timestamp: new Date().toISOString() });
          await disposeSession(session);
        }
        return;
      }
      if (++turn > MAX_TURNS) {
        const lastMessages = conversation.getMessagesForLLM();
        const lastAssistant = [...lastMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
        }
        record.status = 'failed';
        record.error = `Exceeded maximum turn limit (${MAX_TURNS})`;
        if (session) {
          session.appendMessage({ type: 'session_end', status: 'max_turns_exceeded', turn, timestamp: new Date().toISOString() });
          await disposeSession(session);
        }
        context.emitAgentFailedEvent(record.id, record.error, Date.now() - record.startedAt);
        return;
      }
      session.appendMessage({ type: 'llm_request', turn, messageCount: conversation.getMessagesForLLM().length, timestamp: new Date().toISOString() });
      const pending = context.messageBus.getMessages(record.id);
      // Steers drained into the conversation THIS turn, awaiting the "consumed"
      // signal below — deferred until the turn's chat call actually succeeds.
      // See the comment at the emission site for why this can't fire here.
      const drainedSteerMessageIds: string[] = [];
      // Wave-5 (wo801, W5.1): true when this turn actually added new content to the
      // conversation the model will see — turn 1 (the initial task) or any steer/directive
      // drained just above. Gates per-turn knowledge re-retrieval: no new input means the
      // evolving-conversation query would be identical to last turn's, so the prior turn's
      // block is reused verbatim instead of re-running retrieval for no behavioral gain.
      let newUserInputThisTurn = turn === 1;
      for (const msg of pending) {
        // Skip the agent's own broadcasts and any message already injected on a
        // prior turn so each directive is surfaced to the model exactly once.
        if (msg.from === record.id) continue;
        if (injectedMessageIds.has(msg.id)) continue;
        injectedMessageIds.add(msg.id);
        newUserInputThisTurn = true;
        if (msg.kind === 'steer') {
          // A human steer (ProcessRegistry.steer) is a genuine user turn, not
          // an inter-agent directive — inject it verbatim, with none of the
          // "[Kind from sender]" framing used for agent-to-agent messages.
          conversation.addUserMessage(msg.content);
          drainedSteerMessageIds.push(msg.id);
        } else {
          const kindLabel = (msg.kind[0] ?? '').toUpperCase() + msg.kind.slice(1);
          conversation.addUserMessage(`[${kindLabel} from ${msg.from}]: ${msg.content}`);
        }
      }

      const contextWindowAwarenessEnabled = context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true;
      const passiveKnowledgeInjectionEnabled = context.featureFlagManager?.isEnabled('agent-passive-knowledge-injection') ?? true;
      // Resolved once per turn (used by both the awareness check below and the per-turn
      // knowledge budget), rather than only inside the awareness branch, so the passive-
      // injection budget can derive "3% of context window" even when context-window
      // awareness itself is disabled.
      let contextWindowForTurn = 0;
      if (contextWindowAwarenessEnabled || passiveKnowledgeInjectionEnabled) {
        const modelDef = resolveContextWindowModelDefinition(providerRegistry, activeRoute);
        contextWindowForTurn = context.providerRegistry.getContextWindowForModel(modelDef);
      }

      if (contextWindowAwarenessEnabled) {
        systemPrompt = applyContextWindowAwareness(
          context,
          record,
          activeRoute.modelId,
          contextWindowForTurn,
          conversation,
          systemPrompt,
          toolTokens,
          turn,
        );
      }

      // Wave-5 (wo801, W5.1): per-turn passive knowledge injection. Gated on the feature
      // flag AND on there being new conversation input this turn; otherwise
      // priorTurnKnowledgeBlock (unchanged) is reused. `priorTurnKnowledgeBlock` and
      // `systemPrompt` are combined into a request-time-only string just below
      // (composeTurnSystemPrompt) — the block is NEVER written back into the `systemPrompt`
      // let, so it cannot compound turn over turn even across the emergency-compaction
      // retry path (which DOES reassign `systemPrompt`) inside the chat-retry loop.
      if (passiveKnowledgeInjectionEnabled && newUserInputThisTurn && context.memoryRegistry) {
        const configuredBudget = context.passiveKnowledgeInjectionBudgetTokens
          ?? defaultTurnKnowledgeBudgetTokens(contextWindowForTurn);
        let turnBudgetTokens = configuredBudget;
        if (contextWindowAwarenessEnabled && contextWindowForTurn > 0) {
          // Clamp the block's budget to whatever headroom is left under the SAME 85%
          // compaction threshold applyContextWindowAwareness just enforced on the base
          // prompt, so base+block can never silently exceed it even though the block is
          // composed after that check ran (risk: B-tier token dishonesty otherwise).
          const msgTokensForBudget = estimateConversationTokens(conversation.getMessagesForLLM());
          const sysTokensForBudget = estimateTokens(systemPrompt);
          const threshold = Math.floor(contextWindowForTurn * CONTEXT_COMPACT_THRESHOLD);
          const headroomTokens = threshold - msgTokensForBudget - sysTokensForBudget - toolTokens;
          turnBudgetTokens = Math.max(0, Math.min(configuredBudget, headroomTokens));
        }
        if (turnBudgetTokens > 0) {
          const relevanceFloor = context.passiveKnowledgeInjectionRelevanceFloor ?? DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR;
          // Stage B: code hits share this turn's SAME budget/floor. Gated on the separate
          // (default-off) code-injection flag AND the embedder's storage.codeIndexEnabled setting.
          const codeInjectionEnabled = !!context.codeIndex
            && (context.featureFlagManager?.isEnabled('agent-passive-code-injection') ?? false)
            && (context.isCodeInjectionSettingEnabled?.() ?? true);
          const { block, record: turnInjectionRecord } = buildPerTurnKnowledgeInjection({
            memoryRegistry: context.memoryRegistry,
            task: record.task,
            writeScope: record.writeScope ?? [],
            conversationTail: conversation.getMessagesForLLM(),
            budgetTokens: turnBudgetTokens,
            relevanceFloor,
            alreadyInjectedIds: [...knowledgeIdsAlreadySurfaced],
            turn,
            codeIndex: context.codeIndex,
            codeInjectionEnabled,
          });
          priorTurnKnowledgeBlock = block;
          for (const id of turnInjectionRecord.injectedIds) knowledgeIdsAlreadySurfaced.add(id);
          record.turnInjections = recordTurnInjection(record.turnInjections, turnInjectionRecord);
          session.appendMessage({ type: 'knowledge_injection', ...turnInjectionRecord });
        } else {
          // Hard no-op: no budget headroom this turn. Never call into retrieval for a
          // budget that's already known to be zero, and never claim a block that can't
          // exist — no record, no session message, prior block cleared so the composed
          // prompt below falls back to the base systemPrompt exactly.
          priorTurnKnowledgeBlock = null;
        }
      }

      // Wave-5 (wo801, W5.1): compose the per-turn knowledge block onto the base
      // systemPrompt fresh at EVERY call site (including each chat-retry iteration below),
      // instead of hoisting a single `const turnSystemPrompt` computed once before the
      // retry loop. This matters because the emergency-compaction retry path inside that
      // loop reassigns the outer `systemPrompt` let (buildLayeredOrchestratorSystemPrompt)
      // — a hoisted const would go stale and keep resubmitting the pre-compaction prompt,
      // silently defeating that retry. Composing here also re-validates fit on every call:
      // if base+block would exceed the SAME 85% compaction threshold applyContextWindowAwareness
      // enforces (using live, current-call token counts, not turn-start estimates), the block
      // is dropped for that call only — this is the safety net for a REUSED block (one that
      // was sized against a headroom estimate one or more turns ago and may no longer fit,
      // e.g. after several no-new-input turns of tool-result growth). It never mutates
      // `priorTurnKnowledgeBlock` or the stored TurnInjectionRecord, both of which honestly
      // reflect what retrieval computed at the time it ran.
      const composeTurnSystemPrompt = (base: string): string => {
        if (!priorTurnKnowledgeBlock) return base;
        if (contextWindowAwarenessEnabled && contextWindowForTurn > 0) {
          const liveMsgTokens = estimateConversationTokens(activeConversation.getMessagesForLLM());
          const liveSysTokens = estimateTokens(base);
          const liveBlockTokens = estimateTokens(priorTurnKnowledgeBlock);
          const threshold = Math.floor(contextWindowForTurn * CONTEXT_COMPACT_THRESHOLD);
          if (liveMsgTokens + liveSysTokens + liveBlockTokens + toolTokens > threshold) {
            return base;
          }
        }
        return `${base}\n\n${priorTurnKnowledgeBlock}`;
      };

      let response: Awaited<ReturnType<LLMProvider['chat']>> | undefined;
      {
        let networkAttempt = 0;
        let rateLimitAttempt = 0;
        let contextRetried = false;
        for (let chatRetryIteration = 0; chatRetryIteration < maxChatRetryIterations; chatRetryIteration++) {
          let streamAccumulated = '';
          record.streamingContent = undefined;

          const onDelta = (delta: StreamDelta) => {
            if (delta.content) {
              streamAccumulated += delta.content;
              // Live model output goes to streamingContent (rendered in the agent
              // inspector / detail view) and is emitted via emitStreamDelta below.
              // Do NOT overwrite record.progress with the raw output tail: progress
              // is the concise one-line status surfaced as RuntimeAgent.latestProgress
              // (e.g. the process indicator), so it must keep the last meaningful
              // status ("Turn N · <tool>" / "Thinking…") rather than firehosing output.
              record.streamingContent = streamAccumulated;
            }
            context.emitStreamDelta(record.id, delta.content ?? '', streamAccumulated);
          };

          try {
            response = await activeRoute.provider.chat({
              model: activeRoute.modelId,
              messages: conversation.getMessagesForLLM(),
              tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
              systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(composeTurnSystemPrompt(systemPrompt)),
              ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
              onDelta,
            });
            break;
          } catch (chatErr) {
            if (
              isContextSizeExceededError(chatErr) &&
              !contextRetried &&
              (context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true)
            ) {
              contextRetried = true;
              logger.warn(
                `[AgentOrchestrator] context-window awareness: context size exceeded on turn ${turn} - emergency compaction and retry`,
                { agentId: record.id, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Turn ${turn} · Context exceeded, compacting…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              const currentMessages = conversation.getMessagesForLLM();
              const compacted = compactSmallWindow(
                currentMessages,
                Math.max(5, Math.floor(currentMessages.length / 3)),
              );
              conversation.replaceMessagesForLLM(compacted);
              systemPrompt = buildLayeredOrchestratorSystemPrompt(record, 0, context);
            } else if (fallbackRouteIndex < fallbackRoutes.length) {
              const previousRoute = activeRoute;
              activeRoute = fallbackRoutes[fallbackRouteIndex++]!;
              const reason = chatErr instanceof Error ? chatErr.message : String(chatErr);
              const previousRouteId = providerQualifiedRouteLabel(previousRoute);
              const activeRouteId = providerQualifiedRouteLabel(activeRoute);
              logger.warn('[AgentOrchestrator] switching to fallback model', {
                agentId: record.id,
                from: previousRouteId,
                to: activeRouteId,
                reason,
              });
              context.providerOptimizer?.recordFallbackTransition(previousRouteId, activeRouteId, reason);
              record.model = activeRouteId;
              record.provider = activeRoute.provider.name;
              record.progress = `Model fallback → ${activeRouteId}`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
            } else if (isNetworkTransportError(chatErr) && networkAttempt < NETWORK_RETRY_DELAYS_MS.length) {
              const delayMs = NETWORK_RETRY_DELAYS_MS[networkAttempt]!;
              const delaySec = Math.round(delayMs / 1000);
              logger.warn(
                `Agent ${record.id}: network error on turn ${turn}, retrying in ${delaySec}s (attempt ${networkAttempt + 1}/${NETWORK_RETRY_DELAYS_MS.length})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Network error, retrying in ${delaySec}s…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              networkAttempt++;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delayMs);
                timer.unref?.();
              });
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during network retry');
              }
            } else if (isRateLimitOrQuotaError(chatErr) && rateLimitAttempt < RATE_LIMIT_MAX_RETRIES) {
              const delaySec = Math.round(RATE_LIMIT_RETRY_DELAY_MS / 1000);
              logger.warn(
                `Agent ${record.id}: rate limited on turn ${turn}, retrying in ${delaySec}s (attempt ${rateLimitAttempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Rate limited, retrying in ${delaySec}s…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              rateLimitAttempt++;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS);
                timer.unref?.();
              });
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during rate limit retry');
              }
            } else {
              throw chatErr;
            }
          }
        }
        if (response === undefined) {
          throw new Error(`Agent ${record.id}: chat retry loop exceeded ${maxChatRetryIterations} iterations`);
        }
        record.streamingContent = undefined;
        record.progress = `Turn ${turn} · Thinking…`;
      }

      // Honest "consumed at boundary" signal, emitted here (not at drain time
      // above) because this is the first point in the turn where the chat
      // call is KNOWN to have succeeded. If the call above exhausted its
      // retries/fallbacks, it throws and unwinds out of this function (caught
      // by the outer try/catch → handleAgentRunFailure) without ever reaching
      // this line — so a steer drained into a turn whose chat then fails
      // never gets a consumed signal it didn't earn. Never emit this from
      // AgentMessageBus.send() itself — that fires eagerly, before the agent
      // has any chance to see the message.
      if (context.runtimeBus) {
        for (const messageId of drainedSteerMessageIds) {
          emitCommunicationConsumed(context.runtimeBus, context.emitterContext(record.id), {
            messageId,
            agentId: record.id,
            turn,
          });
        }
      }

      session.appendMessage({ type: 'llm_response', turn, contentLength: response.content.length, toolCallCount: response.toolCalls.length, usage: response.usage, timestamp: new Date().toISOString() });
      record.usage = {
        inputTokens: (record.usage?.inputTokens ?? 0) + response.usage.inputTokens,
        outputTokens: (record.usage?.outputTokens ?? 0) + response.usage.outputTokens,
        cacheReadTokens: (record.usage?.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (record.usage?.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0),
        ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
        llmCallCount: (record.usage?.llmCallCount ?? 0) + 1,
        turnCount: (record.usage?.turnCount ?? 0) + 1,
        reasoningSummaryCount: (record.usage?.reasoningSummaryCount ?? 0) + (response.reasoningSummary ? 1 : 0),
      };

      if (response.toolCalls.length > 0) {
        conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, usage: response.usage });
        const results = await executeToolCalls(
          response.toolCalls,
          toolRegistry,
          session,
          turn,
          record,
          callHistory,
          CALL_HISTORY_WINDOW,
          context,
        );
        conversation.addToolResults(results);

        const allFailed = results.length > 0 && results.every(r => r.success === false);
        if (allFailed) {
          const cbResult = circuitBreaker.recordAllFailed();
          logger.warn(`Agent ${record.id}: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
          if (cbResult === 'break') {
            conversation.addSystemMessage(
              `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. ` +
              `The agent loop is stopping to prevent an infinite failure cycle. ` +
              `Report what you were trying to do and what errors you encountered.`,
            );
            record.status = 'failed';
            record.error = `Circuit breaker tripped after ${circuitBreaker.consecutiveErrors} consecutive all-error turns`;
            record.completedAt = Date.now();
            continueLoop = false;
          } else if (cbResult === 'warn') {
            conversation.addSystemMessage(
              `You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
              `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
              `then try a completely different strategy.`,
            );
          }
        } else if (results.length > 0) {
          circuitBreaker.recordSuccess();
        }

        const sigCounts = new Map<string, { count: number; toolName: string }>();
        for (const sig of callHistory) {
          const name = sig.slice(0, sig.indexOf('::'));
          const entry = sigCounts.get(sig);
          if (entry) {
            entry.count++;
          } else {
            sigCounts.set(sig, { count: 1, toolName: name });
          }
        }
        let worstCount = 0;
        let worstTool = '';
        for (const [_sig, { count, toolName }] of sigCounts) {
          if (count > worstCount) {
            worstCount = count;
            worstTool = toolName;
          }
        }
        if (worstCount >= LOOP_USER_THRESHOLD) {
          logger.warn(`Agent ${record.id}: loop detected — ${worstTool} called ${worstCount} times with identical args`);
          conversation.addUserMessage(
            `You are repeating the same tool call. ${worstTool} has been called ${worstCount} times with identical arguments and results. Do NOT call ${worstTool} with these arguments again. Identify what you were trying to accomplish and take a different action.`,
          );
        } else if (worstCount >= LOOP_SYSTEM_THRESHOLD) {
          logger.warn(`Agent ${record.id}: possible loop — ${worstTool} called ${worstCount} times with identical args`);
          conversation.addSystemMessage(
            `You have already executed this exact call (${worstTool}) ${worstCount} times with identical arguments. The results from your previous calls are already in your conversation history. Review them and proceed to the next step.`,
          );
        }
        record.progress = `Turn ${turn} · Thinking…`;
      } else {
        conversation.addAssistantMessage(response.content, { usage: response.usage });
        record.fullOutput = response.content;
        record.progress = response.content.slice(0, 200) || 'Done.';
        continueLoop = false;
      }
    }

    await finalizeAgentRun(context, record, session, preAgentProcessIds);
  } catch (err) {
    await handleAgentRunFailure(context, record, conversation, session, preAgentProcessIds, err);
  } finally {
    // Wave-3 Part C6 bridge: release on EVERY exit path (normal completion,
    // the mid-loop cancellation/MAX_TURNS early returns above, and the catch
    // above) so the live source is never retained past the run and a final
    // snapshot always lands in AgentManager's retention ring. A no-op when
    // register was never called (e.g. failure before the ConversationManager
    // was created).
    context.releaseConversationSource?.(record.id);
  }
}
