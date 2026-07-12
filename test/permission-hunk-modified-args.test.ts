import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import { executeToolCalls, type ToolExecutionDeps } from '../packages/sdk/src/platform/core/orchestrator-tool-runtime.js';
import type { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';
import type { ToolCall, ToolResult } from '../packages/sdk/src/platform/types/tools.js';
import { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.js';
import { FileUndoManager } from '../packages/sdk/src/platform/state/file-undo.js';
import { createEditTool } from '../packages/sdk/src/platform/tools/edit/index.js';

function makePermissionConfigReader(mode: 'prompt' | 'custom' | 'allow-all' = 'prompt'): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/permission-tests',
    getSnapshot: () => ({
      permissions: {
        mode,
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

describe('PermissionManager.checkDetailed threads modifiedArgs', () => {
  test('threads modifiedArgs verbatim from the requestPermission handler', async () => {
    const manager = new PermissionManager(
      async () => ({ approved: true, remember: false, modifiedArgs: { edits: [{ path: 'a.ts', find: 'x', replace: 'y' }] } }),
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );

    const result = await manager.checkDetailed('edit', { edits: [{ path: 'a.ts', find: 'x', replace: 'y' }, { path: 'a.ts', find: 'p', replace: 'q' }] });
    expect(result.approved).toBe(true);
    expect(result.modifiedArgs).toEqual({ edits: [{ path: 'a.ts', find: 'x', replace: 'y' }] });
  });

  test('is undefined when the requestPermission handler omits it (back-compat)', async () => {
    const manager = new PermissionManager(
      async () => ({ approved: true, remember: false }),
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );

    const result = await manager.checkDetailed('edit', { edits: [{ path: 'a.ts', find: 'x', replace: 'y' }] });
    expect(result.modifiedArgs).toBeUndefined();
  });

  test('is undefined for auto-approve/read paths that never reach the user prompt', async () => {
    const configReader: PermissionConfigReader = {
      isAutoApproveEnabled: () => true,
      getWorkingDirectory: () => '/tmp/permission-tests',
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
    } as unknown as PermissionConfigReader;
    const manager = new PermissionManager(
      async () => ({ approved: true, remember: false, modifiedArgs: { edits: [] } }),
      configReader,
      makePolicyRuntimeState(),
      null,
      null,
    );

    // Auto-approve path never calls requestPermission, so modifiedArgs stays undefined
    // even though the injected handler would have returned one.
    const result = await manager.checkDetailed('read', { path: 'a.ts' });
    expect(result.approved).toBe(true);
    expect(result.modifiedArgs).toBeUndefined();
  });

  test('is undefined for the session-cache path', async () => {
    let calls = 0;
    const manager = new PermissionManager(
      async () => {
        calls += 1;
        return { approved: true, remember: true, modifiedArgs: { edits: [{ path: 'a.ts', find: 'x', replace: 'y' }] } };
      },
      makePermissionConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );

    const first = await manager.checkDetailed('edit', { path: 'a.ts', edits: [] });
    expect(first.modifiedArgs).toEqual({ edits: [{ path: 'a.ts', find: 'x', replace: 'y' }] });
    expect(calls).toBe(1);

    // Second call for the same key hits the session cache, never calling
    // requestPermission again, so modifiedArgs must be absent.
    const second = await manager.checkDetailed('edit', { path: 'a.ts', edits: [] });
    expect(calls).toBe(1);
    expect(second.modifiedArgs).toBeUndefined();
  });
});

describe('executeToolCalls uses modifiedArgs for execution but not for emitted events', () => {
  function makeDeps(overrides: {
    checkDetailed: ToolExecutionDeps['permissionManager']['checkDetailed'];
    executeSpy: (callId: string, name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  }): { deps: ToolExecutionDeps; events: Array<{ type: string; args?: unknown; approved?: unknown }> } {
    const events: Array<{ type: string; args?: unknown; approved?: unknown }> = [];
    const runtimeBus = {
      emit(_domain: string, envelope: { type?: string; payload?: Record<string, unknown> }) {
        events.push({
          type: String(envelope.type),
          args: envelope.payload?.['args'],
          approved: envelope.payload?.['approved'],
        });
      },
    } as unknown as ToolExecutionDeps['runtimeBus'];

    const toolRegistry = {
      execute: overrides.executeSpy,
    } as unknown as ToolRegistry;

    const permissionManager = {
      checkDetailed: overrides.checkDetailed,
      check: async (name: string, args: Record<string, unknown>) => (await overrides.checkDetailed(name, args)).approved,
    } as unknown as ToolExecutionDeps['permissionManager'];

    const deps: ToolExecutionDeps = {
      toolRegistry,
      permissionManager,
      hookDispatcher: null,
      runtimeBus,
      sessionId: 'sess-1',
      emitterContext: () => ({ sessionId: 'sess-1', traceId: 'trace-1', source: 'orchestrator' }),
    };
    return { deps, events };
  }

  test('toolRegistry.execute receives modifiedArgs, not the original call.arguments', async () => {
    const originalArgs = { edits: [{ path: 'a.ts', find: '1', replace: '2' }, { path: 'a.ts', find: '3', replace: '4' }, { path: 'a.ts', find: '5', replace: '6' }] };
    const modifiedArgs = { edits: [originalArgs.edits[0]] };

    let receivedArgs: Record<string, unknown> | undefined;
    const { deps, events } = makeDeps({
      checkDetailed: async () => ({
        approved: true,
        persisted: false,
        sourceLayer: 'user_prompt',
        reasonCode: 'user_approved',
        analysis: { classification: 'write', riskLevel: 'medium', summary: 'edit', reasons: [] },
        modifiedArgs,
      }),
      executeSpy: async (callId, _name, args) => {
        receivedArgs = args;
        return { callId, success: true, output: 'ok' };
      },
    });

    const call: ToolCall = { id: 'call-1', name: 'edit', arguments: originalArgs };
    const results = await executeToolCalls(deps, 'turn-1', [call]);

    expect(results[0]?.success).toBe(true);
    expect(receivedArgs).toEqual(modifiedArgs);
    expect(receivedArgs).not.toEqual(originalArgs);

    // Events must still carry the ORIGINAL args and a plain boolean approved flag.
    const received = events.find((e) => e.type === 'TOOL_RECEIVED');
    const permissioned = events.find((e) => e.type === 'TOOL_PERMISSIONED');
    expect(received?.args).toEqual(originalArgs);
    expect(permissioned?.approved).toBe(true);
  });

  test('falls back to call.arguments when checkDetailed does not return modifiedArgs', async () => {
    const originalArgs = { edits: [{ path: 'a.ts', find: '1', replace: '2' }] };
    let receivedArgs: Record<string, unknown> | undefined;
    const { deps } = makeDeps({
      checkDetailed: async () => ({
        approved: true,
        persisted: false,
        sourceLayer: 'config_policy',
        reasonCode: 'config_allow',
        analysis: { classification: 'write', riskLevel: 'low', summary: 'edit', reasons: [] },
      }),
      executeSpy: async (callId, _name, args) => {
        receivedArgs = args;
        return { callId, success: true };
      },
    });

    const call: ToolCall = { id: 'call-2', name: 'edit', arguments: originalArgs };
    await executeToolCalls(deps, 'turn-1', [call]);
    expect(receivedArgs).toEqual(originalArgs);
  });
});

describe('edit tool executes a partial edits array and FileUndoManager round-trips it', () => {
  test('applying only 2 of 3 edits leaves the 3rd substring untouched, and undo restores the original file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-partial-'));
    try {
      const filePath = join(dir, 'file.txt');
      const original = 'alpha\nbeta\ngamma\n';
      writeFileSync(filePath, original, 'utf-8');

      const fileCache = new FileStateCache();
      const fileUndoManager = new FileUndoManager();
      const editTool = createEditTool(fileCache, { cwd: dir, fileUndoManager });

      // Simulate a TUI-filtered payload: only 2 of the original 3 EditItems survive
      // per-hunk selection (the "gamma" edit was deselected).
      const filteredArgs = {
        edits: [
          { path: 'file.txt', find: 'alpha', replace: 'ALPHA' },
          { path: 'file.txt', find: 'beta', replace: 'BETA' },
        ],
      };

      const result = await editTool.execute(filteredArgs);
      expect(result.success).toBe(true);

      const afterEdit = readFileSync(filePath, 'utf-8');
      expect(afterEdit).toBe('ALPHA\nBETA\ngamma\n');
      expect(afterEdit).toContain('gamma'); // untouched, unselected hunk

      const undoResult = fileUndoManager.undo();
      expect(undoResult).not.toBeNull();
      expect(undoResult?.path).toBe(filePath);

      const afterUndo = readFileSync(filePath, 'utf-8');
      expect(afterUndo).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
