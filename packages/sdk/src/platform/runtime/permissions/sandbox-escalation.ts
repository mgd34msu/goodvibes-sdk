/**
 * sandbox-escalation.ts — sandbox boundary escalations → the ONE approval broker.
 *
 * STANDING RULE: when the per-command exec sandbox is active and a command needs
 * host access a boundary-safe command would not (network, a host-privilege
 * escalation, a package install that reaches the network), that escalation must
 * reach the human through the SAME approval broker as a permission ask and an
 * MCP elicitation — not a separate, unrendered path and not a silent grant. This
 * module is the translation seam: it turns a sandbox escalation into a
 * `PermissionPromptRequest` (attributed to the sandbox + the specific
 * escalation) and turns the broker's approve/deny decision back into a boolean.
 * Every surface's existing approval UI then renders it and background bubbling
 * applies — one learned pattern, not five.
 *
 * The optional model-judgment tier (see sandbox-judgment.ts) rides here: when
 * enabled it annotates the ask with a proposed verdict, or — only in opt-in
 * auto-approve mode, and only for a `looks-safe` verdict — auto-approves it. It
 * NEVER converts the standing ask into a deny and NEVER touches the frozen
 * catastrophic block.
 */
import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import {
  runSandboxJudgment,
  applySandboxJudgment,
  type SandboxJudgmentProvider,
  type SandboxJudgmentConfig,
  type SandboxJudgmentReceipt,
} from './sandbox-judgment.js';

/** A sandbox escalation ask, before it becomes a broker request. */
export interface SandboxEscalationRequest {
  /** The sandbox raising the escalation (e.g. 'exec-sandbox'). */
  readonly sandbox: string;
  /** The command that needs the escalation. */
  readonly command: string;
  /** The named host-access escalations (e.g. 'wants-network'). */
  readonly escalations: readonly string[];
  /** One-line human summary of the sandbox boundary for this command. */
  readonly boundary: string;
  /** The policy reasons that produced the ask. */
  readonly policyReasons: readonly string[];
  /** The command's working directory, when known. */
  readonly workingDirectory?: string | undefined;
  /** Optional workspace context passed to the judgment tier. */
  readonly workspaceContext?: string | undefined;
}

/** The result of brokering a sandbox escalation. */
export interface SandboxEscalationOutcome {
  readonly approved: boolean;
  /** The judgment receipt, when the judgment tier ran. */
  readonly judgmentReceipt?: SandboxJudgmentReceipt | undefined;
}

/** Resolves a sandbox escalation ask to an approve/deny outcome. */
export type SandboxEscalationHandler = (
  request: SandboxEscalationRequest,
) => Promise<SandboxEscalationOutcome>;

/** The broker `requestApproval` seam this handler routes through. */
export type EscalationApprovalRequester = (input: {
  readonly request: PermissionPromptRequest;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}) => Promise<PermissionPromptDecision>;

/** Wiring for the optional model-judgment tier. */
export interface SandboxEscalationJudgment {
  readonly provider: SandboxJudgmentProvider;
  readonly config: SandboxJudgmentConfig;
  /** Called with every judgment receipt (a judgment always leaves a receipt). */
  readonly onReceipt?: ((receipt: SandboxJudgmentReceipt) => void) | undefined;
}

/**
 * Build the broker-backed sandbox-escalation handler. Every escalation becomes a
 * `PermissionPromptRequest` in the `execute` category, attributed to the sandbox
 * + escalations, and is resolved by `requestApproval`. Approve → true;
 * deny/cancel/expire → false.
 *
 * When a judgment tier is wired AND enabled, the proposed verdict either
 * auto-approves the ask (opt-in, `looks-safe` only) or annotates the reasons the
 * human sees; either way a receipt is emitted. A judgment failure degrades to a
 * plain ask.
 */
export function createSandboxEscalationApprovalHandler(
  requestApproval: EscalationApprovalRequester,
  judgment?: SandboxEscalationJudgment,
): SandboxEscalationHandler {
  return async (request) => {
    const reasons: string[] = [
      `The ${request.sandbox} sandbox boundary needs host access: ${request.escalations.join('; ')}.`,
      ...request.policyReasons,
    ];

    let judgmentReceipt: SandboxJudgmentReceipt | undefined;
    if (judgment?.config.enabled) {
      const resolved = await runSandboxJudgment(
        {
          command: request.command,
          sandboxPlan: request.boundary,
          escalations: request.escalations,
          policyReasons: request.policyReasons,
          ...(request.workspaceContext ? { workspaceContext: request.workspaceContext } : {}),
        },
        judgment.provider,
      );
      const applied = applySandboxJudgment(resolved, judgment.config, request.command);
      judgmentReceipt = applied.receipt;
      judgment.onReceipt?.(applied.receipt);

      if (applied.autoApprove) {
        // Opt-in auto-approve of a `looks-safe` verdict. The tier only ever
        // relaxes a standing ask to an allow — never allow→deny.
        return { approved: true, judgmentReceipt };
      }
      reasons.push(...applied.annotations);
    }

    const promptRequest: PermissionPromptRequest = {
      callId: `sandbox-escalation-${randomUUID().slice(0, 8)}`,
      tool: 'exec',
      args: { command: request.command },
      category: 'execute',
      analysis: {
        classification: 'sandbox-escalation',
        riskLevel: 'high',
        summary: `Sandboxed command needs host access (${request.escalations.join(', ')}): ${request.command}`,
        reasons,
        target: request.command,
        targetKind: 'command',
        surface: 'shell',
        blastRadius: 'external',
      },
      ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
      attribution: {
        kind: 'sandbox-escalation',
        sandbox: request.sandbox,
        escalations: request.escalations,
      },
    };

    const decision = await requestApproval({
      request: promptRequest,
      metadata: {
        source: 'sandbox-escalation',
        sandbox: request.sandbox,
        escalations: [...request.escalations],
        ...(judgmentReceipt ? { judgmentVerdict: judgmentReceipt.verdict } : {}),
      },
    });

    return { approved: decision.approved, ...(judgmentReceipt ? { judgmentReceipt } : {}) };
  };
}
