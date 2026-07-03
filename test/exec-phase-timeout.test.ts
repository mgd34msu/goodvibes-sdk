/**
 * exec-phase-timeout.test.ts
 *
 * Regression coverage for W0.1 secondary fix #4 (narrow scope only): the
 * `executing` phase timeout must never undercut an exec call's own
 * `timeout_ms` input. Full cooperative-cancellation/signal wiring (so an
 * abandoned child process actually gets killed when a phase timeout does
 * fire) is explicitly out of scope for this fix and deferred to a later wave.
 */

import { describe, expect, test } from 'bun:test';
import { createPhasedExecutor } from '../packages/sdk/src/platform/runtime/tools/index.js';
import type { ToolRuntimeContext } from '../packages/sdk/src/platform/runtime/tools/index.js';
import type { Tool } from '../packages/sdk/src/platform/types/tools.js';

function sleepingTool(name: string, ms: number): Tool {
  return {
    definition: {
      name,
      description: 'Tool used by phase-timeout tests',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { success: true, output: 'done' };
    },
  };
}

function runtimeContext(): ToolRuntimeContext {
  return {
    runtime: {
      getState: () => ({}),
      subscribe: () => () => undefined,
    },
    ids: {
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      traceId: 'trace-1',
    },
    tasks: {},
    resources: {},
    provider: {
      providerId: 'test',
      modelId: 'test-model',
      contextWindow: 128_000,
    },
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'background',
    hookDispatcher: { fire: async () => ({ ok: true }) },
  } as unknown as ToolRuntimeContext;
}

describe('executePhase — exec timeout_ms honored', () => {
  test('a large exec input.timeout_ms is honored even when it exceeds the configured phase timeout', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      // Deliberately small so the sleeping tool would time out on the default path.
      phaseTimeouts: { executing: 50 },
    });

    const result = await executor.execute(
      { id: 'call-exec', name: 'exec', arguments: { timeout_ms: 2000, commands: [{ cmd: 'true' }] } },
      sleepingTool('exec', 300),
      runtimeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
  });

  test('a non-exec tool is unaffected — the small configured phase timeout still applies', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      phaseTimeouts: { executing: 50 },
    });

    const result = await executor.execute(
      { id: 'call-other', name: 'some_other_tool', arguments: { timeout_ms: 2000 } },
      sleepingTool('some_other_tool', 300),
      runtimeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});
