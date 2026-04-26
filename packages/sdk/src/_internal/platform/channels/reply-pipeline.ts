import type { RuntimeEventBus, RuntimeEventEnvelope, AnyRuntimeEvent, WorkflowEvent } from '../runtime/events/index.js';
import type {
  ChannelRenderEvent,
  ChannelRenderPhase,
  ChannelRenderPolicy,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelReasoningVisibility,
  ChannelSurface,
} from './types.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { RouteBindingManager } from './route-manager.js';

const MAX_BUFFERED_EVENTS = 64;
const DEFAULT_PROGRESS_INTERVAL_MS = 7_500;

export interface TrackedChannelReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly agentTask?: string;
  readonly workflowChainId?: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly [key: string]: unknown;
}

interface ReplyPipelineDeps {
  readonly channelPlugins: ChannelPluginRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly now?: () => number;
}

interface ReplyBufferState {
  readonly pending: TrackedChannelReply;
  readonly events: ChannelRenderEvent[];
  lastDeliveredText?: string;
  lastDeliveredAt?: number;
}

const DEFAULT_POLICY: Record<ChannelSurface, ChannelRenderPolicy> = {
  tui: {
    surface: 'tui',
    reasoningVisibility: 'public',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  web: {
    surface: 'web',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  slack: {
    surface: 'slack',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  discord: {
    surface: 'discord',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  ntfy: {
    surface: 'ntfy',
    reasoningVisibility: 'suppress',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 1_600,
    maxEventsPerUpdate: 6,
    metadata: {},
  },
  webhook: {
    surface: 'webhook',
    reasoningVisibility: 'private',
    format: 'json',
    supportsThreads: false,
    maxChunkChars: 12_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  homeassistant: {
    surface: 'homeassistant',
    reasoningVisibility: 'summary',
    format: 'json',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 16,
    metadata: {},
  },
  telegram: {
    surface: 'telegram',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  'google-chat': {
    surface: 'google-chat',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  signal: {
    surface: 'signal',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  whatsapp: {
    surface: 'whatsapp',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  imessage: {
    surface: 'imessage',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  msteams: {
    surface: 'msteams',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  bluebubbles: {
    surface: 'bluebubbles',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  mattermost: {
    surface: 'mattermost',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  matrix: {
    surface: 'matrix',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
};

function trimText(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function baseMetadata(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    runtimeType: envelope.type,
    traceId: envelope.traceId,
    source: envelope.source,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
  };
}

function eventLine(event: ChannelRenderEvent, reasoningVisibility: ChannelReasoningVisibility): string | null {
  switch (event.kind) {
    case 'assistant_text':
      return event.text?.trim() ? event.text.trim() : null;
    case 'reasoning':
      if (reasoningVisibility === 'suppress') return null;
      if (!event.text?.trim()) return null;
      return reasoningVisibility === 'summary'
        ? `Reasoning: ${trimText(event.text, 220)}`
        : `Reasoning: ${event.text.trim()}`;
    case 'tool_start':
      return event.toolName ? `Tool started: ${event.toolName}` : event.text ?? null;
    case 'tool_result':
      return event.toolName
        ? `${event.text?.startsWith('Failed') ? 'Tool failed' : 'Tool finished'}: ${event.toolName}${event.summary ? ` (${event.summary})` : ''}`
        : event.text ?? null;
    case 'plan':
      return event.text ? `Plan: ${event.text}` : null;
    case 'approval':
      return event.text ? `Approval: ${event.text}` : null;
    case 'command_output':
      return event.text ? `Command output: ${event.text}` : null;
    case 'patch':
      return event.text ? `Patch: ${event.text}` : null;
    case 'compaction':
      return event.text ? `Compaction: ${event.text}` : null;
    case 'model':
      return event.provider || event.model
        ? `Model: ${[event.provider, event.model].filter(Boolean).join(' / ')}`
        : event.text ?? null;
    case 'status':
      return event.text ?? null;
    case 'error':
      return event.text ? `Error: ${event.text}` : null;
  }
}

function buildRenderedText(
  explicitText: string,
  events: readonly ChannelRenderEvent[],
  policy: ChannelRenderPolicy,
  phase: ChannelRenderPhase,
): string {
  if (phase === 'final' && explicitText.trim().length > 0) {
    return trimText(explicitText, policy.maxChunkChars);
  }
  const renderableEvents = policy.surface === 'ntfy'
    ? events.filter((event) => event.kind !== 'assistant_text' && event.kind !== 'reasoning')
    : events;
  const lines = renderableEvents
    .slice(-policy.maxEventsPerUpdate)
    .map((event) => eventLine(event, policy.reasoningVisibility))
    .filter((line): line is string => Boolean(line && line.trim().length > 0));
  const deduped = lines.filter((line, index) => lines.indexOf(line) === index);
  return trimText(deduped.join('\n'), policy.maxChunkChars);
}

function renderEvent(
  kind: ChannelRenderEvent['kind'],
  phase: ChannelRenderPhase,
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  extras: Partial<ChannelRenderEvent> = {},
): ChannelRenderEvent {
  return {
    id: `${envelope.traceId}:${kind}:${envelope.ts}`,
    kind,
    phase,
    ts: envelope.ts,
    metadata: baseMetadata(envelope),
    ...extras,
  };
}

function resolveEnvelopeAgentId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  if (envelope.agentId) return envelope.agentId;
  const payload = envelope.payload as { readonly agentId?: unknown };
  return typeof payload.agentId === 'string' ? payload.agentId : null;
}

function isWorkflowEventPayload(payload: AnyRuntimeEvent): payload is WorkflowEvent {
  return payload.type.startsWith('WORKFLOW_');
}

function resolveEnvelopeWorkflowChainId(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): string | null {
  const payload = envelope.payload as { readonly chainId?: unknown };
  return typeof payload.chainId === 'string' && payload.chainId.length > 0 ? payload.chainId : null;
}

function isAgentFinalEvent(type: AnyRuntimeEvent['type']): boolean {
  return type === 'AGENT_COMPLETED' || type === 'AGENT_FAILED' || type === 'AGENT_CANCELLED';
}

export function normalizeChannelRenderEventFromRuntime(
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
): ChannelRenderEvent[] {
  const payload = envelope.payload;
  switch (payload.type) {
    case 'AGENT_STREAM_DELTA':
      return payload.content.trim().length > 0
        ? [renderEvent('assistant_text', 'progress', envelope, { text: payload.content })]
        : [];
    case 'AGENT_PROGRESS':
      return payload.progress.trim().length > 0
        ? [renderEvent('status', 'progress', envelope, { text: payload.progress })]
        : [];
    case 'AGENT_COMPLETED':
      return [
        ...(payload.output?.trim()
          ? [renderEvent('assistant_text', 'final', envelope, { text: payload.output })]
          : []),
        renderEvent('status', 'final', envelope, { text: `Agent completed in ${payload.durationMs}ms` }),
      ];
    case 'AGENT_FAILED':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    case 'AGENT_CANCELLED':
      return [renderEvent('status', 'final', envelope, { text: payload.reason ? `Cancelled: ${payload.reason}` : 'Cancelled' })];
    case 'STREAM_DELTA': {
      const events: ChannelRenderEvent[] = [];
      if (payload.content.trim().length > 0) {
        events.push(renderEvent('assistant_text', 'progress', envelope, { text: payload.content }));
      }
      if (payload.reasoning?.trim()) {
        events.push(renderEvent('reasoning', 'progress', envelope, { text: payload.reasoning }));
      }
      return events;
    }
    case 'TOOL_EXECUTING':
      return [renderEvent('tool_start', 'progress', envelope, { toolName: payload.tool, text: payload.tool })];
    case 'TOOL_SUCCEEDED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Succeeded',
        summary: `${payload.durationMs}ms`,
      })];
    case 'TOOL_FAILED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Failed',
        summary: payload.error,
      })];
    case 'PLAN_STRATEGY_SELECTED':
      return [renderEvent('plan', 'progress', envelope, {
        text: `Selected ${payload.selected} (${payload.reasonCode})${payload.inputs.taskDescription ? ` for ${payload.inputs.taskDescription}` : ''}`,
      })];
    case 'PLAN_STRATEGY_OVERRIDDEN':
      return [renderEvent('plan', 'progress', envelope, {
        text: payload.strategy ? `Overridden to ${payload.strategy}` : 'Planner override cleared',
      })];
    case 'PERMISSION_REQUESTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: payload.summary ?? `Permission requested for ${payload.tool}`,
      })];
    case 'DECISION_EMITTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: `${payload.approved ? 'Approved' : 'Denied'} ${payload.tool}`,
      })];
    case 'MODEL_FALLBACK':
      return [renderEvent('model', 'progress', envelope, {
        provider: payload.provider,
        model: `${payload.from} -> ${payload.to}`,
      })];
    case 'COMPACTION_CHECK':
    case 'COMPACTION_MICROCOMPACT':
    case 'COMPACTION_COLLAPSE':
    case 'COMPACTION_AUTOCOMPACT':
    case 'COMPACTION_REACTIVE':
    case 'COMPACTION_DONE':
    case 'COMPACTION_FAILED':
    case 'COMPACTION_RESUME_REPAIR':
    case 'COMPACTION_QUALITY_SCORE':
    case 'COMPACTION_STRATEGY_SWITCH':
      return [renderEvent(payload.type === 'COMPACTION_FAILED' ? 'error' : 'compaction', 'progress', envelope, {
        text: payload.type.replace(/^COMPACTION_/, '').toLowerCase().replace(/_/g, ' '),
      })];
    case 'WORKFLOW_CHAIN_CREATED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} started: ${trimText(payload.task, 180)}`,
      })];
    case 'WORKFLOW_STATE_CHANGED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} moved from ${payload.from} to ${payload.to}`,
      })];
    case 'WORKFLOW_REVIEW_COMPLETED': {
      const constraintSummary = typeof payload.constraintsSatisfied === 'number' && typeof payload.constraintsTotal === 'number'
        ? `, constraints ${payload.constraintsSatisfied}/${payload.constraintsTotal}`
        : '';
      return [renderEvent(payload.passed ? 'status' : 'error', 'progress', envelope, {
        text: `WRFC review ${payload.passed ? 'passed' : 'needs fixes'}: score ${payload.score}/10${constraintSummary}`,
      })];
    }
    case 'WORKFLOW_FIX_ATTEMPTED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC fix attempt ${payload.attempt}/${payload.maxAttempts} started`,
      })];
    case 'WORKFLOW_GATE_RESULT':
      return [renderEvent(payload.passed ? 'status' : 'error', 'progress', envelope, {
        text: `WRFC gate ${payload.gate} ${payload.passed ? 'passed' : 'failed'}`,
      })];
    case 'WORKFLOW_AUTO_COMMITTED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC changes committed${payload.commitHash ? `: ${payload.commitHash}` : ''}`,
      })];
    case 'WORKFLOW_CASCADE_ABORTED':
      return [renderEvent('error', 'progress', envelope, {
        text: `WRFC cascade warning: ${payload.reason}`,
      })];
    case 'WORKFLOW_CONSTRAINTS_ENUMERATED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC constraints enumerated: ${payload.constraints.length}`,
      })];
    case 'WORKFLOW_CHAIN_PASSED':
      return [renderEvent('status', 'final', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} passed`,
      })];
    case 'WORKFLOW_CHAIN_FAILED':
      return [renderEvent('error', 'final', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} failed: ${payload.reason}`,
      })];
    case 'TURN_COMPLETED':
      return payload.response.trim().length > 0
        ? [renderEvent('assistant_text', 'final', envelope, { text: payload.response })]
        : [];
    case 'TURN_ERROR':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    default:
      return [];
  }
}

