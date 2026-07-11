/**
 * sandbox-judgment.ts — the model-judgment tier for the residual sandbox
 * ask-tail.
 *
 * When the per-command exec sandbox is active and a command STILL lands on
 * "ask" (a boundary that needs host access — network, host-privilege
 * escalation), an optional model-judgment pass takes the command, its sandbox
 * plan, workspace context, and the policy reasons and produces a PROPOSED
 * verdict with stated reasons. Its verdict either annotates the ask shown to the
 * human, or — only when the operator has opted into auto-approve mode —
 * auto-approves the ask.
 *
 * FROZEN CATASTROPHIC BLOCK / ALLOW→DENY INVARIANT. Recorded doctrine, verbatim:
 * "permission settings are the sole authority for command-class risk; the
 * exec-layer unconditional block is a frozen catastrophic-only list (rm -rf /,
 * dd to devices, mkfs, fork bomb…) that must NEVER expand without Mike's
 * explicit approval." Accordingly this tier NEVER converts an allow into a deny
 * and NEVER inspects, relaxes, or re-implements the frozen catastrophic block
 * (that block is enforced independently, at exec time, and stays in force
 * identically inside the boundary). The judgment can only RELAX a standing "ask"
 * to an allow (auto-approve, and only on a `looks-safe` verdict when the
 * operator opted in) or ANNOTATE it for the human. A `flags-risk` verdict never
 * denies on its own — it annotates the human ask, which the human still decides.
 */

import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** The proposed verdict a judgment pass produces. */
export type SandboxJudgmentVerdict = 'looks-safe' | 'flags-risk' | 'unavailable';

/** Everything the judgment pass reasons over. */
export interface SandboxJudgmentInput {
  /** The command that landed on ask. */
  readonly command: string;
  /** One-line human summary of the sandbox boundary for this command. */
  readonly sandboxPlan: string;
  /** The named host-access escalations that kept it on ask. */
  readonly escalations: readonly string[];
  /** Optional workspace context (root, project type) for the model. */
  readonly workspaceContext?: string | undefined;
  /** The policy reasons that produced the ask. */
  readonly policyReasons: readonly string[];
}

/** A provider's PROPOSED verdict — it never carries a deny/allow enforcement. */
export interface SandboxJudgmentProposal {
  readonly verdict: 'looks-safe' | 'flags-risk';
  readonly reasons: readonly string[];
}

/** The provider call producing a proposed verdict. May throw / be unavailable. */
export type SandboxJudgmentProvider = (
  input: SandboxJudgmentInput,
) => Promise<SandboxJudgmentProposal>;

/** The resolved judgment: the proposed verdict plus a human-facing annotation. */
export interface SandboxJudgmentResult {
  readonly verdict: SandboxJudgmentVerdict;
  readonly reasons: readonly string[];
  /** "model judgment: looks safe because… / flags risk because…" — empty when unavailable. */
  readonly annotation: string;
}

/** How the judgment tier affected the ask. */
export type SandboxJudgmentOutcome = 'annotated' | 'auto-approved' | 'degraded-to-ask';

/** The receipt every judgment leaves. */
export interface SandboxJudgmentReceipt {
  readonly command: string;
  readonly verdict: SandboxJudgmentVerdict;
  readonly reasons: readonly string[];
  /** What happened to the ask as a result of the judgment. */
  readonly outcome: SandboxJudgmentOutcome;
}

/** Config controlling the judgment tier. Gated by the `sandbox-model-judgment` flag. */
export interface SandboxJudgmentConfig {
  /** Whether the tier runs at all (the flag + config are already ANDed by the caller). */
  readonly enabled: boolean;
  /**
   * When true, a `looks-safe` verdict AUTO-APPROVES the ask (opt-in). Default
   * false → annotate-only: the verdict is shown to the human, who still decides.
   */
  readonly autoApprove: boolean;
}

/** A minimal chat call the judgment provider adapter drives. */
export type SandboxJudgmentChat = (prompt: string) => Promise<string>;

