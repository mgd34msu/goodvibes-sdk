import type { ConfigManager } from '../config/manager.js';
import type { ConversationFollowUpItem } from '../core/conversation-follow-ups.js';
import type { AgentEvent, ProviderEvent, RuntimeEventBus, WorkflowEvent } from './events/index.js';
import type { createDomainDispatch } from './store/index.js';
import type { WrfcController } from '../agents/wrfc-controller.js';
import type { AgentManager } from '../tools/agent/index.js';
import { finishWorkstreamLabel, rememberWorkstreamLabel, workstreamLabel } from '../channels/workstream-labels.js';

const AGENT_STATUS_INTERVAL_MS = 30_000;

export interface HostRuntimeMessageRouter {
  low(message: string): void;
  high(message: string): void;
  wrfc(message: string): void;
}

export interface HostRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => HostRuntimeMessageRouter | null;
  readonly queueConversationFollowUp?: ((item: ConversationFollowUpItem) => void) | undefined;
  readonly requestRender: () => void;
  readonly configManager: ConfigManager;
  readonly agentManager: AgentManager;
  readonly wrfcController: WrfcController;
}

/** What a person-facing runtime event line (below) means, for the notification history. */
export interface RuntimeEventNotice {
  /** The runtime event the line restates (e.g. 'WORKFLOW_CHAIN_PASSED'). */
  readonly type: string;
  /**
   * Which event it is: the type plus the agent or chain it is about, the same
   * value runtimeEventKey gives for that event's payload, so a host that sees
   * the event on the runtime bus and as this line can keep one entry. Absent
   * for a line whose event a host never also records from the bus.
   */
  readonly key?: string | undefined;
  /** The plain title a person reads for it. */
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line's own detail, without its bracket tag or status mark. */
  readonly detail: string;
}

/** How much of an id the lines carry: the last 8 characters of an agent id, the first 12 of a chain id. */
const agentRef = (agentId: string): string => agentId.slice(-8);
const chainRef = (chainId: string): string => chainId.slice(0, 12);

/**
 * Every line registerHostRuntimeEvents writes that restates one person-facing
 * runtime event, with that event's plain title and where the line names its
 * agent or chain. Kept next to the lines it matches; the test drives every
 * producer below through runtimeEventOfNotice so the two cannot drift apart.
 */
const RUNTIME_EVENT_NOTICE_LINES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly type: string;
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** How the line names its agent or chain; absent for a line that has no bus twin (no key). */
  readonly ref?: ((id: string) => string) | undefined;
}> = [
  { pattern: /^\[Agents\] \u2713 \S+ (\S+): ".*" \u2014 completed in \d+s/s, type: 'AGENT_COMPLETED', title: 'Agent finished', level: 'info', ref: agentRef },
  { pattern: /^\[Agents\] \u2717 \S+ (\S+): ".*" \u2014 failed in \d+s: /s, type: 'AGENT_FAILED', title: 'Agent failed', level: 'warning', ref: agentRef },
  { pattern: /^\[WRFC\] \u2713 Chain (\S+) PASSED \u2014 /, type: 'WORKFLOW_CHAIN_PASSED', title: 'Review chain passed', level: 'info', ref: chainRef },
  { pattern: /^\[WRFC\] \u2717 Chain (\S+) FAILED: /, type: 'WORKFLOW_CHAIN_FAILED', title: 'Review chain failed', level: 'warning', ref: chainRef },
  { pattern: /^\[WRFC\] Cascade abort: .*\(chain (\S+)\)$/s, type: 'WORKFLOW_CASCADE_ABORTED', title: 'Review chain stopped', level: 'warning', ref: chainRef },
  { pattern: /^\[WRFC\] Auto-committed chain (\S+)/, type: 'WORKFLOW_AUTO_COMMITTED', title: 'Reviewed changes committed', level: 'info', ref: chainRef },
  { pattern: /^\[WRFC\] Score regression warning: .*\(chain (\S+)\)$/s, type: 'WORKFLOW_SCORE_REGRESSION', title: 'Review score dropped', level: 'warning', ref: chainRef },
  // Chain events only these lines report (no bus twin in a host's history, so no key).
  { pattern: /^\[WRFC\] Chain \S+ started: /s, type: 'WORKFLOW_CHAIN_CREATED', title: 'Review chain started', level: 'info' },
  { pattern: /^\[WRFC\] \u2713 Review \S+: \d+\/10/, type: 'WORKFLOW_REVIEW_COMPLETED', title: 'Review passed', level: 'info' },
  { pattern: /^\[WRFC\] \u2717 Review \S+: \d+\/10/, type: 'WORKFLOW_REVIEW_COMPLETED', title: 'Review asked for fixes', level: 'warning' },
  { pattern: /^\[WRFC\]\s+\u2713 Gate: .+ passed$/, type: 'WORKFLOW_GATE_RESULT', title: 'Quality check passed', level: 'info' },
  { pattern: /^\[WRFC\]\s+\u2717 Gate: .+ FAILED$/, type: 'WORKFLOW_GATE_RESULT', title: 'Quality check failed', level: 'warning' },
];

