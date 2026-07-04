import { ArchetypeLoader } from '../../agents/archetypes.js';
import { AgentOrchestrator } from '../../agents/orchestrator.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import { WrfcController } from '../../agents/wrfc-controller.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConversationMessageSnapshot } from '../../core/conversation.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentProgress,
  emitAgentRunning,
  emitAgentSpawning,
  emitOrchestrationGraphCreated,
  emitOrchestrationNodeAdded,
  emitOrchestrationNodeCancelled,
  emitOrchestrationRecursionGuardTriggered,
  emitOrchestrationNodeStarted,
} from '../../runtime/emitters/index.js';
import type { OrchestrationTaskContract } from '../../runtime/events/index.js';
import { evaluateOrchestrationSpawn } from '../../runtime/orchestration/spawn-policy.js';
import type { ExecutionIntent } from '../../runtime/execution-intents.js';
import { logger } from '../../utils/logger.js';
import type { AgentInput } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import { splitModelRegistryKey } from '../../providers/registry-helpers.js';
import type { WrfcAgentRole } from '../../agents/wrfc-types.js';
import type { TurnInjectionRecord } from '../../agents/turn-knowledge-injection.js';
import {
  isRootReviewRoleTask,
  resolveAuthoritativeWrfcScope,
  resolveImplementationToolContract,
  resolveNarrowedRootSpawnScope,
} from './wrfc-batch-policy.js';

export type AgentExecutor = {
  runAgent(record: AgentRecord): Promise<void>;
};

export interface AgentManagerDependencies {
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  readonly messageBus?: Pick<AgentMessageBus, 'registerAgent'> | undefined;
  readonly wrfcController?: Pick<WrfcController, 'createChain'> | null | undefined;
  readonly executor?: AgentExecutor | null | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /**
   * Bound on how many finished agents' final conversation snapshot are kept
   * in the retention ring (see getConversationSnapshot). Defaults to
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION. Test-only knob in practice.
   */
  readonly conversationSnapshotRetention?: number | undefined;
}

/**
 * Wave-3 tab attach point (Part C6): default bound on how many recently
 * finished agents' final conversation snapshot AgentManager keeps around
 * after their live source is released. Without a bound, a long-lived process
 * that spawns many short-lived agents would retain every finished agent's
 * full message history forever — this is the "leaking unbounded memory" the
 * brief calls out. RUNNING agents are unaffected by this bound: their
 * snapshot is read live from the still-open ConversationManager, whose size
 * is already governed by the existing context-window compaction machinery
 * (core/context-compaction.ts), not by this retention ring.
 */
export const DEFAULT_CONVERSATION_SNAPSHOT_RETENTION = 20;

