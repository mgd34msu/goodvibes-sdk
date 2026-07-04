/**
 * The 'planner' template is READ-ONLY: it resolves to read/find/analyze/inspect
 * only — no write/edit/exec/delegate/agent — and a write call is refused by the
 * tool policy the executor enforces. Proven at two layers: the resolved
 * AgentRecord.tools from a real AgentManager.spawn, and a ToolRegistry scoped to
 * the planner tool set refusing 'write'.
 */
import { describe, expect, test } from 'bun:test';
import { AgentManager, AGENT_TEMPLATES } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { Tool } from '../packages/sdk/src/platform/types/tools.js';
import { PLANNER_DECOMPOSITION_TOOLS } from '../packages/sdk/src/platform/agents/planner-decomposition-runner.js';

const FORBIDDEN = ['write', 'edit', 'exec', 'delegate', 'agent'];

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
    async execute() { return { success: true, output: `${name} ran` }; },
  } as unknown as Tool;
}

describe('planner template is read-only', () => {
  test('AGENT_TEMPLATES.planner declares only read-only tools', () => {
    const tools = AGENT_TEMPLATES.planner!.defaultTools;
    expect(tools).toEqual(['read', 'find', 'analyze', 'inspect']);
    for (const forbidden of FORBIDDEN) expect(tools).not.toContain(forbidden);
  });

  test('a spawned planner agent resolves to the read-only tool set', () => {
    const manager = new AgentManager({
      configManager: { get: () => null },
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      executor: { async runAgent() { /* capture only; never run a turn */ } },
    });
    const record = manager.spawn({
      mode: 'spawn',
      task: 'Decompose the goal into work items',
      template: 'planner',
      tools: [...PLANNER_DECOMPOSITION_TOOLS],
      restrictTools: true,
      dangerously_disable_wrfc: true,
    });
    expect(record.template).toBe('planner');
    expect(record.tools).toEqual(['read', 'find', 'analyze', 'inspect']);
    for (const forbidden of FORBIDDEN) expect(record.tools).not.toContain(forbidden);
  });

  test('a registry scoped to the planner tool set refuses a write call', async () => {
    // Mirrors the executor's buildScopedRegistry: only the agent's allowed
    // tools are registered, so a hallucinated write is an unknown tool.
    const scoped = new ToolRegistry();
    for (const name of PLANNER_DECOMPOSITION_TOOLS) scoped.register(fakeTool(name));

    const readOk = await scoped.execute('call-1', 'read', {});
    expect(readOk.success).toBe(true);

    const writeRefused = await scoped.execute('call-2', 'write', { path: '/x', content: 'y' });
    expect(writeRefused.success).toBe(false);
    expect(writeRefused.error).toContain("Unknown tool: 'write'");
  });
});
