/**
 * session-modes.test.ts
 *
 * The four session permission modes (plan / normal / accept-edits / auto) as
 * first-class policy sets: the allow/refuse matrix at both the layered
 * evaluator and the authoritative PermissionManager, the structured plan-mode
 * denial, the mode-change runtime event, and the plan-mode standing
 * instruction (injected + survives compaction).
 */
import { describe, expect, test } from 'bun:test';
import { LayeredPolicyEvaluator } from '../packages/sdk/src/platform/runtime/permissions/evaluator.js';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../packages/sdk/src/platform/config/schema.js';
import { buildToolDenial, buildDenialErrorMessage, PLAN_MODE_DENIAL_REASON } from '../packages/sdk/src/platform/permissions/denial.js';
import { bindPermissionModeChangeEvent } from '../packages/sdk/src/platform/permissions/mode-change-emitter.js';
import {
  appendPlanModeInstruction,
  PLAN_MODE_INSTRUCTION_MARKER,
} from '../packages/sdk/src/platform/permissions/plan-mode-instructions.js';
import { buildReinjectedInstructions } from '../packages/sdk/src/platform/core/compaction-sections.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfigReader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/session-modes-tests',
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

/** Build a manager and record whether the user was prompted (i.e. the mode "asked"). */
function makeManager(mode: PermissionMode, promptApproves = false) {
  const prompts: string[] = [];
  const manager = new PermissionManager(
    async ({ tool }) => { prompts.push(tool); return { approved: promptApproves, remember: false }; },
    makeConfigReader(mode),
    makePolicyRuntimeState(),
    null,
    null,
  );
  return { manager, prompts };
}

// ── evaluator mode matrix ────────────────────────────────────────────────────

describe('LayeredPolicyEvaluator mode matrix', () => {
  test('plan mode allows reads and denies write/exec/delegate', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'plan' });
    expect(e.evaluate('read', { path: 'a.ts' }).allowed).toBe(true);
    expect(e.evaluate('write', { path: 'a.ts' }).allowed).toBe(false);
    expect(e.evaluate('write', { path: 'a.ts' }).reason).toBe('MODE_DENY_PLAN');
    expect(e.evaluate('exec', { command: 'ls' }).allowed).toBe(false);
    expect(e.evaluate('agent', {}).allowed).toBe(false); // escalation blocked
  });

  test('accept-edits auto-approves write/edit but still gates exec', () => {
    const e = new LayeredPolicyEvaluator({ mode: 'accept-edits', defaultEffect: 'deny' });
    const w = e.evaluate('write', { path: 'a.ts' });
    expect(w.allowed).toBe(true);
    expect(w.reason).toBe('MODE_ALLOW_ACCEPT_EDITS');
    expect(e.evaluate('edit', { path: 'a.ts' }).allowed).toBe(true);
    // exec classifies as write but is NOT a write/edit tool name → not auto-approved.
    expect(e.evaluate('exec', { command: 'rm x' }).allowed).toBe(false);
  });

  test('allow-all approves everything; default gates writes', () => {
    expect(new LayeredPolicyEvaluator({ mode: 'allow-all' }).evaluate('exec', { command: 'x' }).allowed).toBe(true);
    const def = new LayeredPolicyEvaluator({ mode: 'default', defaultEffect: 'deny' });
    expect(def.evaluate('read', {}).allowed).toBe(true);
    expect(def.evaluate('write', { path: 'a' }).allowed).toBe(false);
  });
});

// ── PermissionManager mode matrix (authoritative path) ───────────────────────

