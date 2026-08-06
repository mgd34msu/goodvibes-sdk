/**
 * exec-posture.ts — how much authority a hosted run's exec tool carries.
 *
 * ── What went wrong ────────────────────────────────────────────────────────
 *
 * A hosted turn's exec tool is built by the same `registerAllTools` a terminal
 * calls, from the same `sandbox.*` config and the same `exec-sandbox` gate, so
 * a hosted command already ran inside the same boundary a local one does. The
 * sameness was real. The FALLBACK was not examined: with no boundary available
 * the exec tool ran the command directly on the host and labelled the result
 * afterwards, which is right for a terminal (a person asked for it and is
 * reading the answer) and wrong for a turn nobody is watching. A daemon-hosted
 * conversational turn used that path to reach the whole process table, the
 * owner's `/proc`, and his tmux session — where it typed.
 *
 * ── The two postures ───────────────────────────────────────────────────────
 *
 * `conversational` is the default and the only one reachable over the wire. The
 * boundary is REQUIRED: a command that cannot be contained is refused, naming
 * why, and the host is not a fallback available to it.
 *
 * `workstream` is a work chain the owner authorized, composed by the product
 * with the host explicitly granted. The boundary still applies wherever it is
 * available — the difference is only what happens in its absence.
 *
 * The owner's terminal is off limits in BOTH. It is not a sandbox question and
 * a boundary is not what would have stopped it: nothing this platform runs
 * types into a tmux session it did not create.
 */

import type { ExecContainmentRequirement } from '../tools/exec/containment.js';
import type { OwnerTerminalGuard } from '../tools/exec/owner-terminal-guard.js';

/** See the module header. */
export type HostedSessionExecPosture = 'conversational' | 'workstream';

/** How a product decides the posture for one session. */
export type HostedExecPostureDecider = (input: {
  readonly sessionId: string;
  readonly workspaceRoot: string;
}) => HostedSessionExecPosture;

/** The contained posture: no boundary, no command. */
export const CONVERSATIONAL_CONTAINMENT: ExecContainmentRequirement = {
  posture: 'required',
  reason:
    'this is a daemon-hosted conversational turn, and nobody is sitting at a terminal '
    + 'watching what it runs',
};

/** The granted posture: the boundary where available, the host where not. */
export const WORKSTREAM_CONTAINMENT: ExecContainmentRequirement = {
  posture: 'host-allowed',
  reason: 'this hosted workstream was composed with the host explicitly granted',
};

/** The owner's terminal is untouchable in every hosted posture. */
export const HOSTED_OWNER_TERMINAL_GUARD: OwnerTerminalGuard = { posture: 'enforced' };

/**
 * The containment requirement for a posture. `conversational` for anything
 * that is not exactly `workstream`, so an unrecognised value degrades toward
 * containment rather than toward the host.
 */
export function containmentFor(posture: HostedSessionExecPosture | undefined): ExecContainmentRequirement {
  return posture === 'workstream' ? WORKSTREAM_CONTAINMENT : CONVERSATIONAL_CONTAINMENT;
}

/**
 * Resolve the posture for one session from whatever the product stated.
 *
 * A decider that throws answers `conversational`: a composition that cannot say
 * what a run may do has not granted it anything.
 */
export function resolveHostedExecPosture(
  decide: HostedExecPostureDecider | undefined,
  input: { readonly sessionId: string; readonly workspaceRoot: string },
): HostedSessionExecPosture {
  if (!decide) return 'conversational';
  try {
    return decide(input) === 'workstream' ? 'workstream' : 'conversational';
  } catch {
    return 'conversational';
  }
}