export class ChannelReplyPipeline {
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly routeBindings: RouteBindingManager;
  private readonly now: () => number;
  private readonly buffers = new Map<string, ReplyBufferState>();
  private readonly workflowChains = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: ReplyPipelineDeps) {
    this.channelPlugins = deps.channelPlugins;
    this.routeBindings = deps.routeBindings;
    this.now = deps.now ?? (() => Date.now());
    this.attachRuntimeBus(deps.runtimeBus ?? null);
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.disposeSubscriptions();
    if (!runtimeBus) return;
    const domains: Array<Parameters<RuntimeEventBus['onDomain']>[0]> = [
      'agents',
      'turn',
      'tools',
      'planner',
      'permissions',
      'providers',
      'compaction',
      'workflows',
    ];
    for (const domain of domains) {
      this.unsubscribers.push(runtimeBus.onDomain(domain, (envelope) => {
        void this.handleEnvelope(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }));
    }
  }

  dispose(): void {
    this.disposeSubscriptions();
    this.buffers.clear();
    this.workflowChains.clear();
  }

  trackPending(pending: TrackedChannelReply): void {
    this.buffers.set(pending.agentId, {
      pending,
      events: [],
    });
    if (typeof pending.workflowChainId === 'string' && pending.workflowChainId.length > 0) {
      this.workflowChains.set(pending.workflowChainId, pending.agentId);
    }
  }

  untrack(agentId: string): void {
    this.buffers.delete(agentId);
    for (const [chainId, mappedAgentId] of this.workflowChains.entries()) {
      if (mappedAgentId === agentId) {
        this.workflowChains.delete(chainId);
      }
    }
  }

  has(agentId: string): boolean {
    return this.buffers.has(agentId);
  }

  getPending(agentId: string): TrackedChannelReply | null {
    return this.buffers.get(agentId)?.pending ?? null;
  }

  async deliverProgress(agentId: string, explicitText?: string, force = false): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const text = buildRenderedText(policy.surface === 'ntfy' ? '' : explicitText ?? '', state.events, policy, 'progress');
    if (!text) return null;
    if (!force && state.lastDeliveredText === text && (this.now() - (state.lastDeliveredAt ?? 0)) < DEFAULT_PROGRESS_INTERVAL_MS) {
      return null;
    }
    const result = await this.dispatch(state, policy, 'progress', text, state.events.slice(-policy.maxEventsPerUpdate));
    state.lastDeliveredText = text;
    state.lastDeliveredAt = this.now();
    return result;
  }

  async deliverFinal(
    agentId: string,
    explicitText: string,
    options: { readonly keepTracking?: boolean } = {},
  ): Promise<ChannelRenderResult | null> {
    const state = this.buffers.get(agentId);
    if (!state) return null;
    const policy = await this.resolvePolicy(state.pending.surfaceKind);
    const finalEvents = state.events.filter((event) => event.phase === 'final');
    const statusEvent: ChannelRenderEvent = {
      id: `final:${agentId}:${this.now()}`,
      kind: 'status',
      phase: 'final',
      ts: this.now(),
      text: 'Completed',
      metadata: {},
    };
    const result = await this.dispatch(
      state,
      policy,
      'final',
      buildRenderedText(explicitText, finalEvents.length > 0 ? finalEvents : [...state.events, statusEvent], policy, 'final'),
      finalEvents.length > 0 ? finalEvents : [...state.events.slice(-policy.maxEventsPerUpdate + 1), statusEvent],
    );
    if (!options.keepTracking) {
      this.untrack(agentId);
    }
    return result;
  }

  private async handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): Promise<void> {
    if (isWorkflowEventPayload(envelope.payload)) {
      await this.handleWorkflowEnvelope(envelope as RuntimeEventEnvelope<WorkflowEvent['type'], WorkflowEvent>);
      return;
    }
    if (
      envelope.payload.type === 'AGENT_SPAWNING'
      && typeof envelope.payload.parentAgentId === 'string'
      && envelope.payload.parentAgentId.length > 0
    ) {
      this.trackChildPendingReply(
        envelope.payload.agentId,
        envelope.payload.parentAgentId,
        envelope.payload.task,
      );
    }
    const agentId = resolveEnvelopeAgentId(envelope);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) return;
    const events = normalizeChannelRenderEventFromRuntime(envelope);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      const finalKinds = state.pending.surfaceKind === 'ntfy'
        ? new Set<ChannelRenderEvent['kind']>(['error', 'status'])
        : new Set<ChannelRenderEvent['kind']>(['assistant_text', 'error', 'status']);
      const text = events
        .filter((event) => finalKinds.has(event.kind))
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text, {
        keepTracking: state.pending.surfaceKind === 'ntfy'
          && typeof state.pending.workflowChainId === 'string'
          && isAgentFinalEvent(envelope.payload.type),
      });
      return;
    }
    await this.deliverProgress(agentId);
  }

  private async handleWorkflowEnvelope(
    envelope: RuntimeEventEnvelope<WorkflowEvent['type'], WorkflowEvent>,
  ): Promise<void> {
    if (envelope.payload.type === 'WORKFLOW_CHAIN_CREATED') {
      const matched = this.findPendingForWorkflowTask(envelope.payload.task);
      if (matched) {
        this.associateWorkflowChain(matched.pending.agentId, envelope.payload.chainId);
      }
    }
    const chainId = resolveEnvelopeWorkflowChainId(envelope);
    if (!chainId) return;
    const agentId = this.workflowChains.get(chainId);
    if (!agentId) return;
    const state = this.buffers.get(agentId);
    if (!state) {
      this.workflowChains.delete(chainId);
      return;
    }
    const events = normalizeChannelRenderEventFromRuntime(envelope);
    if (events.length === 0) return;
    state.events.push(...events);
    if (state.events.length > MAX_BUFFERED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFERED_EVENTS);
    }
    const hasFinal = events.some((event) => event.phase === 'final');
    if (hasFinal) {
      const text = events
        .filter((event) => event.kind === 'error' || event.kind === 'status')
        .map((event) => event.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      await this.deliverFinal(agentId, text);
      return;
    }
    await this.deliverProgress(agentId, undefined, true);
  }

  private trackChildPendingReply(agentId: string, parentAgentId: string, task: string): void {
    if (this.buffers.has(agentId)) return;
    const parentState = this.buffers.get(parentAgentId);
    if (!parentState) return;
    const rootAgentId = typeof parentState.pending.rootAgentId === 'string'
      ? parentState.pending.rootAgentId
      : parentAgentId;
    this.buffers.set(agentId, {
      pending: {
        ...parentState.pending,
        agentId,
        task,
        parentAgentId,
        rootAgentId,
      },
      events: [],
    });
  }

  private findPendingForWorkflowTask(task: string): ReplyBufferState | null {
    const normalizedTask = task.trim();
    if (!normalizedTask) return null;
    let fallback: ReplyBufferState | null = null;
    for (const state of this.buffers.values()) {
      if (typeof state.pending.workflowChainId === 'string') continue;
      const agentTask = typeof state.pending.agentTask === 'string' ? state.pending.agentTask.trim() : '';
      const pendingTask = state.pending.task.trim();
      if (agentTask === normalizedTask) return state;
      if (!fallback && pendingTask === normalizedTask) {
        fallback = state;
      }
    }
    return fallback;
  }

  private associateWorkflowChain(agentId: string, chainId: string): void {
    const state = this.buffers.get(agentId);
    if (!state) return;
    this.workflowChains.set(chainId, agentId);
    this.buffers.set(agentId, {
      ...state,
      pending: {
        ...state.pending,
        workflowChainId: chainId,
      },
    });
  }

  private async resolvePolicy(surface: ChannelSurface): Promise<ChannelRenderPolicy> {
    return await this.channelPlugins.getRenderPolicy(surface) ?? DEFAULT_POLICY[surface];
  }

  private async dispatch(
    state: ReplyBufferState,
    policy: ChannelRenderPolicy,
    phase: ChannelRenderPhase,
    text: string,
    events: readonly ChannelRenderEvent[],
  ): Promise<ChannelRenderResult | null> {
    const request: ChannelRenderRequest = {
      surface: state.pending.surfaceKind,
      phase,
      agentId: state.pending.agentId,
      sessionId: state.pending.sessionId,
      routeId: state.pending.routeId,
      title: state.pending.task,
      text,
      events,
      pending: state.pending,
      metadata: {
        policy,
      },
    };
    const result = await this.channelPlugins.render(state.pending.surfaceKind, request);
    if (result?.responseId && state.pending.routeId) {
      await this.routeBindings.captureReplyTarget(
        state.pending.routeId,
        result.responseId,
        typeof result.threadId === 'string' && result.threadId.length > 0 ? result.threadId : undefined,
      );
    }
    return result;
  }

  private disposeSubscriptions(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }
}
