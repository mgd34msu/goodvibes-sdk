/**
 * Production `DecompositionRunner` backed by the real `AgentManager`.
 *
 * This is the concrete driver that spawns a bounded, READ-ONLY `planner`
 * agent through the existing agents machinery and polls it to completion. It
 * lives in the agents layer (not `core`) precisely so `core/plan-decomposition.ts`
 * can stay free of any agent-machinery import and be unit-tested against a
 * stubbed runner. The planning agent it spawns is an ordinary `AgentManager`
 * agent, so it surfaces in the fleet like any other and honours kill/steer;
 * an external kill lands here as a `'cancelled'` result → heuristic fallback.
 *
 * Bounds are enforced cooperatively by polling `AgentRecord.usage`:
 *   - wall-clock: `cancel()` once `now() >= start + wallTimeoutMs`
 *   - token ceiling: `cancel()` once input+output tokens exceed the ceiling
 *   - turns: `cancel()` once `usage.turnCount` exceeds `maxTurns`
 * All three collapse to a `'cancelled'` run result (with a `detail`), which the
 * service turns into an honest `fallbackReason`.
 */

import type { AgentManager } from '../tools/agent/manager.js';
import type { AgentInput } from '../tools/agent/schema.js';
import { summarizeError } from '../utils/error-display.js';
import type {
  DecompositionRunner,
  DecompositionRunnerRequest,
  DecompositionRunResult,
} from '../core/plan-decomposition.js';
import type { DecompositionAgentUsage } from '../core/plan-proposal.js';

/** The read-only tool set the planner template resolves to. Kept in lockstep
 *  with AGENT_TEMPLATES.planner and passed with restrictTools for a hard cap. */
export const PLANNER_DECOMPOSITION_TOOLS = ['read', 'find', 'analyze', 'inspect'] as const;

export interface AgentManagerDecompositionRunnerDeps {
  agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval in ms (default 50). */
  pollIntervalMs?: number;
  /** Optional model registry key override for the planner agent. */
  model?: string | undefined;
  /** Optional provider override for the planner agent. */
  provider?: string | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function mapUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | undefined): DecompositionAgentUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

export function createAgentManagerDecompositionRunner(
  deps: AgentManagerDecompositionRunnerDeps,
): DecompositionRunner {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 50;

  return {
    async run(request: DecompositionRunnerRequest): Promise<DecompositionRunResult> {
      const start = now();

      const spawnInput: AgentInput = {
        mode: 'spawn',
        task: request.userPrompt,
        template: 'planner',
        tools: [...PLANNER_DECOMPOSITION_TOOLS],
        restrictTools: true,
        executionIntent: { filesystemPolicy: 'read-only', networkPolicy: 'deny', riskClass: 'safe' },
        reviewMode: 'none',
        dangerously_disable_wrfc: true,
        systemPromptAddendum: request.systemPrompt,
        ...(deps.model ? { model: deps.model } : {}),
        ...(deps.provider ? { provider: deps.provider } : {}),
      };

      let agentId: string;
      try {
        const record = deps.agentManager.spawn(spawnInput);
        agentId = record.id;
      } catch (err) {
        return { status: 'failed', output: '', elapsedMs: now() - start, detail: summarizeError(err) };
      }

      const deadline = start + request.bounds.wallTimeoutMs;
      let stopDetail: string | undefined;

      // Poll until terminal or a bound trips.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const cur = deps.agentManager.getStatus(agentId);
        if (!cur) {
          return { status: 'failed', output: '', elapsedMs: now() - start, detail: 'agent record disappeared', agentId };
        }
        if (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled') break;

        const tokens = (cur.usage?.inputTokens ?? 0) + (cur.usage?.outputTokens ?? 0);
        if (tokens > request.bounds.tokenCeiling) {
          stopDetail = `token ceiling exceeded (${tokens} > ${request.bounds.tokenCeiling})`;
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        if ((cur.usage?.turnCount ?? 0) > request.bounds.maxTurns) {
          stopDetail = `max turns exceeded (${request.bounds.maxTurns})`;
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        if (now() >= deadline) {
          stopDetail = `wall-timeout ${request.bounds.wallTimeoutMs}ms`;
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        await sleep(pollIntervalMs);
      }

      const final = deps.agentManager.getStatus(agentId);
      if (!final) {
        return { status: 'failed', output: '', elapsedMs: now() - start, detail: 'agent record disappeared', agentId };
      }
      const elapsedMs = (final.completedAt ?? now()) - start;
      const usage = mapUsage(final.usage);
      const output = final.fullOutput ?? '';

      if (final.status === 'completed') {
        return { status: 'completed', output, ...(usage ? { usage } : {}), elapsedMs, agentId };
      }
      if (final.status === 'cancelled') {
        return { status: 'cancelled', output, ...(usage ? { usage } : {}), elapsedMs, ...(stopDetail ? { detail: stopDetail } : {}), agentId };
      }
      return { status: 'failed', output, ...(usage ? { usage } : {}), elapsedMs, ...(final.error ? { detail: final.error } : {}), agentId };
    },
  };
}
