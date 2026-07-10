/**
 * background-agent-permissions.test.ts
 *
 * Background/subagent tool calls are brokered through the SAME session
 * permission mode as the foreground turn loop (config permissions.mode), with
 * the escape hatch config permissions.backgroundAgents ('inherit' | 'allow-all').
 * Covers: each mode's background allow/ask/refuse behavior, subagent attribution
 * riding on a brokered ask, structured ToolDenial reaching the subagent result,
 * and the allow-all exemption.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode, BackgroundAgentsMode } from '../packages/sdk/src/platform/config/schema.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';
import { gateBackgroundToolCall } from '../packages/sdk/src/platform/agents/background-permission-gate.js';
import { PLAN_MODE_DENIAL_REASON } from '../packages/sdk/src/platform/permissions/denial.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfigReader(mode: PermissionMode, backgroundAgents: BackgroundAgentsMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/background-permission-tests',
    getSnapshot: () => ({ permissions: { mode, backgroundAgents, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

/** Build a manager and capture every ask (with its full request payload). */
function makeManager(
  mode: PermissionMode,
  backgroundAgents: BackgroundAgentsMode,
  promptApproves = false,
) {
  const asks: PermissionPromptRequest[] = [];
  const manager = new PermissionManager(
    async (request) => { asks.push(request); return { approved: promptApproves, remember: false }; },
    makeConfigReader(mode, backgroundAgents),
    makePolicyRuntimeState(),
    null,
    null,
  );
  return { manager, asks };
}

const record = { id: 'agent-42', template: 'engineer' } as const;

// ── mode matrix (inherit) ────────────────────────────────────────────────────

describe('background permission gate — inherit applies the session mode', () => {
  test('allow-all session mode: everything auto-approves, no ask', async () => {
    const { manager, asks } = makeManager('allow-all', 'inherit');
    const outcome = await gateBackgroundToolCall({ permissionManager: manager }, record, 'exec', { command: 'ls' });
    expect(outcome.approved).toBe(true);
    expect(asks).toEqual([]);
  });

  test('prompt mode: reads auto-approve, writes/exec broker an ask', async () => {
    const { manager, asks } = makeManager('prompt', 'inherit', true);
    const read = await gateBackgroundToolCall({ permissionManager: manager }, record, 'read', { path: 'a.ts' });
    expect(read.approved).toBe(true);
    expect(asks).toEqual([]); // reads never ask

    const write = await gateBackgroundToolCall({ permissionManager: manager }, record, 'write', { path: 'a.ts' });
    expect(write.approved).toBe(true); // handler approved
    expect(asks).toHaveLength(1);
    expect(asks[0]!.tool).toBe('write');
  });

  test('plan mode: mutating tools are refused with a structured plan-mode denial', async () => {
    const { manager } = makeManager('plan', 'inherit');
    const outcome = await gateBackgroundToolCall({ permissionManager: manager }, record, 'write', { path: 'a.ts' });
    expect(outcome.approved).toBe(false);
    if (outcome.approved) throw new Error('expected refusal');
    expect(outcome.denial.denied).toBe(true);
    expect(outcome.denial.reason).toBe(PLAN_MODE_DENIAL_REASON);
    expect(outcome.error).toContain('plan mode');
  });

  test('accept-edits mode: write auto-approves, exec still asks', async () => {
    const { manager, asks } = makeManager('accept-edits', 'inherit', false);
    const write = await gateBackgroundToolCall({ permissionManager: manager }, record, 'write', { path: 'a.ts' });
    expect(write.approved).toBe(true);
    expect(asks).toEqual([]);

    const exec = await gateBackgroundToolCall({ permissionManager: manager }, record, 'exec', { command: 'rm x' });
    expect(exec.approved).toBe(false); // handler denied
    expect(asks).toHaveLength(1);
    expect(asks[0]!.tool).toBe('exec');
  });
});

// ── escape hatch ──────────────────────────────────────────────────────────────

describe('background permission gate — allow-all escape hatch exempts background agents', () => {
  test('backgroundAgents=allow-all approves even when the session mode would ask', async () => {
    const { manager, asks } = makeManager('prompt', 'allow-all', false);
    const outcome = await gateBackgroundToolCall({ permissionManager: manager }, record, 'exec', { command: 'ls' });
    expect(outcome.approved).toBe(true);
    expect(asks).toEqual([]); // exempt — never brokered
  });

  test('backgroundAgents=allow-all bypasses even a plan-mode refusal', async () => {
    const { manager } = makeManager('plan', 'allow-all');
    const outcome = await gateBackgroundToolCall({ permissionManager: manager }, record, 'write', { path: 'a.ts' });
    expect(outcome.approved).toBe(true);
  });
});

// ── attribution ────────────────────────────────────────────────────────────────

describe('background permission gate — subagent attribution rides on the ask', () => {
  test('a brokered background ask carries the subagent id + template', async () => {
    const { manager, asks } = makeManager('prompt', 'inherit', true);
    await gateBackgroundToolCall({ permissionManager: manager }, record, 'write', { path: 'a.ts' });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.attribution).toEqual({
      kind: 'background-agent',
      agentId: 'agent-42',
      template: 'engineer',
    });
  });

  test('template is omitted from attribution when the record has none', async () => {
    const { manager, asks } = makeManager('prompt', 'inherit', true);
    await gateBackgroundToolCall({ permissionManager: manager }, { id: 'agent-7' }, 'write', { path: 'a.ts' });
    expect(asks[0]!.attribution).toEqual({ kind: 'background-agent', agentId: 'agent-7' });
  });
});

// ── ungated fallback ────────────────────────────────────────────────────────────

describe('background permission gate — no manager leaves the call ungated', () => {
  test('absent permissionManager approves without consulting anything', async () => {
    const outcome = await gateBackgroundToolCall({ permissionManager: undefined }, record, 'exec', { command: 'ls' });
    expect(outcome.approved).toBe(true);
  });
});
