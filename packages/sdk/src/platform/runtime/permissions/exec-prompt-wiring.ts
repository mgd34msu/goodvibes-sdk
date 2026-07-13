/**
 * exec-prompt-wiring.ts — compose the exec PTY prompt-answer seam at the
 * runtime composition root.
 *
 * STANDING RULE: a running command that stops on a terminal prompt reaches
 * the human through the SAME approval broker as a permission ask, a sandbox
 * escalation, and an MCP elicitation — one learned pattern, not five. This
 * module turns an `ExecPromptAsk` (the detected prompt + bounded context)
 * into a `PermissionPromptRequest` attributed as `exec-prompt`; the approving
 * surface supplies the typed reply via the decision's `modifiedArgs.answer`,
 * which feeds the same continuing run. Deny (or an answer-less approval —
 * nothing is ever fabricated) declines the prompt and the run stops honestly.
 */
import { randomUUID } from 'node:crypto';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import type { ExecPromptAsk, ExecPromptAnswer } from '../../tools/exec/interactive.js';

// The ask/answer shapes the handler mediates, re-exported so this entry point
// is self-sufficient for consumers wiring the seam.
export type { ExecPromptAsk, ExecPromptAnswer } from '../../tools/exec/interactive.js';

/** The prompt-answer handler the exec tool's interactive runner invokes. */
export type ExecPromptAnswerHandler = (ask: ExecPromptAsk) => Promise<ExecPromptAnswer>;

/** The broker seam this wiring routes through. */
export interface ExecPromptWiringDeps {
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
}

/**
 * Build the exec prompt-answer handler: the pending prompt rides the approval
 * broker as an `execute`-category ask. Approval with a string
 * `modifiedArgs.answer` feeds that text to the waiting child; approval
 * without one, or denial, declines the prompt (the runner then stops the run
 * with the prompt text on the honest result).
 */
export function buildExecPromptAnswerHandler(deps: ExecPromptWiringDeps): ExecPromptAnswerHandler {
  return async (ask) => {
    const request: PermissionPromptRequest = {
      callId: `exec-prompt-${randomUUID().slice(0, 8)}`,
      tool: 'exec:prompt',
      args: {
        command: ask.command,
        prompt: ask.prompt,
        recentOutput: ask.recentOutput,
      },
      category: 'execute',
      analysis: {
        classification: 'exec-terminal-prompt',
        riskLevel: 'medium',
        summary: `A running command is waiting on its terminal: ${ask.prompt}`,
        reasons: [
          `The command \`${ask.command}\` stopped on a terminal prompt.`,
          'Approving sends your typed answer to the waiting command; declining stops the run.',
        ],
        surface: 'shell',
        blastRadius: 'project',
      },
      ...(ask.workingDirectory ? { workingDirectory: ask.workingDirectory } : {}),
      attribution: { kind: 'exec-prompt', command: ask.command, prompt: ask.prompt },
    };
    const decision = await deps.requestApproval({
      request,
      metadata: { source: 'exec-prompt', command: ask.command },
    });
    if (!decision.approved) return { answered: false };
    const answer = decision.modifiedArgs?.['answer'];
    // Never fabricate a reply the human did not type: an approval that carries
    // no text is a decline in practice, reported honestly.
    if (typeof answer !== 'string') return { answered: false };
    return { answered: true, text: answer };
  };
}
