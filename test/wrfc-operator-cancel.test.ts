/**
 * WO UX-A item 2 — an operator kill is CANCELLED, not FAILED.
 *
 * A cold eval: K on a chain cancelled its running leaf, which routed through
 * failChain and flipped the whole chain + owner to "✗ failed" while the cohort
 * tally read "0 completed, 1 failed, 0 cancelled" — contradicting the transcript's
 * "operator cancellation". Only the leaf showed ⊘ cancelled.
 *
 * Fix: a cancelled member agent cancels the CHAIN (cancelChain), setting
 * failureKind='cancelled' at every surface, rolling the member usage onto the
 * owner, and narrating the landed work from the chain's edit ledger.
 */

import { describe, expect, test } from 'bun:test';
import { createWrfcControllerForTest } from '../packages/sdk/src/platform/agents/wrfc-controller-test-support.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import { adaptChain } from '../packages/sdk/src/platform/runtime/fleet/adapters/wrfc.js';
import type { WrfcChain } from '../packages/sdk/src/platform/agents/wrfc-types.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id, task: overrides.task, template: overrides.template ?? 'engineer', tools: [],
    status: 'running', startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0,
    executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 },
    ...overrides,
  };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createHarness() {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawned: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  bus.onDomain('workflows', (envelope) => {
    workflowEvents.push({ type: envelope.type, data: (envelope as unknown as { payload: Record<string, unknown> }).payload });
  });
  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return 9.9;
      if (key === 'wrfc.maxFixAttempts') return 3;
      if (key === 'wrfc.autoCommit') return false;
      return undefined;
    },
    getCategory: (c: string): unknown => c === 'wrfc' ? { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, gates: [] } : undefined,
  };
  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawned.length + 1}`;
      const record = makeRecord({ id, task: (input as { task?: string }).task ?? 'spawned', template: (input as { template?: string }).template ?? 'engineer' });
      agentStore.set(id, record);
      spawned.push(record);
      return record;
    },
    getStatus: (id) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: (id) => { const r = agentStore.get(id); if (r && (r.status === 'running' || r.status === 'pending')) { r.status = 'cancelled'; return true; } return false; },
    listByCohort: () => [],
    clear: () => agentStore.clear(),
  };
  const messageBus = { registerAgent: () => {} };
  const controller = createWrfcControllerForTest(bus, messageBus, {
    agentManager, configManager, projectRoot: '/tmp/test-operator-cancel',
    skipClaimVerification: true,
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  const addAgent = (id: string, task: string): AgentRecord => { const r = makeRecord({ id, task }); agentStore.set(id, r); return r; };
  return { bus, controller, agentStore, spawned, workflowEvents, addAgent };
}

function emitAgentCancelled(bus: RuntimeEventBus, agentId: string, reason: string): void {
  bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId, reason }, { sessionId: 'test', traceId: 'test', source: 'test' }));
}

describe('operator cancel — cancelled, not failed', () => {
  test('cancelling a running leaf cancels the chain: cancelled at chain + owner, narration counts landed files, event carries failureKind=cancelled', async () => {
    const h = createHarness();
    const owner = h.addAgent('owner-1', 'implement the feature');
    const chain = h.controller.createChain(owner);
    // Seed the chain's edit ledger with landed work.
    chain.touchedPaths = ['src/a.ts', 'src/b.ts'];

    const leafId = chain.engineerAgentId!;
    expect(leafId).toBeDefined();

    emitAgentCancelled(h.bus, leafId, 'operator cancellation');
    await flush();

    // Chain terminal state reads as cancelled (failureKind), not an ordinary failure.
    expect(chain.state).toBe('failed');
    expect(chain.failureKind).toBe('cancelled');

    // Owner row is cancelled with rolled-up usage (not spawn-time zeros).
    const ownerRec = h.agentStore.get('owner-1')!;
    expect(ownerRec.status).toBe('cancelled');
    expect(ownerRec.usage!.inputTokens).toBeGreaterThan(0);

    // Completion narration summarises the landed work from the ledger.
    expect(chain.error).toContain('2 files already modified on disk');

    // The workflow event carries failureKind='cancelled' so the host narrates a
    // cancellation, not a failure.
    const failedEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_CHAIN_FAILED');
    expect(failedEvent).toBeDefined();
    const payload = failedEvent!.data;
    expect(payload['failureKind']).toBe('cancelled');
    expect(String(payload['reason'])).toContain('already modified on disk');

    h.controller.dispose();
  });

  test('fleet chain node: a cancelled chain renders as killed (⊘), a genuine failure stays failed (✗)', () => {
    const base: WrfcChain = {
      id: 'ch-x', state: 'failed', task: 't', ownerAgentId: 'o', allAgentIds: ['o'],
      fixAttempts: 0, reviewCycles: 0, reviewScores: [], ownerDecisions: [], ownerTerminalEmitted: true,
      constraints: [], constraintsEnumerated: false, touchedPaths: [], createdAt: Date.now(),
    };
    const cancelled = adaptChain({ ...base, failureKind: 'cancelled' }, [], Date.now());
    expect(cancelled.state).toBe('killed');
    const genuinelyFailed = adaptChain({ ...base, failureKind: 'other' }, [], Date.now());
    expect(genuinelyFailed.state).toBe('failed');
  });
});
