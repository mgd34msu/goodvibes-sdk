/**
 * sandbox-escalation-judgment.test.ts
 *
 * The per-command exec sandbox routes its host-access escalations through the
 * ONE approval broker (same request shape + attribution as a permission ask and
 * an MCP elicitation), and an optional model-judgment tier annotates or
 * (opt-in) auto-approves the residual ask WITHOUT ever converting allow→deny or
 * touching the frozen catastrophic block. Pins: broker attribution, approve/deny
 * passthrough, annotate-only default, auto-approve opt-in path, frozen-list /
 * allow→deny invariant, and judgment-failure degrade-to-plain-ask.
 */
import { describe, expect, test } from 'bun:test';
import {
  createSandboxEscalationApprovalHandler,
  type EscalationApprovalRequester,
} from '../packages/sdk/src/platform/runtime/permissions/sandbox-escalation.js';
import {
  applySandboxJudgment,
  runSandboxJudgment,
  createSandboxJudgmentProvider,
  type SandboxJudgmentProvider,
  type SandboxJudgmentResult,
  type SandboxJudgmentReceipt,
} from '../packages/sdk/src/platform/runtime/permissions/sandbox-judgment.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.js';
import { detectSandboxAvailability, type ExecSandboxRuntime } from '../packages/sdk/src/platform/tools/exec/sandbox.js';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';

// A requestApproval spy that records the request and returns a fixed decision.
function spyApproval(approved: boolean) {
  const seen: PermissionPromptRequest[] = [];
  const requester: EscalationApprovalRequester = async ({ request }) => {
    seen.push(request);
    return { approved };
  };
  return { requester, seen };
}

const ESC = ['wants-network'];
function req() {
  return {
    sandbox: 'exec-sandbox',
    command: 'curl https://example.com',
    escalations: ESC,
    boundary: 'bubblewrap: workspace writable, network disabled',
    policyReasons: ['runs inside the sandbox boundary but needs host access: wants-network'],
    workingDirectory: '/work',
  };
}

const looksSafe: SandboxJudgmentProvider = async () => ({ verdict: 'looks-safe', reasons: ['read-only fetch of a public URL'] });
const flagsRisk: SandboxJudgmentProvider = async () => ({ verdict: 'flags-risk', reasons: ['exfiltration risk'] });
const throwing: SandboxJudgmentProvider = async () => { throw new Error('provider down'); };

// ── 3a: broker routing + attribution ─────────────────────────────────────────

describe('sandbox escalation → approval broker', () => {
  test('builds a broker request attributed to the sandbox + escalations', async () => {
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester);
    const outcome = await handler(req());
    expect(outcome.approved).toBe(true);
    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect(r.tool).toBe('exec');
    expect(r.category).toBe('execute');
    expect(r.attribution).toEqual({ kind: 'sandbox-escalation', sandbox: 'exec-sandbox', escalations: ESC });
    expect(r.analysis.classification).toBe('sandbox-escalation');
    expect(r.args).toEqual({ command: 'curl https://example.com' });
    expect(r.workingDirectory).toBe('/work');
  });

  test('a broker denial maps to not-approved', async () => {
    const { requester } = spyApproval(false);
    const handler = createSandboxEscalationApprovalHandler(requester);
    expect((await handler(req())).approved).toBe(false);
  });
});

// ── 3b: judgment tier — annotate-only default ────────────────────────────────

