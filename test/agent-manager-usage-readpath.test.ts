/**
 * WO fix: AgentManager.getStatus()/list() must return real per-agent usage
 * after a completion that carries it (cross-repo reviewer finding on WO-305).
 *
 * WO-305 added real usage to AGENT_COMPLETED events and to RuntimeAgent.usage
 * in the runtime store, but the TUI's per-agent surfaces read AgentRecord
 * objects from AgentManager.getStatus()/list(), not RuntimeAgent. This test
 * proves two things:
 *
 * 1. The direct (non-WRFC) execution path already works: orchestrator-runner.ts
 *    mutates `record.usage`/`record.toolCallCount` in place on the exact
 *    AgentRecord object AgentManager stores, so getStatus()/list() already
 *    reflect real numbers once the executor finishes. This test spawns an
 *    agent with a stub executor that mimics orchestrator-runner's real
 *    behaviour (accumulate usage, then flip status to 'completed') and
 *    asserts the manager's own read path sees it — no SDK change needed here.
 *
 * 2. The WRFC owner path is covered separately in wrfc-controller.test.ts,
 *    where the owner AgentRecord never runs an LLM turn itself and needs its
 *    usage/toolCallCount populated from its phase children at completion time.
 */
import { describe, expect, test } from 'bun:test';
import { AgentManager } from '../packages/sdk/src/platform/tools/agent/manager.js';

describe('AgentManager — usage read path after direct-executed completion', () => {
  test('getStatus() and list() return real usage/toolCallCount after a direct agent completes', async () => {
    const configManager = { get: () => null };
    const manager = new AgentManager({
      configManager,
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      executor: {
        async runAgent(record) {
          // Mirrors orchestrator-runner.ts's turn loop: usage/toolCallCount are
          // accumulated in place on the very AgentRecord object the manager
          // holds, then finalizeAgentRun() flips status to 'completed'.
          record.status = 'running';
          record.usage = {
            inputTokens: 500,
            outputTokens: 120,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            llmCallCount: 2,
            turnCount: 2,
            reasoningSummaryCount: 0,
          };
          record.toolCallCount = 3;
          record.status = 'completed';
          record.completedAt = Date.now();
        },
      },
    });

    const spawned = manager.spawn({
      mode: 'spawn',
      task: 'do work',
      dangerously_disable_wrfc: true,
    });

    // Let the (synchronous-bodied) async executor settle.
    await Promise.resolve();
    await Promise.resolve();

    const status = manager.getStatus(spawned.id);
    expect(status?.status).toBe('completed');
    expect(status?.usage).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      llmCallCount: 2,
      turnCount: 2,
      reasoningSummaryCount: 0,
    });
    expect(status?.toolCallCount).toBe(3);

    const listed = manager.list().find((agent) => agent.id === spawned.id);
    expect(listed?.usage?.inputTokens).toBe(500);
    expect(listed?.toolCallCount).toBe(3);
  });
});
