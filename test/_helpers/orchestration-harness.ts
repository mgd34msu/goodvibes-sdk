/**
 * Shared test harness for the orchestration engine.
 *
 * Mirrors test/wrfc-controller.test.ts's harness shape (fake AgentManager
 * driven by real RuntimeEventBus emitters) so the two systems' tests read
 * the same way and exercise the SAME event contract the engine actually
 * listens on (phase-runner.ts's awaitAgentTermination -> runtimeBus.onDomain
 * ('agents', ...)).
 */
import { RuntimeEventBus } from '../../packages/sdk/src/platform/runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
} from '../../packages/sdk/src/platform/runtime/emitters/agents.js';
import type { AgentInput, AgentRecord } from '../../packages/sdk/src/platform/tools/agent/manager.js';
import type { PhaseRunnerAgentManagerLike, WrfcWorktreeOps } from '../../packages/sdk/src/platform/orchestration/index.js';
import type { CommitWorkingTreeResult } from '../../packages/sdk/src/platform/agents/worktree.js';

/** Drain the microtask queue fully (RuntimeEventBus + Promise chains use queueMicrotask). */
export async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

export function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id,
    task: overrides.task,
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'running',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

/** JSON-fenced engineer report, matching parseCompletionReport's expected shape. */
export function engineerReportOutput(opts: {
  summary?: string;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
}): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary: opts.summary ?? 'did the work',
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [opts.summary ?? 'did the work'],
      filesCreated: opts.filesCreated ?? [],
      filesModified: opts.filesModified ?? [],
      filesDeleted: opts.filesDeleted ?? [],
      decisions: [],
      issues: [],
      uncertainties: [],
      constraints: [],
    }),
    '```',
  ].join('\n');
}

/** JSON-fenced reviewer report. */
export function reviewerReportOutput(opts: {
  passed: boolean;
  score?: number;
  constraintFindings?: Array<{ constraintId: string; satisfied: boolean; evidence: string; severity?: 'critical' | 'major' | 'minor' }>;
}): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: opts.passed ? 'passed' : 'needs fixes',
      score: opts.score ?? (opts.passed ? 10 : 4),
      passed: opts.passed,
      dimensions: [],
      issues: opts.passed ? [] : [{ severity: 'major', description: 'needs a fix', pointValue: 1 }],
      constraintFindings: opts.constraintFindings ?? [],
      acceptanceChecklist: [{ item: 'deliverable meets the task ask', verified: true, evidence: 'exercised in test fixture' }],
    }),
    '```',
  ].join('\n');
}

export interface FakeWorktree extends WrfcWorktreeOps {
  readonly commits: Array<{ message: string; paths: string[] | undefined; agentId?: string }>;
  readonly merges: string[];
  readonly cleanups: string[];
}

export function makeFakeWorktree(): FakeWorktree {
  const commits: FakeWorktree['commits'] = [];
  const merges: string[] = [];
  const cleanups: string[] = [];
  return {
    commits,
    merges,
    cleanups,
    async commitWorkingTree(message: string, paths?: string[]): Promise<CommitWorkingTreeResult> {
      commits.push({ message, paths });
      return { hash: 'fake-commit-sha', skippedIgnored: [] };
    },
    async merge(agentId: string): Promise<boolean> {
      merges.push(agentId);
      return true;
    },
    async cleanup(agentId: string): Promise<void> {
      cleanups.push(agentId);
    },
    async currentHead(): Promise<string | null> {
      return 'fake-head-sha';
    },
  };
}

export interface OrchestrationTestHarness {
  bus: RuntimeEventBus;
  agentManager: PhaseRunnerAgentManagerLike;
  agentStore: Map<string, AgentRecord>;
  spawnedRecords: AgentRecord[];
  cancelCalls: Array<{ agentId: string; kind: 'interrupt' | 'kill' }>;
  registeredSignals: Map<string, AbortSignal>;
  worktree: FakeWorktree;
  /** Set the record's fullOutput + usage, then emit AGENT_COMPLETED. */
  completeAgent(agentId: string, fullOutput: string, usage?: Partial<NonNullable<AgentRecord['usage']>>): void;
  failAgent(agentId: string, error: string): void;
  /** Simulate a real cancel: mirrors AgentManager.cancel's status flip + AGENT_CANCELLED emit. */
  cancelViaBus(agentId: string): void;
}

const ctx = { sessionId: 'test', traceId: 'test', source: 'test' } as const;

export function createOrchestrationHarness(): OrchestrationTestHarness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const cancelCalls: Array<{ agentId: string; kind: 'interrupt' | 'kill' }> = [];
  const registeredSignals = new Map<string, AbortSignal>();
  const worktree = makeFakeWorktree();

  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn(input: AgentInput): AgentRecord {
      const id = `agent-${spawnedRecords.length + 1}`;
      const record = makeRecord({
        id,
        task: input.task ?? 'spawned-task',
        template: input.template ?? 'engineer',
        status: 'running',
      });
      agentStore.set(id, record);
      spawnedRecords.push(record);
      return record;
    },
    getStatus(id: string): AgentRecord | null {
      return agentStore.get(id) ?? null;
    },
    cancel(id: string, kind: 'interrupt' | 'kill' = 'kill'): boolean {
      cancelCalls.push({ agentId: id, kind });
      const record = agentStore.get(id);
      if (!record || (record.status !== 'pending' && record.status !== 'running')) return false;
      record.status = 'cancelled';
      record.terminationKind = kind;
      record.completedAt = Date.now();
      emitAgentCancelled(bus, ctx, { agentId: id, reason: 'test cancel' });
      return true;
    },
    registerCancellationSignal(agentId: string, signal: AbortSignal): void {
      registeredSignals.set(agentId, signal);
    },
    releaseCancellationSignal(agentId: string): void {
      registeredSignals.delete(agentId);
    },
  };

  function completeAgent(agentId: string, fullOutput: string, usage?: Partial<NonNullable<AgentRecord['usage']>>): void {
    const record = agentStore.get(agentId);
    if (!record) throw new Error(`no such agent: ${agentId}`);
    record.status = 'completed';
    record.completedAt = Date.now();
    record.fullOutput = fullOutput;
    record.usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      llmCallCount: 1,
      turnCount: 1,
      ...usage,
    };
    emitAgentCompleted(bus, ctx, { agentId, durationMs: 1 });
  }

  function failAgent(agentId: string, error: string): void {
    const record = agentStore.get(agentId);
    if (!record) throw new Error(`no such agent: ${agentId}`);
    record.status = 'failed';
    record.completedAt = Date.now();
    record.error = error;
    emitAgentFailed(bus, ctx, { agentId, error, durationMs: 1 });
  }

  function cancelViaBus(agentId: string): void {
    agentManager.cancel(agentId, 'kill');
  }

  return {
    bus,
    agentManager,
    agentStore,
    spawnedRecords,
    cancelCalls,
    registeredSignals,
    worktree,
    completeAgent,
    failAgent,
    cancelViaBus,
  };
}

/** Config manager stub: no gates configured, transport retry disabled (deterministic, fast tests). */
export function makeFakeConfigManager(): { get: (key: string) => unknown; getCategory: (category: string) => unknown } {
  return {
    get: (key: string) => (key === 'wrfc.transportRetryLimit' ? 0 : undefined),
    getCategory: () => undefined,
  };
}