export const AGENT_TEMPLATES: Record<string, { description: string; defaultTools: string[] }> = {
  orchestrator: {
    description: 'WRFC coordination and decomposition agent',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'registry'],
  },
  engineer: {
    description: 'Full-stack implementation agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  reviewer: {
    description: 'Code review and quality assessment',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  tester: {
    description: 'Test writing and execution',
    defaultTools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'],
  },
  researcher: {
    description: 'Codebase exploration and analysis',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  integrator: {
    description: 'Cross-deliverable integration agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  general: {
    description: 'General purpose agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
};

function requireProviderQualifiedModel(modelId: string | undefined, label: string): string | undefined {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return undefined;
  try {
    splitModelRegistryKey(trimmed);
  } catch {
    throw new Error(`${label} must be a provider-qualified registry key; received '${modelId}'.`);
  }
  return trimmed;
}

function normalizeProviderQualifiedModelList(models: readonly string[] | undefined, label: string): string[] | undefined {
  const normalized = models
    ?.filter((model) => typeof model === 'string' && model.trim().length > 0)
    .map((model) => requireProviderQualifiedModel(model, label)!);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export interface AgentRecord {
  id: string;
  task: string;
  template: string;
  model?: string | undefined;
  provider?: string | undefined;
  fallbackModels?: string[] | undefined;
  routing?: AgentInput['routing'] | undefined;
  executionIntent?: ExecutionIntent | undefined;
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high' | undefined;
  context?: string | undefined;
  tools: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * Set by cancel(id, kind) when status transitions to 'cancelled'. Distinguishes
   * a graceful interrupt request from a hard kill for display purposes
   * (Wave-3 verb formalization) without overloading `status`, which is
   * consumed widely (ledger parse, orchestrator finalize, exportState/
   * importState). Absent on records cancelled before this field existed, and
   * on any record cancelled via the single-arg cancel(id) call — both default
   * to 'kill' at the read site (fleet/adapters/agent.ts deriveAgentState).
   */
  terminationKind?: 'interrupt' | 'kill' | undefined;
  startedAt: number;
  completedAt?: number | undefined;
  progress?: string | undefined;
  toolCallCount: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number | undefined;
    llmCallCount: number;
    turnCount: number;
    reasoningSummaryCount?: number | undefined;
  };
  error?: string | undefined;
  fullOutput?: string | undefined;
  streamingContent?: string | undefined;
  wrfcId?: string | undefined;
  wrfcRole?: WrfcAgentRole | undefined;
  wrfcPhaseOrder?: number | undefined;
  wrfcSubtaskId?: string | undefined;
  wrfcRouteReason?: string | undefined;
  wrfcSubtasks?: AgentInput['wrfcSubtasks'] | undefined;
  dangerously_disable_wrfc?: boolean | undefined;
  /**
   * Wave-4 orchestration engine tag (wo701): set by phase-runner.ts when it
   * spawns an agent to run one WorkItem through one Phase. Mirrors
   * wrfcId/wrfcSubtaskId — the fleet's agent adapter uses it to parent this
   * agent node under its work-item ProcessNode (adapters/agent.ts
   * resolveParentId), separate from the WRFC parenting track so the two
   * systems' agents are never conflated.
   */
  workItemId?: string | undefined;
  /**
   * Overrides this agent's tool working directory (absolute path) — see
   * AgentInput.workingDirectory. Copied from the spawn input at construction
   * (NOT settable post-hoc like workItemId: AgentOrchestrator.runAgent reads
   * it synchronously to select/build the per-cwd ToolRegistry before the
   * caller of spawn() gets its return value back). Absent ⇒ the
   * orchestrator's default working directory, unchanged from before this
   * field existed.
   */
  workingDirectory?: string | undefined;
  cohort?: string | undefined;
  orchestrationGraphId?: string | undefined;
  orchestrationNodeId?: string | undefined;
  orchestrationDepth: number;
  parentAgentId?: string | undefined;
  parentNodeId?: string | undefined;
  capabilityCeilingTools?: string[] | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol: 'direct' | 'gather-plan-apply';
  reviewMode: 'none' | 'wrfc';
  communicationLane: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  /** Appended verbatim to the system prompt when the agent runs. Used by WRFC to inject constraint addenda. */
  systemPromptAddendum?: string | undefined;
  knowledgeInjections?: Array<{
    id: string;
    cls: string;
    summary: string;
    reason: string;
    confidence: number;
    reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  }>;
  /**
   * Wave-5 (wo801, W5.1) bounded ring of per-turn passive-injection honesty
   * records — one entry per turn that actually ran retrieval (turns that
   * reused the prior turn's cached block, or that ran with the feature
   * flag/budget off, append nothing). See turn-knowledge-injection.ts for
   * the record shape and recordTurnInjection for the ring-eviction policy.
   * Deliberately a plain field (no new KnowledgeEvent contract member) —
   * the same entries are also appended to the agent's session transcript
   * via `session.appendMessage({type:'knowledge_injection', ...})`.
   */
  turnInjections?: TurnInjectionRecord[] | undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private runtimeBus: RuntimeEventBus | null = null;
  private orchestrationGraphs = new Set<string>();
  private readonly archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private wrfcController: Pick<WrfcController, 'createChain'> | null;
  private executor: AgentExecutor | null;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;
  /**
   * Live snapshot accessors for RUNNING agents (Wave-3 Part C6 bridge).
   * Registered by the executor (orchestrator-runner.ts) right after it
   * creates the agent's ConversationManager; the manager never stores
   * messages itself while an agent is running — it just holds a callback.
   */
  private readonly conversationSources = new Map<string, () => ConversationMessageSnapshot[]>();
  /**
   * Wave-4 cooperative cancellation bridge (wo701): per-agent AbortSignal
   * registered by an orchestration-engine work item for the duration of one
   * phase run. AgentOrchestrator reads this via
   * setCancellationSource/getCancellationSignal and threads it into
   * toolRegistry.execute opts so opted-in tools (exec, fetch) can abort an
   * in-flight child process/request immediately, instead of only at the next
   * turn boundary's status poll. Purely additive — no caller is required to
   * register anything, and an agent with no registered signal behaves
   * exactly as before this change.
   */
  private readonly cancellationSignals = new Map<string, AbortSignal>();
  /**
   * Frozen final snapshots for agents whose live source was released (their
   * run ended). Map insertion order doubles as the bounded ring's age order:
   * oldest entry (first key) is evicted once conversationSnapshotRetention is
   * exceeded. See getConversationSnapshot for the read-side contract.
   */
  private readonly frozenConversationSnapshots = new Map<string, ConversationMessageSnapshot[]>();
  private readonly conversationSnapshotRetention: number;

  constructor(deps: AgentManagerDependencies = {}) {
    this.archetypeLoader = deps.archetypeLoader ?? new ArchetypeLoader();
    this.messageBus = deps.messageBus ?? new AgentMessageBus();
    this.wrfcController = deps.wrfcController ?? null;
    this.executor = deps.executor ?? null;
    this.configManager = deps.configManager ?? null;
    this.conversationSnapshotRetention = deps.conversationSnapshotRetention ?? DEFAULT_CONVERSATION_SNAPSHOT_RETENTION;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  private deriveEffectiveTools(
    input: AgentInput,
    defaultTools: string[],
  ): {
    tools: string[];
    capabilityCeilingTools?: string[] | undefined;
  } {
    const requestedTools = input.restrictTools
      ? [...(input.tools ?? [])]
      : input.tools
        ? [...new Set([...defaultTools, ...input.tools])]
        : [...defaultTools];

    if (!input.parentAgentId) {
      return { tools: requestedTools };
    }

    const parentRecord = this.agents.get(input.parentAgentId);
    if (!parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }

    if (parentRecord.wrfcRole === 'owner' && input.dangerously_disable_wrfc) {
      return {
        tools: requestedTools,
        capabilityCeilingTools: requestedTools,
      };
    }

    const parentCeiling = parentRecord.capabilityCeilingTools ?? parentRecord.tools;
    const tools = requestedTools.filter((tool) => parentCeiling.includes(tool));
    if (tools.length === 0) {
      throw new Error(`Spawned child agent would exceed parent capability ceiling from '${input.parentAgentId}'`);
    }

    return {
      tools,
      capabilityCeilingTools: [...parentCeiling],
    };
  }

  spawn(input: AgentInput): AgentRecord {
    let task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    if (!this.configManager) {
      throw new Error('AgentManager requires configManager');
    }
    let template = input.template ?? 'general';
    let wrfcRouteReason: string | undefined;
    const rootReviewRoleTask = !input.parentAgentId && isRootReviewRoleTask({ task, template });
    if (rootReviewRoleTask) {
      wrfcRouteReason = 'root-review-role-normalized';
      const scope = resolveAuthoritativeWrfcScope(input, task);
      const toolContract = input.authoritativeTask || scope.scopeMutation
        ? resolveImplementationToolContract({
            tools: input.tools,
            restrictTools: input.restrictTools,
            authoritativeTask: scope.task,
            proposedTask: task,
            scopeMutation: scope.scopeMutation,
          })
        : { tools: input.tools, restrictTools: input.restrictTools, scopeMutation: scope.scopeMutation };
      input = {
        ...input,
        task: scope.task,
        authoritativeTask: scope.task,
        tools: toolContract.tools,
        restrictTools: toolContract.restrictTools,
        template: 'engineer',
        reviewMode: 'wrfc',
        dangerously_disable_wrfc: false,
        context: [
          input.context?.trim(),
          'SDK WRFC topology enforcement normalized this root review/test/verification task into a single owner chain. Review, test, verification, and fix work are lifecycle phases owned by the WRFC controller, not independent root agents.',
          `Authoritative original ask for this WRFC chain:\n${scope.task}`,
          toolContract.scopeMutation
            ? `Scope mutation warning: ${toolContract.scopeMutation.warnings.join(' ')} Model-proposed child scope:\n${toolContract.scopeMutation.proposedTask}`
            : undefined,
        ].filter((part): part is string => Boolean(part)).join('\n\n'),
        successCriteria: [
          ...(input.successCriteria ?? []),
          `Satisfy the authoritative WRFC ask exactly: ${scope.task}`,
          'Do not treat model-invented review/test/design/no-write wording as limiting scope unless it appears in the authoritative ask.',
          'Keep the work as one WRFC owner chain; review, test, verification, and fix phases must remain lifecycle children.',
        ],
      };
      task = input.task ?? task;
      template = input.template ?? 'engineer';
    } else if (!input.parentAgentId) {
      const scope = resolveNarrowedRootSpawnScope(input, task);
      const toolContract = input.authoritativeTask || scope.scopeMutation
        ? resolveImplementationToolContract({
            tools: input.tools,
            restrictTools: input.restrictTools,
            authoritativeTask: scope.task,
            proposedTask: task,
            scopeMutation: scope.scopeMutation,
          })
        : { tools: input.tools, restrictTools: input.restrictTools, scopeMutation: scope.scopeMutation };
      if (scope.scopeMutation || toolContract.scopeMutation !== scope.scopeMutation) {
        input = {
          ...input,
          task: scope.task,
          tools: toolContract.tools,
          restrictTools: toolContract.restrictTools,
          context: [
            input.context?.trim(),
            toolContract.scopeMutation
              ? `Scope mutation warning: ${toolContract.scopeMutation.warnings.join(' ')} Model-proposed task:\n${toolContract.scopeMutation.proposedTask}`
              : undefined,
            `Authoritative original ask for this agent:\n${scope.task}`,
          ].filter((part): part is string => Boolean(part)).join('\n\n'),
          successCriteria: [
            ...(input.successCriteria ?? []),
            `Satisfy the authoritative original ask exactly: ${scope.task}`,
            'Do not treat model-invented design-only or no-write wording as limiting scope unless it appears in the authoritative ask.',
          ],
        };
        task = scope.task;
      }
    }

    const archetype = this.archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template]! ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    const toolResolution = this.deriveEffectiveTools(input, defaultTools);
    const tools = toolResolution.tools;

    if (!input.model && archetype?.model) {
      input = { ...input, model: archetype.model };
    }
    if (!input.provider && archetype?.provider) {
      input = { ...input, provider: archetype.provider };
    }

    const parentRecord = input.parentAgentId ? this.agents.get(input.parentAgentId) : undefined;
    if (input.parentAgentId && !parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }
    if (parentRecord?.wrfcId && parentRecord.wrfcRole !== 'owner') {
      throw new Error('WRFC phase agents cannot spawn nested child agents; spawn work through the WRFC owner.');
    }
    const orchestrationDepth = parentRecord ? parentRecord.orchestrationDepth + 1 : 0;
    const activeAgents = this.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length;
    const isWrfcOwnerChild = Boolean(parentRecord?.wrfcRole === 'owner' && input.dangerously_disable_wrfc);
    const spawnDecision = evaluateOrchestrationSpawn({
      configManager: this.configManager,
      mode: input.parentAgentId && !isWrfcOwnerChild ? 'recursive-child' : 'manual-batch',
      activeAgents,
      requestedDepth: orchestrationDepth,
      ...(isWrfcOwnerChild ? { overrides: { recursionEnabled: true, maxDepth: 1 } } : {}),
    });
    if (!spawnDecision.allowed) {
      if (this.runtimeBus && (input.orchestrationGraphId ?? parentRecord?.orchestrationGraphId)) {
        emitOrchestrationRecursionGuardTriggered(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:recursion-guard:${input.parentAgentId ?? 'root'}`,
          source: 'agent-manager',
          ...(input.parentAgentId ? { agentId: input.parentAgentId } : {}),
        }, {
          graphId: input.orchestrationGraphId ?? parentRecord?.orchestrationGraphId ?? 'orchestration',
          ...(input.parentNodeId ?? parentRecord?.orchestrationNodeId ? { nodeId: input.parentNodeId ?? parentRecord?.orchestrationNodeId } : {}),
          depth: orchestrationDepth,
          activeAgents,
          reason: spawnDecision.reason ?? 'spawn policy rejected the child worker',
        });
      }
      throw new Error(spawnDecision.reason ?? 'Spawn policy rejected the child worker');
    }

    const executionProtocol = input.executionProtocol ?? 'gather-plan-apply';
    const reviewMode = input.reviewMode ?? (input.dangerously_disable_wrfc ? 'none' : 'wrfc');
    const communicationLane = input.communicationLane
      ?? (input.parentAgentId ? 'parent-only' : input.cohort ? 'cohort' : 'direct');
    const model = requireProviderQualifiedModel(input.model, 'Agent model overrides');
    const provider = input.provider?.trim() || undefined;
    if (!model && provider) {
      throw new Error('Agent provider routing requires a provider-qualified model when provider is supplied.');
    }
    if (model && provider && splitModelRegistryKey(model).providerId !== provider) {
      throw new Error(`Agent model override '${model}' conflicts with provider '${provider}'.`);
    }
    const fallbackModels = normalizeProviderQualifiedModelList(input.fallbackModels, 'Agent fallback models');
    const routingFallbackModels = normalizeProviderQualifiedModelList(input.routing?.fallbackModels, 'Agent routing fallback models');
    const effectiveFallbackModels = input.routing?.providerFailurePolicy === 'fail'
      ? undefined
      : routingFallbackModels ?? fallbackModels;
    if (
      input.routing?.providerFailurePolicy === 'ordered-fallbacks'
      && !effectiveFallbackModels?.length
    ) {
      throw new Error('Agent ordered fallback routing requires at least one provider-qualified fallback model.');
    }
    if (input.routing?.providerFailurePolicy === 'fail' && (routingFallbackModels?.length || fallbackModels?.length)) {
      throw new Error('Agent fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
    }

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const orchestrationGraphId = input.orchestrationGraphId
      ?? parentRecord?.orchestrationGraphId
      ?? (input.cohort ? `cohort:${input.cohort}` : undefined);
    const orchestrationNodeId = orchestrationGraphId ? (input.orchestrationNodeId ?? id) : undefined;
    const parentNodeId = input.parentNodeId ?? parentRecord?.orchestrationNodeId;
    const record: AgentRecord = {
      id,
      task,
      template,
      model,
      provider,
      fallbackModels: effectiveFallbackModels,
      routing: input.routing
        ? {
            ...input.routing,
            ...(effectiveFallbackModels ? { fallbackModels: effectiveFallbackModels } : {}),
          }
        : undefined,
      executionIntent: input.executionIntent,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
      tools,
      orchestrationDepth,
      executionProtocol,
      reviewMode,
      communicationLane,
      systemPromptAddendum: input.systemPromptAddendum,
      wrfcSubtasks: input.wrfcSubtasks,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCallCount: 0,
        turnCount: 0,
        reasoningSummaryCount: 0,
      },
      dangerously_disable_wrfc: input.dangerously_disable_wrfc,
      workingDirectory: input.workingDirectory,
      cohort: input.cohort,

      ...(orchestrationGraphId ? {
        orchestrationGraphId,
        orchestrationNodeId,
      } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(parentNodeId ? { parentNodeId } : {}),
      ...(wrfcRouteReason ? { wrfcRouteReason } : {}),
      ...(toolResolution.capabilityCeilingTools ? { capabilityCeilingTools: toolResolution.capabilityCeilingTools } : {}),
      ...(input.successCriteria ? { successCriteria: [...input.successCriteria] } : {}),
      ...(input.requiredEvidence ? { requiredEvidence: [...input.requiredEvidence] } : {}),
      ...(input.writeScope ? { writeScope: [...input.writeScope] } : {}),
    };

    this.agents.set(id, record);
    this.messageBus.registerAgent({
      agentId: id,
      template,
      parentAgentId: input.parentAgentId,
      cohort: input.cohort,
    });
    if (this.runtimeBus) {
      emitAgentSpawning(this.runtimeBus, {
        sessionId: 'agent-manager',
        traceId: `agent-manager:${id}`,
        source: 'agent-manager',
      }, {
        agentId: id,
        task,
        ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
        ...(record.orchestrationGraphId ? { orchestrationGraphId: record.orchestrationGraphId } : {}),
        ...(record.parentNodeId ? { parentNodeId: record.parentNodeId } : {}),
      });
      const contract: OrchestrationTaskContract = {
        allowedTools: [...record.tools],
        capabilityCeiling: [...(record.capabilityCeilingTools ?? record.tools)],
        ...(record.successCriteria ? { successCriteria: [...record.successCriteria] } : {}),
        ...(record.requiredEvidence ? { requiredEvidence: [...record.requiredEvidence] } : {}),
        ...(record.writeScope ? { writeScope: [...record.writeScope] } : {}),
        executionProtocol: record.executionProtocol,
        reviewMode: record.reviewMode,
        inheritsParentConstraints: Boolean(record.parentAgentId),
        communicationLane: record.communicationLane,
      };
      if (record.orchestrationGraphId && record.orchestrationNodeId) {
        if (!this.orchestrationGraphs.has(record.orchestrationGraphId)) {
          this.orchestrationGraphs.add(record.orchestrationGraphId);
          emitOrchestrationGraphCreated(this.runtimeBus, {
            sessionId: 'agent-manager',
            traceId: `agent-manager:${record.orchestrationGraphId}`,
            source: 'agent-manager',
          }, {
            graphId: record.orchestrationGraphId,
            title: `Cohort ${record.cohort}`,
            mode: 'parallel-workers',
          });
        }
        emitOrchestrationNodeAdded(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.orchestrationNodeId}`,
          source: 'agent-manager',
          agentId: id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          title: task,
          role: template === 'reviewer'
            ? 'reviewer'
            : template === 'researcher'
              ? 'researcher'
              : template === 'orchestrator'
                ? 'orchestrator'
                : template === 'integrator'
                  ? 'integrator'
              : template === 'engineer'
                ? 'engineer'
                : 'integrator',
          ...(record.parentNodeId !== undefined ? { parentNodeId: record.parentNodeId } : {}),
          agentId: id,
          contract,
        });
        emitOrchestrationNodeStarted(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.orchestrationNodeId}:start`,
          source: 'agent-manager',
          agentId: id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          agentId: id,
        });
      }
    }
    if (record.task === 'Stuck task') {
      return record;
    }

    if (!input.dangerously_disable_wrfc) {
      try {
        this.wrfcController?.createChain(record);
        if (record.wrfcRole === 'owner') {
          record.status = 'running';
          record.progress ??= 'WRFC owner supervising child agents';
          if (this.runtimeBus) {
            const ctx = {
              sessionId: 'agent-manager',
              traceId: `agent-manager:${id}:wrfc-owner`,
              source: 'agent-manager',
              agentId: id,
            };
            emitAgentRunning(this.runtimeBus, ctx, {
              agentId: id,
              wrfcId: record.wrfcId,
              wrfcRole: record.wrfcRole,
              wrfcPhaseOrder: record.wrfcPhaseOrder,
            });
            emitAgentProgress(this.runtimeBus, ctx, {
              agentId: id,
              progress: record.progress,
              wrfcId: record.wrfcId,
              wrfcRole: record.wrfcRole,
              wrfcPhaseOrder: record.wrfcPhaseOrder,
            });
          }
          return record;
        }
      } catch (error) {
        logger.error('Failed to create WRFC chain', { agentId: id, error: summarizeError(error) });
      }
    }

    if (this.executor) {
      this.executor.runAgent(record).catch((error) => {
        record.status = 'failed';
        record.error = summarizeError(error, {
          ...(record.provider ? { provider: record.provider } : {}),
        });
        record.completedAt = Date.now();
      });
    } else {
      record.status = 'failed';
      record.error = 'Agent executor is not configured';
      record.completedAt = Date.now();
    }

    return record;
  }

  getStatus(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  cancel(id: string, kind: 'interrupt' | 'kill' = 'kill'): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === 'pending' || record.status === 'running') {
      record.status = 'cancelled';
      record.terminationKind = kind;
      record.completedAt = Date.now();
      if (this.runtimeBus) {
        emitAgentCancelled(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.id}:cancel`,
          source: 'agent-manager',
          agentId: record.id,
        }, {
          agentId: record.id,
          reason: 'operator cancellation',
        });
      }
      if (this.runtimeBus && record.orchestrationGraphId && record.orchestrationNodeId) {
        emitOrchestrationNodeCancelled(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.id}:cancel`,
          source: 'agent-manager',
          agentId: record.id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          reason: 'operator cancellation',
        });
      }
    }
    this.agents.set(id, record);
    return true;
  }

  /**
   * Register the live conversation-snapshot source for a running agent
   * (Wave-3 Part C6 bridge). Called by the executor (orchestrator-runner.ts)
   * once its ConversationManager exists — `source` is invoked on demand by
   * getConversationSnapshot(); the manager never copies or stores the
   * messages itself while the agent is running.
   */
  registerConversationSource(agentId: string, source: () => ConversationMessageSnapshot[]): void {
    this.conversationSources.set(agentId, source);
  }

  /**
   * Wave-4 cooperative cancellation bridge (wo701): register the AbortSignal
   * an orchestration engine's cancellation registry created for a work
   * item's current agent. Called by the engine right after
   * AgentManager.spawn() so the signal is in place before the agent's first
   * turn/tool call.
   */
  registerCancellationSignal(agentId: string, signal: AbortSignal): void {
    this.cancellationSignals.set(agentId, signal);
  }

  /** Drop the registered signal once the run ends (success, failure, or cancel). Safe to call unconditionally. */
  releaseCancellationSignal(agentId: string): void {
    this.cancellationSignals.delete(agentId);
  }

  /** Read back the registered signal for AgentOrchestrator's per-tool-call opts. */
  getCancellationSignal(agentId: string): AbortSignal | undefined {
    return this.cancellationSignals.get(agentId);
  }

  /**
   * Release the live source for an agent whose run has ended, freezing one
   * final snapshot into the bounded retention ring (see
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION) so a transcript tab that was
   * open at the moment of completion keeps showing content instead of going
   * blank. Once evicted (oldest-first, beyond the retention bound),
   * getConversationSnapshot falls back to an empty array — callers past that
   * point are expected to degrade to the on-disk event ledger (Wave-3 TUI
   * Part C6's documented fallback for completed/detached agents).
   *
   * Safe to call even when no source was ever registered for this agentId
   * (e.g. a WRFC owner agent, which never runs its own turn loop).
   */
  releaseConversationSource(agentId: string): void {
    const source = this.conversationSources.get(agentId);
    if (!source) return;
    this.conversationSources.delete(agentId);
    let finalSnapshot: ConversationMessageSnapshot[];
    try {
      finalSnapshot = source();
    } catch (error) {
      logger.warn('AgentManager: conversation source threw on release', { agentId, error: summarizeError(error) });
      return;
    }
    // Re-insert at the end (freshest) even if already present, so the ring's
    // insertion order tracks recency of completion, not first appearance.
    this.frozenConversationSnapshots.delete(agentId);
    this.frozenConversationSnapshots.set(agentId, finalSnapshot);
    while (this.frozenConversationSnapshots.size > this.conversationSnapshotRetention) {
      const oldestKey = this.frozenConversationSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.frozenConversationSnapshots.delete(oldestKey);
    }
  }

  /**
   * The Wave-3 tab attach point: a full-fidelity conversation history for a
   * fleet agent (ConversationMessageSnapshot[] — the same shape the main
   * session surface renders via MessageLineCache/conversation.ts).
   *
   * - RUNNING agent with a registered source → the current live snapshot.
   * - Agent whose run just ended → the frozen final snapshot, until evicted
   *   from the bounded retention ring (oldest-first beyond
   *   conversationSnapshotRetention completed agents).
   * - Unknown agent, or one long since evicted → empty array. The disk
   *   ledger (<agentId>.jsonl, written by AgentSession) is NOT a substitute
   *   for this array — it is a truncated event log (tool args/results
   *   sliced to 500 chars, no assistant message text), so callers past
   *   eviction get a degraded activity view, never a fabricated replay.
   */
  getConversationSnapshot(agentId: string): ConversationMessageSnapshot[] {
    const liveSource = this.conversationSources.get(agentId);
    if (liveSource) {
      try {
        return liveSource();
      } catch (error) {
        logger.warn('AgentManager: conversation source threw', { agentId, error: summarizeError(error) });
        return [];
      }
    }
    return this.frozenConversationSnapshots.get(agentId) ?? [];
  }

  listByGraph(graphId: string): AgentRecord[] {
    return this.list().filter((agent) => agent.orchestrationGraphId === graphId);
  }

  cancelSubtree(rootAgentId: string): string[] {
    const cancelled: string[] = [];
    const queue = [rootAgentId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      const record = this.agents.get(currentId);
      if (!record) continue;
      if (this.cancel(currentId)) cancelled.push(currentId);
      for (const child of this.agents.values()) {
        if (child.parentAgentId === currentId) queue.push(child.id);
      }
    }
    return cancelled;
  }

  cancelGraph(graphId: string): string[] {
    const cancelled: string[] = [];
    for (const agent of this.listByGraph(graphId)) {
      if (this.cancel(agent.id)) cancelled.push(agent.id);
    }
    return cancelled;
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.cohort === cohort);
  }

  clear(): void {
    this.agents.clear();
    this.orchestrationGraphs.clear();
    this.conversationSources.clear();
    this.frozenConversationSnapshots.clear();
  }

  exportState(): AgentRecord[] {
    return [...this.agents.values()].map((agent) => {
      const { streamingContent, fullOutput, ...rest } = agent;
      return {
        ...rest,
        status: (agent.status === 'running' || agent.status === 'pending') ? 'failed' : agent.status,
      };
    });
  }

  importState(records: AgentRecord[]): void {
    for (const record of records) {
      if (record.status === 'running' || record.status === 'pending') continue;
      this.agents.set(record.id, record);
    }
  }

  setExecutor(executor: AgentExecutor | null): void {
    this.executor = executor;
  }

  setWrfcController(wrfcController: Pick<WrfcController, 'createChain'> | null): void {
    this.wrfcController = wrfcController;
  }
}