/** Build the prompt the judgment model answers. */
function buildJudgmentPrompt(input: SandboxJudgmentInput): string {
  return (
    'You are assessing whether a shell command that will run INSIDE an OS sandbox '
    + 'boundary, but needs host access the boundary would otherwise block, looks safe '
    + 'to allow. You are ADVISORY ONLY: you propose a verdict for a human; you never '
    + 'enforce. Reply with a single JSON object: '
    + '{"verdict":"looks-safe"|"flags-risk","reasons":["…"]}.\n\n'
    + `Command: ${input.command}\n`
    + `Sandbox boundary: ${input.sandboxPlan}\n`
    + `Host-access escalations: ${input.escalations.join('; ')}\n`
    + (input.workspaceContext ? `Workspace: ${input.workspaceContext}\n` : '')
    + `Policy reasons for the ask: ${input.policyReasons.join('; ')}`
  );
}

/**
 * Adapt a chat call into a {@link SandboxJudgmentProvider}. Parses the model's
 * JSON verdict; a malformed or off-contract reply throws, which
 * {@link runSandboxJudgment} treats as unavailable (degrade to plain ask).
 */
export function createSandboxJudgmentProvider(chat: SandboxJudgmentChat): SandboxJudgmentProvider {
  return async (input) => {
    const raw = await chat(buildJudgmentPrompt(input));
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('judgment reply had no JSON object');
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reasons?: unknown };
    if (parsed.verdict !== 'looks-safe' && parsed.verdict !== 'flags-risk') {
      throw new Error(`judgment reply had an off-contract verdict: ${String(parsed.verdict)}`);
    }
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    return { verdict: parsed.verdict, reasons };
  };
}

function buildAnnotation(proposal: SandboxJudgmentProposal): string {
  const because = proposal.reasons.length > 0 ? proposal.reasons.join('; ') : '(no reason given)';
  const lead = proposal.verdict === 'looks-safe' ? 'looks safe because' : 'flags risk because';
  return `model judgment: ${lead} ${because}`;
}

/**
 * Run the judgment pass. Degrades to an `unavailable` result (empty annotation)
 * on any provider failure — the caller then falls back to a plain ask, never a
 * blocked or auto-denied one.
 */
export async function runSandboxJudgment(
  input: SandboxJudgmentInput,
  provider: SandboxJudgmentProvider,
): Promise<SandboxJudgmentResult> {
  try {
    const proposal = await provider(input);
    if (proposal.verdict !== 'looks-safe' && proposal.verdict !== 'flags-risk') {
      // A provider that returns an out-of-contract verdict is treated as unavailable.
      return { verdict: 'unavailable', reasons: [], annotation: '' };
    }
    return {
      verdict: proposal.verdict,
      reasons: proposal.reasons,
      annotation: buildAnnotation(proposal),
    };
  } catch (err) {
    logger.warn('[sandbox-judgment] provider unavailable; degrading to plain ask', {
      error: summarizeError(err),
    });
    return { verdict: 'unavailable', reasons: [], annotation: '' };
  }
}

/**
 * Decide how a resolved judgment affects the ask, WITHOUT ever converting an
 * allow into a deny. Returns whether the ask is auto-approved, the reason lines
 * to ANNOTATE onto the human ask (empty when auto-approving or unavailable), and
 * the receipt.
 *
 * INVARIANT: `autoApprove` is true only for a `looks-safe` verdict AND only when
 * the operator opted into auto-approve mode. Every other case leaves the human
 * ask standing (annotated when the verdict is available). A `flags-risk` verdict
 * NEVER auto-denies — it annotates, and the human decides.
 */
export function applySandboxJudgment(
  result: SandboxJudgmentResult,
  config: SandboxJudgmentConfig,
  command: string,
): {
  readonly autoApprove: boolean;
  readonly annotations: readonly string[];
  readonly receipt: SandboxJudgmentReceipt;
} {
  if (result.verdict === 'unavailable') {
    return {
      autoApprove: false,
      annotations: [],
      receipt: { command, verdict: 'unavailable', reasons: [], outcome: 'degraded-to-ask' },
    };
  }

  const canAutoApprove = config.autoApprove && result.verdict === 'looks-safe';
  if (canAutoApprove) {
    return {
      autoApprove: true,
      annotations: [],
      receipt: { command, verdict: result.verdict, reasons: result.reasons, outcome: 'auto-approved' },
    };
  }

  // Annotate-only (the default) — the human ask stands, carrying the verdict.
  return {
    autoApprove: false,
    annotations: [result.annotation],
    receipt: { command, verdict: result.verdict, reasons: result.reasons, outcome: 'annotated' },
  };
}
