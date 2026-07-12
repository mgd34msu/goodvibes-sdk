/**
 * Cost trust.
 *
 * A cold eval: the WRFC owner row showed 284.4k tokens "unpriced" while its
 * children priced fine, and the chain detail read "model unknown". Root cause: the
 * owner runs no LLM turn itself, so it has no resolved model — its usage is a
 * mixed-model rollup of its children. Single-model pricing is wrong and "unpriced"
 * is misleading.
 *
 * Fix: the owner ROW adopts the chain's per-child-summed cost + a model descriptor;
 * the chain node carries a model descriptor derived from its members. The owner is
 * excluded from every leaf-sum, so this never double-counts.
 */

import { describe, expect, test } from 'bun:test';
import { adaptChain, repriceWrfcOwnerNode } from '../packages/sdk/src/platform/runtime/fleet/adapters/wrfc.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessNode, ProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps } from '../packages/sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { WrfcChain } from '../packages/sdk/src/platform/agents/wrfc-types.js';

const T0 = 1_750_000_000_000;
const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };

function makeAgent(o: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'work', template: 'engineer', tools: [], status: 'running', startedAt: T0, toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only', ...o,
  };
}
function makeChain(o: Partial<WrfcChain> & { id: string }): WrfcChain {
  return {
    state: 'reviewing', task: 't', ownerAgentId: 'owner-1', allAgentIds: [], fixAttempts: 0, reviewCycles: 0,
    createdAt: T0, reviewScores: [], ownerDecisions: [], ownerTerminalEmitted: false, constraints: [],
    constraintsEnumerated: false, ...o,
  };
}
function makeDeps(o: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    wrfcController: { listChains: () => [] },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false },
    },
    now: () => T0 + 5_000, ...o,
  };
}
function nodeById(registry: ProcessRegistry, id: string): ProcessNode {
  const node = registry.getNode(id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

describe('repriceWrfcOwnerNode + chain model descriptor (unit)', () => {
  const chainNode: ProcessNode = {
    id: 'chain:c', kind: 'wrfc-chain', label: 'c', state: 'executing-tool', elapsedMs: 0,
    model: '2 models', costUsd: 0.446, costState: 'priced', capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
  };
  const unpricedOwner: ProcessNode = {
    id: 'owner', kind: 'agent', label: 'orchestrator (owner)', state: 'executing-tool', elapsedMs: 0,
    costUsd: null, costState: 'unpriced', capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
  };

  test('unpriced owner adopts the chain per-child cost + model descriptor', () => {
    const repriced = repriceWrfcOwnerNode(unpricedOwner, chainNode);
    expect(repriced).not.toBe(unpricedOwner);
    expect(repriced.costUsd).toBe(0.446);
    expect(repriced.costState).toBe('priced');
    expect(repriced.model).toBe('2 models');
  });

  test('already-priced owner is left untouched (same reference)', () => {
    const priced = { ...unpricedOwner, costUsd: 1.0, costState: 'priced' as const };
    expect(repriceWrfcOwnerNode(priced, chainNode)).toBe(priced);
  });

  test('unpriced chain cannot reprice the owner (stays unpriced, same reference)', () => {
    const unpricedChain = { ...chainNode, costUsd: null, costState: 'unpriced' as const };
    expect(repriceWrfcOwnerNode(unpricedOwner, unpricedChain)).toBe(unpricedOwner);
  });

  test('adaptChain sets a model descriptor from members: single / multiple / none', () => {
    const member = (id: string, model?: string): ProcessNode => ({
      id, kind: 'agent', label: id, state: 'done', elapsedMs: 0, model, costUsd: null, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    });
    const chain = makeChain({ id: 'c', allAgentIds: ['owner-1'] });
    expect(adaptChain(chain, [member('a', 'm1')], T0).model).toBe('m1');
    expect(adaptChain(chain, [member('a', 'm1'), member('b', 'm2')], T0).model).toBe('2 models');
    expect(adaptChain(chain, [member('a')], T0).model).toBeUndefined();
  });
});

describe('registry integration — owner priced, chain model, no double-count', () => {
  test('owner unpriced-by-model is repriced to the chain total; leaf-sum still excludes the owner', () => {
    const chain = makeChain({ id: 'ch', ownerAgentId: 'owner-1', allAgentIds: ['owner-1', 'eng', 'rev'] });
    const agents = [
      // Owner: no model → real priceUsage returns null → unpriced. Usage is the mixed
      // rollup of its children (as completeOwnerAgent backfills it).
      makeAgent({ id: 'owner-1', wrfcId: 'ch', wrfcRole: 'owner', usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2 } }),
      makeAgent({ id: 'eng', wrfcId: 'ch', model: 'm1', usage: { ...USAGE } }),
      makeAgent({ id: 'rev', wrfcId: 'ch', model: 'm2', usage: { ...USAGE } }),
    ];
    const priceUsage = (model: string | undefined): number | null =>
      model === 'm1' ? 0.3 : model === 'm2' ? 0.146 : null;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
      priceUsage,
    }));

    const chainNode = nodeById(registry, 'chain:ch');
    // (b) chain model populated from members (m1 + m2 → "2 models"), not "unknown".
    expect(chainNode.model).toBe('2 models');
    expect(chainNode.costUsd).toBeCloseTo(0.446, 6);

    // (a) owner priced — adopts the chain total, no longer "unpriced".
    const owner = nodeById(registry, 'owner-1');
    expect(owner.costState).toBe('priced');
    expect(owner.costUsd).toBeCloseTo(0.446, 6);
    expect(owner.model).toBe('2 models');

    // No double-count: the leaf-sum over agent nodes EXCLUDING the owner equals the
    // children total, i.e. the owner's repriced cost is display-only.
    const leafSum = [nodeById(registry, 'eng'), nodeById(registry, 'rev')]
      .reduce((s, n) => s + (n.costUsd ?? 0), 0);
    expect(leafSum).toBeCloseTo(0.446, 6);
    registry.dispose();
  });
});