describe('PermissionManager mode matrix', () => {
  test('normal (prompt) auto-approves reads, asks for writes/exec', async () => {
    const { manager, prompts } = makeManager('prompt');
    expect((await manager.checkDetailed('read', { path: 'a' })).approved).toBe(true);
    expect(prompts).toEqual([]);
    await manager.checkDetailed('write', { path: 'a' });
    await manager.checkDetailed('exec', { command: 'ls' });
    expect(prompts).toEqual(['write', 'exec']);
  });

  test('plan mode refuses every mutating/exec/delegate tool with plan_mode; allows reads', async () => {
    const { manager, prompts } = makeManager('plan');
    expect((await manager.checkDetailed('read', { path: 'a' })).approved).toBe(true);
    for (const tool of ['write', 'edit', 'exec', 'agent']) {
      const r = await manager.checkDetailed(tool, { path: 'a', command: 'x' });
      expect(r.approved).toBe(false);
      expect(r.reasonCode).toBe('plan_mode');
      expect(r.sourceLayer).toBe('runtime_mode');
    }
    // plan refuses structurally — it never prompts the user.
    expect(prompts).toEqual([]);
  });

  test('accept-edits auto-approves write/edit, still asks for exec/delegate', async () => {
    const { manager, prompts } = makeManager('accept-edits');
    const w = await manager.checkDetailed('write', { path: 'a' });
    expect(w.approved).toBe(true);
    expect(w.reasonCode).toBe('mode_accept_edits');
    expect((await manager.checkDetailed('edit', { path: 'a' })).approved).toBe(true);
    expect(prompts).toEqual([]);
    await manager.checkDetailed('exec', { command: 'ls' });
    expect(prompts).toEqual(['exec']); // exec still asks
  });

  test('auto (allow-all) approves everything without prompting', async () => {
    const { manager, prompts } = makeManager('allow-all');
    for (const tool of ['read', 'write', 'exec', 'agent']) {
      expect((await manager.checkDetailed(tool, { command: 'x', path: 'a' })).approved).toBe(true);
    }
    expect(prompts).toEqual([]);
  });

  test('getMode reflects the configured session mode', () => {
    expect(makeManager('plan').manager.getMode()).toBe('plan');
    expect(makeManager('accept-edits').manager.getMode()).toBe('accept-edits');
  });
});

// ── structured plan-mode denial ──────────────────────────────────────────────

describe('structured plan-mode denial', () => {
  test('plan_mode reason code surfaces ToolDenial reason "plan-mode" + steering', () => {
    const denial = buildToolDenial({ reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(denial).toEqual({ denied: true, reason: PLAN_MODE_DENIAL_REASON, scope: 'runtime_mode' });
    expect(PLAN_MODE_DENIAL_REASON).toBe('plan-mode');
    const msg = buildDenialErrorMessage('exec', { reasonCode: 'plan_mode', sourceLayer: 'runtime_mode' });
    expect(msg).toContain('plan mode');
    expect(msg.toLowerCase()).toContain('present a');
  });

  test('non-plan denials pass their reason code through unchanged', () => {
    const denial = buildToolDenial({ reasonCode: 'user_denied', sourceLayer: 'user_prompt' });
    expect(denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt' });
  });
});

// ── mode-change runtime event ────────────────────────────────────────────────

describe('permission mode-change event', () => {
  test('bindPermissionModeChangeEvent emits PERMISSION_MODE_CHANGED on real transitions', () => {
    let listener: ((n: unknown, o: unknown) => void) | null = null;
    const configManager = {
      subscribe: (_key: string, cb: (n: unknown, o: unknown) => void) => { listener = cb; return () => {}; },
    };
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const bus = { emit: (channel: string, env: { payload: unknown }) => emitted.push({ channel, payload: env.payload }) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = bindPermissionModeChangeEvent(configManager as any, bus as any, 'sess-1');
    expect(typeof listener).toBe('function');

    listener!('plan', 'prompt');
    listener!('plan', 'plan'); // no-op transition — must not emit

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.channel).toBe('permissions');
    expect(emitted[0]!.payload).toMatchObject({ type: 'PERMISSION_MODE_CHANGED', mode: 'plan', previousMode: 'prompt' });
    unsub();
  });
});

// ── plan-mode instruction: injected + survives compaction ────────────────────

describe('plan-mode standing instruction', () => {
  test('appended to the system prompt only while plan mode is active', () => {
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(appendPlanModeInstruction('BASE', 'plan')).toContain('BASE');
    expect(appendPlanModeInstruction('BASE', 'prompt')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'accept-edits')).toBe('BASE');
    expect(appendPlanModeInstruction('BASE', 'allow-all')).toBe('BASE');
  });

  test('survives compaction: the instruction chain is re-injected verbatim', () => {
    // getSystemPrompt() (with plan instruction appended) is the instruction
    // chain compaction re-injects — so the plan instruction rides through.
    const chain = appendPlanModeInstruction('SYSTEM PROMPT', 'plan');
    const section = buildReinjectedInstructions(chain, undefined);
    expect(section).not.toBeNull();
    expect(section!.content).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(section!.id).toBe('reinjected-instructions');
  });
});
