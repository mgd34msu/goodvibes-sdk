/**
 * Production DecompositionRunner backed by AgentManager
 * (agents/planner-decomposition-runner.ts).
 *
 * A fake AgentManager stands in for the real spawn/poll/cancel machinery so the
 * runner's bound enforcement is deterministic: wall-timeout, token ceiling, and
 * an external kill all resolve to a 'cancelled' run result; a clean finish maps
 * output/usage/elapsed; a spawn throw resolves to 'failed'. `now`/`sleep` are
 * injected and a virtual clock advances on each poll.
 */
import { describe, expect, test } from 'bun:test';
import { createAgentManagerDecompositionRunner } from '../packages/sdk/src/platform/agents/planner-decomposition-runner.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

type Poll = (i: number) => { status: AgentRecord['status']; usage?: AgentRecord['usage']; fullOutput?: string; error?: string };

interface FakeOpts {
  poll?: Poll;
  throwOnSpawn?: boolean;
}

function makeFake(opts: FakeOpts) {
  const clock = { t: 0 };
  const cancelCalls: Array<{ id: string; kind: string }> = [];
  let pollIdx = 0;
  let forced: AgentRecord['status'] | null = null;
  let lastUsage: AgentRecord['usage'];
  let lastOutput: string | undefined;

  const record: AgentRecord = {
    id: 'agent-planner-1', task: 'x', template: 'planner', tools: ['read'],
    status: 'pending', startedAt: 0, toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'direct',
  };

  const agentManager = {
    spawn() {
      if (opts.throwOnSpawn) throw new Error('spawn rejected');
      return record;
    },
    getStatus() {
      if (forced) {
        return { ...record, status: forced, usage: lastUsage, fullOutput: lastOutput, completedAt: clock.t } as AgentRecord;
      }
      const p = opts.poll ? opts.poll(pollIdx++) : { status: 'completed' as const };
      lastUsage = p.usage ?? lastUsage;
      lastOutput = p.fullOutput ?? lastOutput;
      const terminal = p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled';
      return {
        ...record,
        status: p.status,
        usage: p.usage,
        fullOutput: p.fullOutput,
        error: p.error,
        ...(terminal ? { completedAt: clock.t } : {}),
      } as AgentRecord;
    },
    cancel(id: string, kind: 'interrupt' | 'kill' = 'kill') {
      cancelCalls.push({ id, kind });
      forced = 'cancelled';
      return true;
    },
  };

  const now = () => clock.t;
  const sleep = async (ms: number) => { clock.t += ms; };
  return { agentManager, now, sleep, cancelCalls, clock };
}

const REQ = {
  goal: 'g', workingDir: '/repo', systemPrompt: 'sys', userPrompt: 'usr',
  bounds: { maxTurns: 6, tokenCeiling: 10_000, wallTimeoutMs: 200 },
  attempt: 'initial' as const,
};

const usage = (inp: number, out: number) => ({
  inputTokens: inp, outputTokens: out, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1,
});

describe('AgentManager decomposition runner', () => {
  test('a clean finish maps output + usage + elapsed', async () => {
    const fake = makeFake({
      poll: (i) => i < 2
        ? { status: 'running', usage: usage(100, 20) }
        : { status: 'completed', usage: usage(500, 100), fullOutput: '{"items":[]}' },
    });
    const runner = createAgentManagerDecompositionRunner({ agentManager: fake.agentManager, now: fake.now, sleep: fake.sleep, pollIntervalMs: 10 });
    const result = await runner.run(REQ);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('{"items":[]}');
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 600 });
    expect(fake.cancelCalls).toHaveLength(0);
  });

  test('wall-timeout cancels the agent → cancelled with detail', async () => {
    const fake = makeFake({ poll: () => ({ status: 'running', usage: usage(10, 5) }) });
    const runner = createAgentManagerDecompositionRunner({ agentManager: fake.agentManager, now: fake.now, sleep: fake.sleep, pollIntervalMs: 50 });
    const result = await runner.run(REQ);
    expect(result.status).toBe('cancelled');
    expect(result.detail).toContain('wall-timeout');
    expect(fake.cancelCalls).toEqual([{ id: 'agent-planner-1', kind: 'kill' }]);
  });

  test('token ceiling cancels the agent → cancelled with detail', async () => {
    const fake = makeFake({ poll: () => ({ status: 'running', usage: usage(9_000, 5_000) }) });
    const runner = createAgentManagerDecompositionRunner({ agentManager: fake.agentManager, now: fake.now, sleep: fake.sleep, pollIntervalMs: 10 });
    const result = await runner.run(REQ);
    expect(result.status).toBe('cancelled');
    expect(result.detail).toContain('token ceiling');
    expect(fake.cancelCalls).toHaveLength(1);
  });

  test('an external kill (already cancelled) → cancelled, no bound detail, no cancel call', async () => {
    const fake = makeFake({ poll: () => ({ status: 'cancelled' }) });
    const runner = createAgentManagerDecompositionRunner({ agentManager: fake.agentManager, now: fake.now, sleep: fake.sleep, pollIntervalMs: 10 });
    const result = await runner.run(REQ);
    expect(result.status).toBe('cancelled');
    expect(result.detail).toBeUndefined();
    expect(fake.cancelCalls).toHaveLength(0);
  });

  test('a spawn throw → failed', async () => {
    const fake = makeFake({ throwOnSpawn: true });
    const runner = createAgentManagerDecompositionRunner({ agentManager: fake.agentManager, now: fake.now, sleep: fake.sleep });
    const result = await runner.run(REQ);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('spawn rejected');
  });
});
