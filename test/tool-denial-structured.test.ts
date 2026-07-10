/**
 * tool-denial-structured.test.ts
 *
 * A permission denial must reach the asking agent as structured, call-scoped data
 * — {denied, reason, scope} on the failed ToolResult, plus a self-explaining
 * error string — never a hung promise or a bare "Permission denied" line. These
 * tests drive the phased executor's permission phase with a denying permission
 * manager and assert the structured denial rides on the returned result.
 */
import { describe, expect, test } from 'bun:test';
import { createPhasedExecutor } from '../packages/sdk/src/platform/runtime/tools/index.js';
import type { ToolRuntimeContext } from '../packages/sdk/src/platform/runtime/tools/index.js';
import type { Tool } from '../packages/sdk/src/platform/types/tools.js';
import type { PermissionCheckResult } from '../packages/sdk/src/platform/permissions/types.js';

function tool(name: string): Tool {
  return {
    definition: { name, description: 'denial test tool', parameters: { type: 'object', properties: {} } },
    async execute() {
      return { success: true, output: 'SHOULD NOT RUN' };
    },
  };
}

function denyingCheckResult(): PermissionCheckResult {
  return {
    approved: false,
    persisted: false,
    sourceLayer: 'user_prompt',
    reasonCode: 'user_denied',
    analysis: { classification: 'generic', riskLevel: 'high', summary: 'denied', reasons: [] },
  };
}

function contextWithDenyingPermissions(): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => undefined },
    ids: { sessionId: 's1', conversationId: 'c1', turnId: 't1', toolCallId: 'call-1', traceId: 'trace-1' },
    tasks: {},
    resources: {},
    provider: { providerId: 'test', modelId: 'test-model', contextWindow: 128_000 },
    cancellation: { signal: new AbortController().signal },
    executionMode: 'background',
    permissionManager: {
      checkDetailed: async () => denyingCheckResult(),
      check: async () => false,
      getCategory: () => 'execute',
    },
  } as unknown as ToolRuntimeContext;
}

describe('structured tool-call denial', () => {
  test('a denied call returns {denied, reason, scope} plus a self-explaining error', async () => {
    const executor = createPhasedExecutor({ enableHooks: false, enablePermissions: true, enableEvents: false });

    const result = await executor.execute(
      { id: 'call-deny', name: 'blocked_tool', arguments: {} },
      tool('blocked_tool'),
      contextWithDenyingPermissions(),
    );

    expect(result.success).toBe(false);
    expect(result.denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt' });
    // The error string names the reason and scope so an agent reading only the
    // text can still continue and report honestly.
    expect(result.error).toContain('user_denied');
    expect(result.error).toContain('user_prompt');
    // The tool body never ran.
    expect(result.output).toBeUndefined();
  });

  test('an approved call carries no denial', async () => {
    const executor = createPhasedExecutor({ enableHooks: false, enablePermissions: true, enableEvents: false });
    const ctx = contextWithDenyingPermissions() as unknown as { permissionManager: { checkDetailed: () => Promise<PermissionCheckResult> } };
    ctx.permissionManager.checkDetailed = async () => ({ ...denyingCheckResult(), approved: true, reasonCode: 'user_approved' });

    const result = await executor.execute(
      { id: 'call-ok', name: 'blocked_tool', arguments: {} },
      tool('blocked_tool'),
      ctx as unknown as ToolRuntimeContext,
    );

    expect(result.success).toBe(true);
    expect(result.denial).toBeUndefined();
  });
});
