/**
 * policy.ts, the per-composition postures every command in an exec call is
 * judged against, and the refusals they produce.
 *
 * Four things a composition may state about its exec tool: the boundary wiring
 * (sandbox.ts), the PTY wiring (interactive.ts), whether the boundary is
 * REQUIRED (containment.ts), and whether the owner's terminal is off limits
 * (owner-terminal-guard.ts). They travel together as one object rather than
 * four positional parameters, so the chain from `executeResolvedCommands` down
 * to `runCommand` threads one argument and a future posture is added here
 * rather than in five signatures.
 *
 * The refusal builders live here too, beside the postures they belong to, so
 * the runtime reads as "ask, and return the answer if there is one" rather than
 * carrying three refusal texts inline.
 */

import type { ExecCommandResult } from './schema.js';
import { decideExecContainment, type ExecContainmentRequirement } from './containment.js';
import { decideOwnerTerminalAccess, type OwnerTerminalGuard } from './owner-terminal-guard.js';
import type { ExecSandboxPlan, ExecSandboxRuntime } from './sandbox.js';
import type { ExecInteractionRuntime } from './interactive.js';

/** What a composition stated about its exec tool. */
export interface ExecRunPolicy {
  readonly sandbox: ExecSandboxRuntime | null;
  readonly interaction: ExecInteractionRuntime | null;
  readonly containment: ExecContainmentRequirement | null;
  readonly ownerTerminal: OwnerTerminalGuard | null;
}

/** A command that will not run, shaped like every other refusal this tool returns. */
export function refusedResult(cmdStr: string, reason: string): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: reason, success: false, denied: true };
}

/**
 * The containment verdict for one command, or null when it may run. Consulted
 * after the sandbox plan resolves, because the answer depends on whether a
 * boundary was actually applied.
 */
export function containmentRefusal(
  policy: ExecRunPolicy,
  cmdStr: string,
  plan: ExecSandboxPlan | null,
): ExecCommandResult | null {
  const decision = decideExecContainment(policy.containment, plan);
  if (decision.allowed) return null;
  return refusedResult(cmdStr, decision.refusal ?? 'Command refused: the exec boundary is required here.');
}

/** The owner-terminal verdict for one command, or null when it may run. */
export function ownerTerminalRefusal(policy: ExecRunPolicy, cmdStr: string): ExecCommandResult | null {
  const decision = decideOwnerTerminalAccess(cmdStr, policy.ownerTerminal);
  if (decision.allowed) return null;
  return refusedResult(cmdStr, decision.refusal ?? "Command refused: the owner's terminal is untouchable.");
}

/**
 * Whether a BACKGROUND command may run under this policy.
 *
 * A detached command cannot be contained at all: a bwrap boundary is
 * `--die-with-parent`, so wrapping one would kill the process the caller asked
 * to detach. A composition that requires containment therefore has no contained
 * background path, and the command is refused rather than quietly granted the
 * exemption the detach needs, `background: true` must not be the spelling that
 * gets a contained turn onto the host.
 */
export function backgroundContainmentRefusal(policy: ExecRunPolicy, cmdStr: string): ExecCommandResult | null {
  if (policy.containment?.posture !== 'required') return null;
  return refusedResult(
    cmdStr,
    'Command refused: a background command cannot run inside the exec boundary '
    + '(the boundary dies with this tool call, which would defeat the detach), and this '
    + `session requires containment, ${policy.containment.reason}\n`
    + 'Run it in the foreground, or report what you would need instead.',
  );
}
