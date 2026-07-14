import { ToolRegistry } from '../tools/registry.js';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';
import { resolveAtRestPolicy } from '../runtime/at-rest-persistence.js';
import type { ConversationMessageSnapshot } from '../core/conversation.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { registerAllTools } from '../tools/index.js';
import { registerChannelAgentTools } from '../tools/channel/agent-tools.js';
import { AgentMessageBus } from './message-bus.js';
import type { ChannelPluginRegistry } from '../channels/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { ToolLLM } from '../config/tool-llm.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ModelDefinition } from '../providers/registry-types.js';
import type { RequestProfile } from '../providers/capabilities.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentRunning,
  emitAgentStreamDelta,
  emitOrchestrationNodeCancelled,
  emitOrchestrationNodeCompleted,
  emitOrchestrationNodeFailed,
  emitOrchestrationNodeProgress,
} from '../runtime/emitters/index.js';
import { findModelDefinition } from '../providers/registry-models.js';
import { resolveModelReference } from '../providers/model-id-resolution.js';
import { runAgentTask, type AgentOrchestratorRunContext } from './orchestrator-runner.js';
export { summarizeToolArgs } from './orchestrator-utils.js';

/**
 * Conversation-snapshot bridge (Part C6): where AgentOrchestrator forwards a running agent's
 * live conversation-snapshot accessor. In production this is AgentManager's
 * registerConversationSource/releaseConversationSource, wired post-
 * construction in runtime/services.ts (AgentOrchestrator is constructed
 * before AgentManager there, so this is a setter rather than a constructor
 * dependency — same pattern as setRuntimeBus).
 */
export interface AgentConversationSink {
  readonly register: (agentId: string, source: () => ConversationMessageSnapshot[]) => void;
  readonly release: (agentId: string) => void;
}

/**
 * Cooperative cancellation bridge: where AgentOrchestrator
 * looks up a per-agent AbortSignal registered by an orchestration engine's
 * work-item run. Same shape/wiring precedent as AgentConversationSink — a
 * setter rather than a constructor dependency, wired post-construction in
 * runtime/services.ts (production backing is
 * AgentManager.registerCancellationSignal/getCancellationSignal).
 */
export interface AgentCancellationSource {
  readonly get: (agentId: string) => AbortSignal | undefined;
}

type AgentProviderRoutingPolicy = NonNullable<AgentRecord['routing']>;
type ActiveModelRef = { id: string; provider: string; registryKey: string };
type ResolvedAgentProviderRouting = {
  readonly requestedModelId: string;
  readonly providerSelection: NonNullable<AgentProviderRoutingPolicy['providerSelection']>;
  readonly providerFailurePolicy: NonNullable<AgentProviderRoutingPolicy['providerFailurePolicy']>;
  readonly providerId?: string | undefined;
  readonly providerOverride?: string | undefined;
  readonly fallbackModels: readonly string[];
};