describe('sandbox judgment tier', () => {
  test('annotate-only default: looks-safe still asks the human, ask carries the annotation', async () => {
    const { requester, seen } = spyApproval(true);
    const receipts: SandboxJudgmentReceipt[] = [];
    const handler = createSandboxEscalationApprovalHandler(requester, {
      provider: looksSafe,
      config: { enabled: true, autoApprove: false },
      onReceipt: (r) => receipts.push(r),
    });
    const outcome = await handler(req());
    expect(seen).toHaveLength(1); // the human was still asked
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('model judgment: looks safe because'))).toBe(true);
    expect(outcome.judgmentReceipt?.outcome).toBe('annotated');
    expect(receipts[0]!.outcome).toBe('annotated');
  });

  test('auto-approve opt-in: looks-safe auto-approves WITHOUT prompting, leaves a receipt', async () => {
    const { requester, seen } = spyApproval(false); // would deny if asked — proves we did NOT ask
    const handler = createSandboxEscalationApprovalHandler(requester, {
      provider: looksSafe,
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    expect(outcome.approved).toBe(true);
    expect(seen).toHaveLength(0); // auto-approved: no human prompt
    expect(outcome.judgmentReceipt?.outcome).toBe('auto-approved');
  });

  test('frozen-list / allow→deny invariant: flags-risk NEVER auto-denies, even in auto-approve mode', async () => {
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      provider: flagsRisk,
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    // flags-risk does not auto-approve AND does not auto-deny — the human is asked.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('model judgment: flags risk because'))).toBe(true);
    expect(outcome.judgmentReceipt?.outcome).toBe('annotated');
    expect(outcome.approved).toBe(true); // the human's decision stands, not the model's
  });

  test('judgment failure degrades to a plain ask (no annotation, degraded receipt)', async () => {
    const { requester, seen } = spyApproval(true);
    const handler = createSandboxEscalationApprovalHandler(requester, {
      provider: throwing,
      config: { enabled: true, autoApprove: true },
    });
    const outcome = await handler(req());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.analysis.reasons.some((x) => x.includes('model judgment'))).toBe(false);
    expect(outcome.judgmentReceipt?.outcome).toBe('degraded-to-ask');
    expect(outcome.approved).toBe(true);
  });

  test('disabled tier does not run the provider at all', async () => {
    const { requester, seen } = spyApproval(true);
    let called = false;
    const handler = createSandboxEscalationApprovalHandler(requester, {
      provider: async () => { called = true; return { verdict: 'looks-safe', reasons: [] }; },
      config: { enabled: false, autoApprove: true },
    });
    await handler(req());
    expect(called).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

// ── exec-runtime wiring: a denied escalation blocks the command (no spawn) ───

describe('exec runtime raises the escalation through the injected seam', () => {
  // Fabricate an available sandbox WITHOUT a real bwrap spawn: a denied
  // escalation returns before any process is spawned, so the fake bwrap path is
  // never executed on any host.
  const availability = detectSandboxAvailability({
    platform: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapWorks: true, netUnshareWorks: true,
  });

  test('a command that wants network is denied when requestEscalation refuses', async () => {
    let asked: { command: string; escalations: readonly string[] } | null = null;
    const sandbox: ExecSandboxRuntime = {
      config: { enabled: true, egressAllowlist: [], workspaceWritable: [] },
      availability,
      featureEnabled: true,
      requestEscalation: async (input) => { asked = { command: input.command, escalations: input.escalations }; return false; },
    };
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: process.cwd() }),
      sandbox,
    });
    const result = await tool.execute({ working_dir: process.cwd(), commands: [{ cmd: 'curl https://example.com' }] });
    expect(asked).not.toBeNull();
    expect(asked!.escalations.length).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    const output = JSON.parse(result.output ?? '{}') as { commands?: Array<{ stderr?: string }>; stderr?: string };
    const cmd0 = output.commands?.[0] ?? output;
    expect(cmd0.stderr).toContain('Sandbox escalation denied');
  });
});

// ── applySandboxJudgment unit invariants ─────────────────────────────────────

describe('applySandboxJudgment invariants', () => {
  const mk = (verdict: SandboxJudgmentResult['verdict']): SandboxJudgmentResult =>
    ({ verdict, reasons: ['r'], annotation: verdict === 'unavailable' ? '' : `model judgment: ${verdict}` });

  test('looks-safe + autoApprove → auto-approves', () => {
    const a = applySandboxJudgment(mk('looks-safe'), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(true);
    expect(a.receipt.outcome).toBe('auto-approved');
  });
  test('looks-safe + annotate-only → annotates, does not auto-approve', () => {
    const a = applySandboxJudgment(mk('looks-safe'), { enabled: true, autoApprove: false }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.annotations.length).toBeGreaterThan(0);
    expect(a.receipt.outcome).toBe('annotated');
  });
  test('flags-risk + autoApprove → NEVER auto-approves (annotates)', () => {
    const a = applySandboxJudgment(mk('flags-risk'), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.receipt.outcome).toBe('annotated');
  });
  test('unavailable → degrade-to-ask, no auto-approve, no annotation', () => {
    const a = applySandboxJudgment(mk('unavailable'), { enabled: true, autoApprove: true }, 'cmd');
    expect(a.autoApprove).toBe(false);
    expect(a.annotations).toHaveLength(0);
    expect(a.receipt.outcome).toBe('degraded-to-ask');
  });
});

// ── provider adapter parse ───────────────────────────────────────────────────

describe('createSandboxJudgmentProvider', () => {
  const input = {
    command: 'curl x', sandboxPlan: 'p', escalations: ESC, policyReasons: ['r'],
  };
  test('parses a JSON verdict reply', async () => {
    const p = createSandboxJudgmentProvider(async () => 'sure: {"verdict":"looks-safe","reasons":["ok"]}');
    const r = await runSandboxJudgment(input, p);
    expect(r.verdict).toBe('looks-safe');
    expect(r.reasons).toEqual(['ok']);
  });
  test('an off-contract reply is treated as unavailable (degrade to ask)', async () => {
    const p = createSandboxJudgmentProvider(async () => '{"verdict":"definitely-deny"}');
    const r = await runSandboxJudgment(input, p);
    expect(r.verdict).toBe('unavailable');
  });
  test('a no-JSON reply is treated as unavailable', async () => {
    const p = createSandboxJudgmentProvider(async () => 'I cannot answer');
    const r = await runSandboxJudgment(input, p);
    expect(r.verdict).toBe('unavailable');
  });
});
