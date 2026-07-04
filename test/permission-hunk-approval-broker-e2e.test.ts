import { describe, expect, test } from 'bun:test';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import { executeToolCalls, type ToolExecutionDeps } from '../packages/sdk/src/platform/core/orchestrator-tool-runtime.js';
import type { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { ToolCall, ToolResult } from '../packages/sdk/src/platform/types/tools.js';

/**
 * Regression test for the "per-hunk deselect applies everything anyway" bug.
 *
 * test/permission-hunk-modified-args.test.ts already proves that
 * PermissionManager.checkDetailed() threads a `modifiedArgs` field verbatim
 * from whatever `requestPermission` handler it is given. That coverage never
 * caught the real bug because production's `requestPermission` handler is
 * NOT a bare function that returns `{ approved, remember, modifiedArgs }`
 * directly — it is `(request) => approvalBroker.requestApproval({ request,
 * sessionId, localPrompt })` (see the TUI's bootstrap-core.ts). The
 * interactive (TUI-local) path routes the decision through
 * ApprovalBroker.requestApproval()'s `localPrompt(...).then(decision =>
 * this.resolveApproval(...))` bridge before PermissionManager ever sees it,
 * and that bridge silently dropped `decision.modifiedArgs` — so by the time
 * checkDetailed() ran, modifiedArgs was already gone, regardless of what the
 * UI computed.
 *
 * This test exercises the REAL wiring end to end: ApprovalBroker sits between
 * the local prompt and PermissionManager, exactly as it does in the shipped
 * TUI. It proves that when a 2-edit `edit` tool call has one hunk deselected,
 * the args actually handed to tool execution contain exactly the selected
 * hunk — not both.
 */

function makePermissionConfigReader(): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/wo-hunk-apply-fix-tests',
    getSnapshot: () => ({
      permissions: {
        mode: 'prompt',
        tools: {},
      },
    }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

describe('ApprovalBroker -> PermissionManager -> executeToolCalls (real TUI wiring)', () => {
  test('deselecting one of two hunks executes only the selected hunk, not both', async () => {
    const approvalBroker = new ApprovalBroker({ storePath: ':memory:' });

    const firstEdit = { path: 'a.ts', find: 'foo', replace: 'FOO' };
    const secondEdit = { path: 'a.ts', find: 'bar', replace: 'BAR' };
    const originalArgs = { edits: [firstEdit, secondEdit] };
    // Mirrors hunk-selection.ts's buildModifiedEditArgs: only the selected
    // hunk (index 0) survives; index 1 was deselected by the user.
    const modifiedArgs = { edits: [firstEdit] };

    // Simulates the TUI's real permissionPromptRef.requestPermission: the user
    // pressed Space to deselect hunk 2, then Enter to apply the remaining selection.
    const localPrompt = async () => ({ approved: true, remember: false, modifiedArgs });

    const requestPermission = (request: Parameters<typeof approvalBroker.requestApproval>[0]['request']) =>
      approvalBroker.requestApproval({ request, sessionId: 'sess-1', localPrompt });

    const permissionManager = new PermissionManager(
      requestPermission,
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );

    let receivedArgs: Record<string, unknown> | undefined;
    const toolRegistry = {
      execute: async (callId: string, _name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        receivedArgs = args;
        return { callId, success: true, output: 'ok' };
      },
    } as unknown as ToolRegistry;

    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager,
      hookDispatcher: null,
      runtimeBus: null,
      sessionId: 'sess-1',
      emitterContext: (turnId: string) => ({ sessionId: 'sess-1', traceId: 'trace-1', turnId, source: 'orchestrator' }),
    };

    const call: ToolCall = { id: 'call-1', name: 'edit', arguments: originalArgs };
    const results = await executeToolCalls(deps, 'turn-1', [call]);

    expect(results[0]?.success).toBe(true);
    // The bug: this used to equal originalArgs (both hunks) because
    // ApprovalBroker dropped modifiedArgs on the way from the local prompt
    // decision to the resolved PermissionPromptDecision.
    expect(receivedArgs).toEqual(modifiedArgs);
    expect(receivedArgs).not.toEqual(originalArgs);
    expect((receivedArgs?.['edits'] as unknown[])?.length).toBe(1);
  });

  test('with no localPrompt-side filtering, both hunks still execute (control case)', async () => {
    const approvalBroker = new ApprovalBroker({ storePath: ':memory:' });
    const originalArgs = {
      edits: [
        { path: 'a.ts', find: 'foo', replace: 'FOO' },
        { path: 'a.ts', find: 'bar', replace: 'BAR' },
      ],
    };

    // Bare "Y" allow-once: no modifiedArgs at all, both hunks should execute.
    const localPrompt = async () => ({ approved: true, remember: false });
    const requestPermission = (request: Parameters<typeof approvalBroker.requestApproval>[0]['request']) =>
      approvalBroker.requestApproval({ request, sessionId: 'sess-1', localPrompt });

    const permissionManager = new PermissionManager(
      requestPermission,
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );

    let receivedArgs: Record<string, unknown> | undefined;
    const toolRegistry = {
      execute: async (callId: string, _name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        receivedArgs = args;
        return { callId, success: true, output: 'ok' };
      },
    } as unknown as ToolRegistry;

    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager,
      hookDispatcher: null,
      runtimeBus: null,
      sessionId: 'sess-1',
      emitterContext: (turnId: string) => ({ sessionId: 'sess-1', traceId: 'trace-1', turnId, source: 'orchestrator' }),
    };

    const call: ToolCall = { id: 'call-2', name: 'edit', arguments: originalArgs };
    await executeToolCalls(deps, 'turn-1', [call]);

    expect(receivedArgs).toEqual(originalArgs);
  });
});