type AgentOrchestratorToolDeps = {
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  readonly workingDirectory: string;
  readonly surfaceRoot: string;
  readonly fileUndoManager: import('../state/file-undo.js').FileUndoManager;
  readonly modeManager: import('../state/mode-manager.js').ModeManager;
  readonly processManager: import('../tools/shared/process-manager.js').ProcessManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly webSearchService?: import('../web-search/index.js').WebSearchService | undefined;
  readonly channelRegistry?: import('../channels/index.js').ChannelPluginRegistry | null | undefined;
  readonly remoteRunnerRegistry?: import('../runtime/remote/index.js').RemoteRunnerRegistry | undefined;
  readonly knowledgeService?: import('../knowledge/index.js').KnowledgeService | undefined;
  readonly memoryRegistry?: import('../state/index.js').MemoryRegistry | undefined;
  readonly codeIndex?: import('./turn-knowledge-injection.js').TurnCodeIndexSource | undefined;
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  readonly codeIndexReindexScheduler?: Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'onToolExecuted'> | undefined;
  /** Additional per-tool-execution tap (e.g. CI auto-watch minting); composed with the reindex scheduler, never blocking. */
  readonly toolExecutionObserver?: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  readonly sessionOrchestration: import('../sessions/orchestration/index.js').CrossSessionTaskRegistry;
  readonly archetypeLoader?: import('./archetypes.js').ArchetypeLoader | undefined;
  readonly configManager?: ConfigManager | undefined;
  readonly providerRegistry?: ProviderRegistry | undefined;
  readonly providerOptimizer?: import('../providers/optimizer.js').ProviderOptimizer | undefined;
  readonly toolLLM?: ToolLLM | undefined;
  readonly serviceRegistry?: import('../config/service-registry.js').ServiceRegistry | undefined;
  readonly secretsManager?: Pick<import('../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly overflowHandler?: import('../tools/shared/overflow.js').OverflowHandler | undefined;
  readonly sandboxSessionRegistry: import('../runtime/sandbox/session-registry.js').SandboxSessionRegistry;
  readonly workflowServices: ReturnType<typeof import('../tools/workflow/index.js').createWorkflowServices>;
  /**
   * Permission gate applied to this orchestrator's background/subagent tool
   * calls (see AgentOrchestratorRunContext.permissionManager). Optional — when
   * omitted, background runs are ungated exactly as before background
   * permission enforcement existed.
   */
  readonly permissionManager?:
    | Pick<import('../permissions/manager.js').PermissionManager, 'checkDetailed' | 'check' | 'getBackgroundAgentsMode' | 'previewReadAccess'>
    | undefined;
  /**
   * Settable holder for the context_accounting tool's session source. Threaded
   * through so the tool is registered on the shared roster; the interactive
   * session binds its Orchestrator-backed source after construction.
   */
  readonly contextAccountingHolder?: import('../tools/context-accounting/index.js').ContextAccountingHolder | undefined;
  /**
   * Broker a per-command exec-sandbox host-access escalation through the
   * approval broker before the command runs. Threaded to registerAllTools so
   * the exec tool's sandbox raises named escalation asks. Omitted → escalations
   * are not asked (today's behavior).
   */
  readonly sandboxEscalationHandler?: ((input: {
    readonly command: string;
    readonly escalations: readonly string[];
    readonly boundary: string;
    readonly policyReasons: readonly string[];
    readonly workingDirectory?: string | undefined;
  }) => Promise<boolean>) | undefined;
  /**
   * Broker the one-tap "allow localhost fetches for this project" ask through
   * the approval broker. Threaded to registerAllTools so the fetch tool can
   * ask once and persist the per-project approval. Omitted → unapproved
   * localhost fetches are refused with an honest reason.
   */
  readonly localhostFetchApproval?: ((input: { url: string; host: string }) => Promise<boolean>) | undefined;
  /** Reports each contained (sandboxed) command run for the announce-once containment receipt. */
  readonly onSandboxedRun?: (() => void) | undefined;
  /**
   * Broker an exec PTY terminal-prompt answer through the approval broker
   * while the command keeps running. Threaded to registerAllTools so the exec
   * tool can answer prompts (host-key confirmations, credential asks) instead
   * of hanging to timeout. Omitted → the PTY path is not engaged.
   */
  readonly execPromptAnswerHandler?: ((ask: import('../tools/exec/interactive.js').ExecPromptAsk) => Promise<import('../tools/exec/interactive.js').ExecPromptAnswer>) | undefined;
};

/**
 * AgentOrchestrator — runs AgentRecord tasks in-process.
 *
 * Each agent gets its own scoped ToolRegistry containing only the tools
 * listed in record.tools. The execution loop itself now lives in
 * `orchestrator-runner.ts`; this class owns shared registry/state wiring.
 */
export class AgentOrchestrator {
  /**
   * Keyed by working directory. A ToolRegistry is permanently bound to one
   * cwd at construction (every tool factory closes over it — see
   * tools/index.ts registerAllTools), so a distinct cwd genuinely needs its
   * own registry, not a mutable field. The default cwd
   * (`this.toolDeps.workingDirectory`) is cached under its own key exactly
   * like the single `fullRegistry` field this replaces — same lazy-build,
   * same channel-version invalidation, same object identity once built.
   */
  private fullRegistries = new Map<string, ToolRegistry>();
  private fullRegistryChannelVersion = -2;
  private toolDeps: AgentOrchestratorToolDeps | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private conversationSink: AgentConversationSink | null = null;
  private cancellationSource: AgentCancellationSource | null = null;
  private readonly channelRegistry: ChannelPluginRegistry | null;
  private readonly messageBus: import('./message-bus.js').AgentMessageBus;

  constructor(config: {
    channelRegistry?: ChannelPluginRegistry | null | undefined;
    messageBus: import('./message-bus.js').AgentMessageBus;
  } = {
    messageBus: new AgentMessageBus(),
  }) {
    this.channelRegistry = config.channelRegistry ?? null;
    this.messageBus = config.messageBus;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /** Set the FeatureFlagManager for context-window awareness gating. */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this.featureFlagManager = manager;
  }

  /**
   * Wire the conversation-snapshot bridge (Part C6; see
   * AgentConversationSink). Pass null to detach — createRunContext() then
   * omits the register/release callbacks entirely and orchestrator-runner's
   * `?.()` calls become no-ops.
   */
  setConversationSink(sink: AgentConversationSink | null): void {
    this.conversationSink = sink;
  }

  /**
   * Wire the cancellation bridge (see AgentCancellationSource). Pass
   * null to detach — createRunContext() then omits getCancellationSignal
   * entirely and orchestrator-runner's `?.()` call becomes a no-op, so every
   * tool call runs with `opts` undefined exactly as before this change.
   */
  setCancellationSource(source: AgentCancellationSource | null): void {
    this.cancellationSource = source;
  }

  private emitterContext(agentId: string): import('../runtime/emitters/index.js').EmitterContext {
    return {
      sessionId: 'agent-orchestrator',
      traceId: `agent-orchestrator:${agentId}`,
      source: 'agent-orchestrator',
    };
  }

  private emitAgentProgress(recordId: string, progress: string): void {
    if (!this.runtimeBus) return;
    emitAgentProgress(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      progress,
    });
  }

  private emitOrchestrationProgress(record: AgentRecord, progress: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeProgress(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      message: progress,
    });
  }

  private emitAgentStarted(recordId: string): void {
    if (!this.runtimeBus) return;
    emitAgentRunning(this.runtimeBus, this.emitterContext(recordId), { agentId: recordId });
  }

  private emitAgentCancelledEvent(recordId: string, reason: string): void {
    if (!this.runtimeBus) return;
    emitAgentCancelled(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      reason,
    });
  }

  private emitOrchestrationCancelled(record: AgentRecord, reason: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeCancelled(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      reason,
    });
  }

  private emitAgentFailedEvent(recordId: string, error: string, durationMs: number): void {
    if (!this.runtimeBus) return;
    emitAgentFailed(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      error,
      durationMs,
    });
  }

  private emitOrchestrationFailed(record: AgentRecord, error: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeFailed(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      error,
    });
  }

  private emitAgentCompletedEvent(
    recordId: string,
    durationMs: number,
    output: string,
    toolCallsMade: number,
    usage: AgentRecord['usage'] | undefined,
  ): void {
    if (!this.runtimeBus) return;
    emitAgentCompleted(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      durationMs,
      output,
      toolCallsMade,
      usage,
    });
  }

  private emitOrchestrationCompleted(record: AgentRecord, output: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeCompleted(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      summary: output.length > 120 ? `${output.slice(0, 117)}...` : output,
    });
  }

  private emitStreamDelta(recordId: string, content: string, accumulated: string): void {
    if (!this.runtimeBus || !content) return;
    emitAgentStreamDelta(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      content,
      accumulated,
    });
  }

  /**
   * Inject shared file-cache and project-index so agent tools share state with main session.
   * Call once during application startup, before any agents are spawned.
   */
  setDependencies(toolDeps: AgentOrchestratorToolDeps): void {
    this.toolDeps = toolDeps;
    this.fullRegistries = new Map();
    this.fullRegistryChannelVersion = -2;
  }

  /**
   * Returns the fully-populated ToolRegistry for this orchestrator's DEFAULT
   * working directory. Used by companion chat to execute tool calls emitted
   * by the LLM — companion chat has no per-call cwd override, so this always
   * resolves to `this.toolDeps.workingDirectory`. Delegates to the
   * lazy-initialized internal registry cache.
   */
  getToolRegistry(): ToolRegistry {
    return this.getFullRegistry();
  }

  /**
   * Lazily build and cache the full ToolRegistry for `workingDirectory`
   * (default: `this.toolDeps.workingDirectory`, unchanged from before this
   * cache became keyed). A non-default cwd — a spawned agent's dedicated
   * worktree (AgentRecord.workingDirectory, see AgentInput.workingDirectory)
   * — gets its OWN fresh fileCache/projectIndex rather than reusing the
   * shared session's: those are scoped to the default cwd and would
   * otherwise silently index/search the wrong directory.
   */
  private getFullRegistry(workingDirectory?: string): ToolRegistry {
    const channelVersion = this.channelRegistry?.getVersion() ?? -1;
    if (this.fullRegistryChannelVersion !== channelVersion) {
      this.fullRegistries.clear();
      this.fullRegistryChannelVersion = channelVersion;
    }
    const defaultCwd = this.toolDeps?.workingDirectory ?? '';
    const cwd = workingDirectory ?? defaultCwd;
    let registry = this.fullRegistries.get(cwd);
    if (!registry) {
      if (!this.toolDeps?.configManager || !this.toolDeps?.providerRegistry || !this.toolDeps?.toolLLM) {
        throw new Error('AgentOrchestrator requires configManager, providerRegistry, and toolLLM dependencies before tool registration');
      }
      registry = new ToolRegistry();
      const isDefaultCwd = cwd === defaultCwd;
      // Read-side deny enforcement for search/list/map tools: give them the same
      // per-file read decision the read tool gets, so a file the read tool would
      // gate (e.g. the shipped credential-read defaults) never leaks its content
      // through grep/glob/repo_map. Reads live config each call, so mode changes
      // apply immediately. Absent a permission manager, tools default to allow-all.
      const permissionManager = this.toolDeps.permissionManager;
      const readAccessFilter = permissionManager
        ? (absolutePath: string): boolean => permissionManager.previewReadAccess(absolutePath) === 'allow'
        : undefined;
      registerAllTools(registry, {
        ...this.toolDeps,
        workingDirectory: cwd,
        fileCache: isDefaultCwd ? this.toolDeps.fileCache : undefined,
        projectIndex: isDefaultCwd ? this.toolDeps.projectIndex : undefined,
        readAccessFilter,
      });
      registerChannelAgentTools(registry, this.toolDeps?.channelRegistry ?? this.channelRegistry);
      this.fullRegistries.set(cwd, registry);
    }
    return registry;
  }

  /**
   * Build a ToolRegistry containing only the tools whose names appear in
   * the allowedNames list. Filters the provided full registry into a fresh
   * scoped registry.
   */
  private buildScopedRegistry(allowedNames: string[], fullRegistry: ToolRegistry): ToolRegistry {
    const allowed = new Set(allowedNames.filter((n) => n !== 'agent'));

    const scopedRegistry = new ToolRegistry();
    for (const tool of fullRegistry.list()) {
      if (allowed.has(tool.definition.name)) {
        scopedRegistry.register(tool);
      }
    }

    return scopedRegistry;
  }

  private resolveProviderForRecord(
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>,
    record: AgentRecord,
    currentModel: ActiveModelRef,
  ): { provider: LLMProvider; modelId: string; requestedModelId: string } {
    const optimizedRoute = this.resolveOptimizedProviderRoute(providerRegistry, record);
    if (optimizedRoute) return optimizedRoute;

    const routing = this.resolveProviderRouting(record, currentModel, providerRegistry.listModels());
    const scopedModelId = this.normalizeRequestedModelId(routing.requestedModelId);

    try {
      return {
        provider: providerRegistry.getForModel(scopedModelId, routing.providerOverride),
        modelId: this.resolveChatModelId(providerRegistry, scopedModelId, routing.providerOverride),
        requestedModelId: scopedModelId,
      };
    } catch (err) {
      throw new Error(
        `Cannot resolve provider for model '${scopedModelId}': ${
          summarizeError(err)
        }`,
      );
    }
  }

  private resolveOptimizedProviderRoute(
    providerRegistry: Pick<ProviderRegistry, 'getForModel' | 'listModels'>,
    record: AgentRecord,
  ): { provider: LLMProvider; modelId: string; requestedModelId: string } | null {
    const optimizer = this.toolDeps?.providerOptimizer;
    if (!optimizer?.enabled || optimizer.mode === 'manual') return null;
    if (record.model || record.provider) return null;
    if (record.routing?.providerSelection === 'concrete' || record.routing?.providerSelection === 'synthetic') {
      return null;
    }

    const decision = optimizer.selectRoute(this.buildOptimizerRequestProfile(record));
    if (!decision?.explanation.accepted) return null;

    try {
      return {
        provider: providerRegistry.getForModel(decision.modelId, decision.providerId),
        modelId: this.resolveChatModelId(providerRegistry, decision.modelId, decision.providerId),
        requestedModelId: `${decision.providerId}:${decision.modelId}`,
      };
    } catch (error) {
      logger.warn('[AgentOrchestrator] provider optimizer selected an unresolved route; using default model routing', {
        agentId: record.id,
        providerId: decision.providerId,
        modelId: decision.modelId,
        error: summarizeError(error),
      });
      return null;
    }
  }

  private buildOptimizerRequestProfile(record: AgentRecord): RequestProfile {
    return {
      requiresToolCalling: record.tools.length > 0,
      requiresReasoningControls: record.reasoningEffort !== undefined,
    };
  }

  private resolveProviderRouting(
    record: AgentRecord,
    currentModel: ActiveModelRef,
    modelRegistry: readonly ModelDefinition[],
  ): ResolvedAgentProviderRouting {
    // A bare model override resolves via the shared resolver — the
    // record's own `provider` field (when present) is passed as context so
    // "model X on provider Y" qualifies immediately instead of demanding the
    // user already know the provider:model registryKey format.
    const resolvedModelOverride = record.model
      ? resolveModelReference(record.model, modelRegistry, { contextProviderId: record.provider })
      : undefined;
    const requestedModelId = this.normalizeRequestedModelId(resolvedModelOverride ?? currentModel.registryKey);
    const providerFromRegistryKey = resolvedModelOverride
      ? findModelDefinition(resolvedModelOverride, modelRegistry)?.provider
      : undefined;
    if (record.provider && !record.model) {
      throw new Error('Agent provider routing requires a provider-qualified model when provider is supplied.');
    }
    if (record.provider && providerFromRegistryKey && providerFromRegistryKey !== record.provider) {
      throw new Error(`Agent model override '${record.model}' conflicts with provider '${record.provider}'.`);
    }
    const fallbackModels = (
      record.routing?.fallbackModels
      ?? record.fallbackModels
      ?? []
    )
      .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      .map((model) => resolveModelReference(model.trim(), modelRegistry));
    const providerSelection = record.routing?.providerSelection ?? (
      record.provider === 'synthetic'
        ? 'synthetic'
        : record.provider
          ? 'concrete'
          : 'inherit-current'
    );
    const providerId = record.provider;
    const effectiveProviderId = providerSelection === 'synthetic'
      ? undefined
      : providerSelection === 'concrete'
        ? (providerId ?? providerFromRegistryKey ?? currentModel.provider)
        : (providerFromRegistryKey ?? currentModel.provider);
    const providerOverride = effectiveProviderId !== 'synthetic'
      ? effectiveProviderId
      : undefined;
    const providerFailurePolicy = record.routing?.providerFailurePolicy ?? (
      fallbackModels.length > 0
        ? 'ordered-fallbacks'
        : 'fail'
    );
    if (providerFailurePolicy === 'ordered-fallbacks' && fallbackModels.length === 0) {
      throw new Error('Agent ordered fallback routing requires at least one provider-qualified fallback model.');
    }
    if (providerFailurePolicy === 'fail' && fallbackModels.length > 0) {
      throw new Error('Agent fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
    }
    return {
      requestedModelId,
      providerSelection,
      providerFailurePolicy,
      providerId,
      providerOverride,
      fallbackModels,
    };
  }

  private normalizeRequestedModelId(requestedModelId: string): string {
    return requestedModelId.trim();
  }

  private resolveChatModelId(
    providerRegistry: Pick<ProviderRegistry, 'listModels'>,
    requestedModelId: string,
    providerOverride?: string,
  ): string {
    const registry = providerRegistry.listModels();
    const def = providerOverride
      ? registry.find((model) =>
          model.provider === providerOverride &&
          (model.registryKey === requestedModelId || model.id === requestedModelId))
      : registry.find((model) => model.registryKey === requestedModelId);
    if (def) return def.id;
    throw new Error(`Model '${requestedModelId}' is not in registry.`);
  }

  private resolveFallbackModelRoutes(
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    currentModel: ActiveModelRef,
    primaryRequestedModelId: string,
  ): Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> {
    const routing = this.resolveProviderRouting(record, currentModel, providerRegistry.listModels());
    if (routing.providerFailurePolicy !== 'ordered-fallbacks' || routing.fallbackModels.length === 0) {
      return [];
    }
    const seen = new Set([primaryRequestedModelId]);
    const routes: Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> = [];
    const modelRegistry = providerRegistry.listModels();
    for (const rawFallback of routing.fallbackModels) {
      // routing.fallbackModels entries are already resolved/qualified by resolveProviderRouting().
      const requestedModelId = this.normalizeRequestedModelId(rawFallback);
      if (!requestedModelId || seen.has(requestedModelId)) continue;
      seen.add(requestedModelId);
      const fallbackDef = findModelDefinition(requestedModelId, modelRegistry);
      if (!fallbackDef) {
        throw new Error(`Agent fallback model '${requestedModelId}' is not in registry.`);
      }
      routes.push({
        provider: providerRegistry.getForModel(requestedModelId, fallbackDef.provider),
        modelId: this.resolveChatModelId(providerRegistry, requestedModelId, fallbackDef.provider),
        requestedModelId,
      });
    }
    return routes;
  }

  /**
   * @param workingDirectory Per-call cwd override (AgentRecord.workingDirectory).
   * Absent ⇒ `this.toolDeps.workingDirectory`, byte-identical to every run
   * context built before this parameter existed.
   */
  private createRunContext(workingDirectory?: string): AgentOrchestratorRunContext {
    const cwd = workingDirectory ?? this.toolDeps?.workingDirectory ?? '';
    const configManager = this.toolDeps?.configManager;
    // Defensive getter: a config snapshot predating the atRest section must fall
    // back to the honest default, never throw out of an agent run.
    const atRestGet = configManager
      ? (key: string): unknown => { try { return configManager.get(key as ConfigKey); } catch { return undefined; } }
      : undefined;
    return {
      workingDirectory: cwd,
      surfaceRoot: this.toolDeps?.surfaceRoot ?? '',
      atRestPolicy: resolveAtRestPolicy(atRestGet),
      ...(configManager ? { configManager } : {}),
      runtimeBus: this.runtimeBus,
      featureFlagManager: this.featureFlagManager,
      emitterContext: (agentId) => this.emitterContext(agentId),
      emitAgentProgress: (recordId, progress) => this.emitAgentProgress(recordId, progress),
      emitOrchestrationProgress: (record, progress) => this.emitOrchestrationProgress(record, progress),
      emitAgentStarted: (recordId) => this.emitAgentStarted(recordId),
      emitAgentCancelledEvent: (recordId, reason) => this.emitAgentCancelledEvent(recordId, reason),
      emitOrchestrationCancelled: (record, reason) => this.emitOrchestrationCancelled(record, reason),
      emitAgentFailedEvent: (recordId, error, durationMs) => this.emitAgentFailedEvent(recordId, error, durationMs),
      emitOrchestrationFailed: (record, error) => this.emitOrchestrationFailed(record, error),
      emitAgentCompletedEvent: (recordId, durationMs, output, toolCallsMade, usage) =>
        this.emitAgentCompletedEvent(recordId, durationMs, output, toolCallsMade, usage),
      emitOrchestrationCompleted: (record, output) => this.emitOrchestrationCompleted(record, output),
      emitStreamDelta: (recordId, content, accumulated) => this.emitStreamDelta(recordId, content, accumulated),
      registerConversationSource: this.conversationSink
        ? (agentId, source) => this.conversationSink!.register(agentId, source)
        : undefined,
      releaseConversationSource: this.conversationSink
        ? (agentId) => this.conversationSink!.release(agentId)
        : undefined,
      getCancellationSignal: this.cancellationSource
        ? (agentId) => this.cancellationSource!.get(agentId)
        : undefined,
      processManager: this.toolDeps?.processManager,
      messageBus: this.messageBus,
      knowledgeService: this.toolDeps?.knowledgeService,
      memoryRegistry: this.toolDeps?.memoryRegistry,
      codeIndex: this.toolDeps?.codeIndex,
      isCodeInjectionSettingEnabled: this.toolDeps?.isCodeInjectionSettingEnabled,
      onToolExecuted: (this.toolDeps?.codeIndexReindexScheduler || this.toolDeps?.toolExecutionObserver)
        ? (toolName, args, success) => {
          this.toolDeps?.codeIndexReindexScheduler?.onToolExecuted(toolName, args, success);
          this.toolDeps?.toolExecutionObserver?.(toolName, args, success);
        }
        : undefined,
      archetypeLoader: this.toolDeps?.archetypeLoader,
      providerOptimizer: this.toolDeps?.providerOptimizer,
      providerRegistry: this.toolDeps!.providerRegistry!,
      ...(this.toolDeps?.permissionManager ? { permissionManager: this.toolDeps.permissionManager } : {}),
      getFullRegistry: () => this.getFullRegistry(cwd),
      buildScopedRegistry: (allowedNames, fullRegistry) => this.buildScopedRegistry(allowedNames, fullRegistry),
      resolveProviderForRecord: (providerRegistry, record, currentModel) =>
        this.resolveProviderForRecord(providerRegistry, record, currentModel),
      resolveFallbackModelRoutes: (providerRegistry, record, currentModel, primaryRequestedModelId) =>
        this.resolveFallbackModelRoutes(providerRegistry, record, currentModel, primaryRequestedModelId),
    };
  }

  /**
   * Run an agent task described by the given record. Honors
   * `record.workingDirectory` when set (see AgentInput.workingDirectory) —
   * every tool this run's registry exposes is bound to that cwd instead of
   * the orchestrator's default.
   */
  async runAgent(record: AgentRecord): Promise<void> {
    await runAgentTask(this.createRunContext(record.workingDirectory), record);
  }
}