/** The runtime event a system line from registerHostRuntimeEvents restates, or undefined for any other line. */
export function runtimeEventOfNotice(text: string): RuntimeEventNotice | undefined {
  const line = text.trim();
  for (const entry of RUNTIME_EVENT_NOTICE_LINES) {
    const match = entry.pattern.exec(line);
    if (!match) continue;
    const detail = line.replace(/^\[[^\]\n]+\]\s*/, '').replace(/^[\u2713\u2717]\s*/, '');
    const key = entry.ref ? `${entry.type}:${entry.ref(match[1] ?? '')}` : undefined;
    return { type: entry.type, ...(key ? { key } : {}), title: entry.title, level: entry.level, detail };
  }
  return undefined;
}

/**
 * The key runtimeEventOfNotice gives the line for this runtime event, from the
 * event's own payload; undefined for an event no such line restates.
 */
export function runtimeEventKey(type: string, payload: unknown): string | undefined {
  const entry = RUNTIME_EVENT_NOTICE_LINES.find((candidate) => candidate.type === type && candidate.ref);
  if (!entry?.ref || !payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const id = type.startsWith('AGENT_') ? record['agentId'] : record['chainId'];
  return typeof id === 'string' && id.length > 0 ? `${type}:${entry.ref(id)}` : undefined;
}

function withRouter(
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  action: (router: HostRuntimeMessageRouter) => void,
): void {
  const router = getSystemMessageRouter();
  if (router) action(router);
}

function buildCohortReport(agentManager: AgentManager, cohort: string): string {
  const agents = agentManager.listByCohort(cohort);
  if (agents.length === 0) return `[Agents] Cohort '${cohort}' complete (no agents found).`;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  const lines: string[] = [
    `[Agents] Cohort '${cohort}' complete: ${completed} completed, ${failed} failed, ${cancelled} cancelled (${agents.length} total)`,
  ];
  for (const agent of agents) {
    const durationSeconds = agent.completedAt !== undefined ? Math.round((agent.completedAt - agent.startedAt) / 1000) : 0;
    const icon = agent.status === 'completed' ? '\u2713' : agent.status === 'failed' ? '\u2717' : '~';
    const errorSuffix = agent.error ? ` \u2014 ${agent.error}` : '';
    lines.push(`  ${icon} ${agent.id.slice(-8)}: ${agent.status} in ${durationSeconds}s (${agent.toolCallCount} tool calls)${errorSuffix}`);
  }
  return lines.join('\n');
}

function buildCohortFollowUp(agentManager: AgentManager, cohort: string): ConversationFollowUpItem {
  const agents = agentManager.listByCohort(cohort);
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  return {
    key: `cohort:${cohort}:complete`,
    summary: `Agent cohort "${cohort}" finished with ${completed} completed, ${failed} failed, and ${cancelled} cancelled out of ${agents.length} total agents.`,
  };
}

function checkCohortCompletion(
  agentManager: AgentManager,
  wrfcController: WrfcController,
  record: { cohort?: string | undefined } | null,
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  queueConversationFollowUp?: (item: ConversationFollowUpItem) => void,
): void {
  if (!record?.cohort) return;
  const cohortAgents = agentManager.listByCohort(record.cohort);
  const allAgentsDone = cohortAgents.every((agent) => agent.status !== 'running' && agent.status !== 'pending');
  if (!allAgentsDone) return;

  const allChains = wrfcController.listChains();
  const cohortAgentIds = new Set(cohortAgents.map((agent) => agent.id));
  const cohortChains = allChains.filter((chain) =>
    (chain.engineerAgentId && cohortAgentIds.has(chain.engineerAgentId))
      || (chain.reviewerAgentId && cohortAgentIds.has(chain.reviewerAgentId))
      || (chain.fixerAgentId && cohortAgentIds.has(chain.fixerAgentId)),
  );
  const terminalStates = new Set(['passed', 'failed']);
  const allChainsDone = cohortChains.every((chain) => terminalStates.has(chain.state));
  if (!allChainsDone) return;

  withRouter(getSystemMessageRouter, (router) => {
    router.low(buildCohortReport(agentManager, record.cohort!));
  });
  queueConversationFollowUp?.(buildCohortFollowUp(agentManager, record.cohort));
}

export function registerHostRuntimeEvents(
  options: HostRuntimeEventBridgeOptions,
): { unsubs: Array<() => void>; agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } } {
  const {
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter,
    queueConversationFollowUp,
    requestRender,
    configManager,
    agentManager,
    wrfcController,
  } = options;
  const unsubs: Array<() => void> = [];

  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('orchestration', (env) => {
    domainDispatch.dispatchOrchestrationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('communication', (env) => {
    domainDispatch.dispatchCommunicationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('compaction', (env) => {
    domainDispatch.dispatchCompactionEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('transport', (env) => {
    domainDispatch.dispatchTransportEvent(env.payload);
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_SCORE_REGRESSION' }>>('WORKFLOW_SCORE_REGRESSION', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Score regression warning: ${payload.reason} (chain ${payload.chainId})`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CASCADE_ABORTED' }>>('WORKFLOW_CASCADE_ABORTED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Cascade abort: ${payload.reason} (chain ${payload.chainId})`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
    // Registered here as well as in the channel renderer, because the
    // conversation follow-ups below need a name for this workstream and a
    // TUI-only run never goes through a channel. Remembering twice is a no-op.
    rememberWorkstreamLabel(payload.chainId, payload.task);
    withRouter(getSystemMessageRouter, (router) => {
      // Operator feed: the id belongs here, where it is used for correlation.
      router.wrfc(`[WRFC] Chain ${payload.chainId} started: ${payload.task}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>('WORKFLOW_REVIEW_COMPLETED', ({ payload }) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    const threshold = configManager.get('wrfc.scoreThreshold') as number;
    const suffix = payload.passed ? '' : ` - Minimum score is ${threshold}/10, spawning a fix agent ...`;
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] ${icon} Review ${payload.chainId.slice(0, 12)}: ${payload.score}/10${suffix}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      // The chain's landing outcome (committed, or why not) is the line's second line, so a person reads it.
      router.wrfc(`[WRFC] \u2713 Chain ${payload.chainId.slice(0, 12)} PASSED \u2014 all gates clear${payload.note ? `\n${payload.note}` : ''}`);
    });
    // A conversation follow-up is read by the person, not the operator, so it
    // is named in plain words. The `key` keeps the id: it is a dedupe key
    // nobody reads. See channels/workstream-labels.ts.
    queueConversationFollowUp?.({
      key: `wrfc:${payload.chainId}:passed`,
      summary: `${workstreamLabel(payload.chainId)} passed all its checks.`,
    });
    finishWorkstreamLabel(payload.chainId);
    const chain = wrfcController.getChain(payload.chainId);
    if (chain?.engineerAgentId) {
      const record = agentManager.getStatus(chain.engineerAgentId);
      checkCohortCompletion(agentManager, wrfcController, record! ?? null, getSystemMessageRouter, queueConversationFollowUp);
    }
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] \u2717 Chain ${payload.chainId.slice(0, 12)} FAILED: ${payload.reason}`);
    });
    queueConversationFollowUp?.({
      key: `wrfc:${payload.chainId}:failed`,
      summary: `${workstreamLabel(payload.chainId)} could not be finished: ${payload.reason.slice(0, 120)}`,
    });
    finishWorkstreamLabel(payload.chainId);
    const chain = wrfcController.getChain(payload.chainId);
    if (chain?.engineerAgentId) {
      const record = agentManager.getStatus(chain.engineerAgentId);
      checkCohortCompletion(agentManager, wrfcController, record! ?? null, getSystemMessageRouter, queueConversationFollowUp);
    }
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_AUTO_COMMITTED' }>>('WORKFLOW_AUTO_COMMITTED', ({ payload }) => {
    const suffix = payload.commitHash ? ` (${payload.commitHash.slice(0, 7)})` : '';
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Auto-committed chain ${payload.chainId.slice(0, 12)}${suffix}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_GATE_RESULT' }>>('WORKFLOW_GATE_RESULT', ({ payload }) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC]   ${icon} Gate: ${payload.gate} ${payload.passed ? 'passed' : 'FAILED'}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record) {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2713 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 completed in ${durationSeconds}s (${record.toolCallCount} tool calls)`);
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:completed`,
        summary: `${record.template} agent ${payload.agentId.slice(-8)} completed "${taskSnippet}" in ${durationSeconds}s after ${record.toolCallCount} tool calls.`,
      });
    }
    checkCohortCompletion(agentManager, wrfcController, record! ?? null, getSystemMessageRouter, queueConversationFollowUp);
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2717 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 failed in ${durationSeconds}s: ${payload.error}`);
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:failed`,
        summary: `${record.template} agent ${payload.agentId.slice(-8)} failed after ${durationSeconds}s while working on "${taskSnippet}": ${payload.error.slice(0, 120)}`,
      });
    }
    checkCohortCompletion(agentManager, wrfcController, record! ?? null, getSystemMessageRouter, queueConversationFollowUp);
    requestRender();
  }));

  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = agentManager.list().filter((agent) => agent.status === 'running');
    if (running.length === 0) return;
    const lines = running.map((agent) => `  ${agent.id.slice(-8)}: ${agent.progress ?? agent.status}`);
    withRouter(getSystemMessageRouter, (router) => {
      router.low(`[Agents] ${running.length} running:\n${lines.join('\n')}`);
    });
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);
  // Don't block clean process exit.
  (agentStatusIntervalRef.value as unknown as { unref?: () => void }).unref?.();

  return { unsubs, agentStatusIntervalRef };
}

export type BootstrapRuntimeEventBridgeOptions = HostRuntimeEventBridgeOptions;
export const registerBootstrapRuntimeEvents = registerHostRuntimeEvents;
