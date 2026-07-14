/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Observed foreign coding-agent -> ProcessNode. An externally-launched Claude
 * Code / Codex / opencode session goodvibes did NOT spawn or host appears as a
 * fleet row whose FIRST job is visibility. It is never killable/interruptible
 * (observing is not owning the lifecycle), it carries an honest external kind +
 * pid + cwd + start time + liveness, and it is steerable only when the session
 * exposes a genuine channel (a tmux pane) — with the steer weighted as a
 * drill-in capability, never a primary affordance (see ProcessObserved).
 */
import type { ObservedAgentRow, ObservedAgentSource } from '../observed/source.js';
import type { ProcessNode, ProcessState, SteerResult } from '../types.js';

/** Observed node ids are namespaced by pid to avoid colliding with agent/process ids. */
export function observedNodeId(pid: number): string {
  return `observed:${pid}`;
}

const KIND_LABEL: Record<ObservedAgentRow['externalKind'], string> = {
  'claude-code': 'Claude Code (external)',
  codex: 'Codex (external)',
  opencode: 'opencode (external)',
  unknown: 'External coding agent',
};

/**
 * Coarse state from read-only liveness ONLY: `active` (CPU advanced) -> the
 * generic working state `executing-tool` (same mapping acp-host uses for a
 * prompting session), `quiet` -> `idle`. This is a projection of CPU liveness,
 * NOT a claim about the foreign agent's internal phase — the honest detail lives
 * in observed.liveness. The state flip is what wakes fleet subscribers on a
 * liveness transition.
 */
function observedState(row: ObservedAgentRow): ProcessState {
  return row.liveness.state === 'active' ? 'executing-tool' : 'idle';
}

/** ObservedAgentRow -> ProcessNode. */
export function adaptObservedAgent(row: ObservedAgentRow, now: number): ProcessNode {
  const state = observedState(row);
  const steerable = row.steer.kind === 'tmux';
  const startedAt = row.startedAt;
  return {
    id: observedNodeId(row.pid),
    kind: 'observed-external',
    label: KIND_LABEL[row.externalKind],
    task: row.cwd,
    state,
    startedAt,
    elapsedMs: startedAt !== undefined ? Math.max(0, now - startedAt) : 0,
    // Foreign agents do not report token usage to us — honest absence.
    usage: undefined,
    costUsd: null,
    costState: 'unpriced',
    currentActivity: { kind: 'output-line', text: row.liveness.detail, at: now },
    capabilities: {
      // Observing/steering a foreign session is not owning its lifecycle: stop
      // is never offered. Steer is available only over a genuine channel.
      interruptible: false,
      killable: false,
      pausable: false,
      resumable: false,
      steerable,
    },
    observed: {
      externalKind: row.externalKind,
      pid: row.pid,
      ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
      liveness: row.liveness,
      steer: row.steer,
      steerDrillInOnly: true,
    },
    raw: row,
  };
}

/**
 * Registry steer dispatch for an observed-external node: the steer travels over
 * the foreign session's own channel (tmux send-keys). Honest refusal when no
 * source is composed or the row exposes no channel.
 */
export function steerObservedNode(
  source: Pick<ObservedAgentSource, 'steer'> | undefined,
  node: ProcessNode,
  text: string,
): SteerResult {
  if (!source) return { queued: false, reason: 'no observed-agent source configured' };
  return source.steer(node.raw as ObservedAgentRow, text);
}
