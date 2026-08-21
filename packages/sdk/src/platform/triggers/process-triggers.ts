/**
 * process-triggers.ts, one-shot on-exit process-lifecycle triggers.
 *
 * GoodVibes launches and supervises a command; exactly one payload fires when
 * it terminates. The watcher is owned by the daemon, not by the turn that
 * created it, so a six-hour build does not have to hold an agent turn open
 * against turn timeouts, context limits and provider interruptions.
 *
 * Four rules this module exists to enforce:
 *
 *   Exit is not success. The payload carries exit code, signal, timed-out flag,
 *   duration and an output tail, and the default prompt template inspects that
 *   termination state rather than announcing a finished build.
 *
 *   Bind only to processes we launched. A trigger references a tracked-process
 *   record we created, never an arbitrary PID, PIDs are recycled, and by the
 *   time a daemon comes back a remembered PID very likely belongs to somebody
 *   else's process.
 *
 *   stdin is closed by default. An unattended command that stops to ask for a
 *   password should get EOF and fail, not block forever; a hard max-duration
 *   cap backstops the cases that ignore EOF, and it fires with an explicit
 *   `timed-out` state rather than quietly.
 *
 *   A trigger never evaporates. If the daemon restarts and the child is gone,
 *   the trigger fires once with an explicit `unknown` / `daemon-restart` state.
 *   Firing with honest uncertainty beats a watcher that silently disappears.
 */

import type {
  OnExitTriggerSpec,
  TerminationMetadata,
  TerminationReason,
  TerminationState,
  TrackedProcessRef,
} from './types.js';

export interface LaunchedProcess {
  readonly processId: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface ObservedTermination {
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly endedAt?: number | undefined;
}

/**
 * The process effects an on-exit trigger needs. Injected so the whole lifecycle
 *, launch, poll, cancel, restart reconciliation, is testable without
 * spawning anything.
 */
export interface TriggerProcessHost {
  launch(spec: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly stdin: 'none' | 'empty';
    readonly maxDurationMs: number;
  }): Promise<LaunchedProcess>;
  /** Null when the host has no record of this process at all. */
  observe(processId: string): ObservedTermination | null;
  cancel(processId: string): void;
  /**
   * Whether a remembered pid still belongs to the process we launched. Used
   * only for reporting after a restart, the trigger never re-binds to it.
   */
  isSameProcessAlive(pid: number, startedAt: number): boolean;
}

export const DEFAULT_ON_EXIT_MAX_DURATION_MS = 21_600_000; // six hours
export const DEFAULT_OUTPUT_TAIL_BYTES = 8_192;

export function tailOf(text: string, bytes: number): string {
  if (bytes <= 0 || text.length <= bytes) return text;
  return text.slice(text.length - bytes);
}

export interface LaunchOnExitInput {
  readonly spec: OnExitTriggerSpec;
  readonly host: TriggerProcessHost;
  readonly daemonBootId: string;
  readonly defaults?: {
    readonly maxDurationMs?: number | undefined;
    readonly stdin?: 'none' | 'empty' | undefined;
  } | undefined;
}

export async function launchOnExitProcess(input: LaunchOnExitInput): Promise<TrackedProcessRef> {
  const { spec, host } = input;
  const maxDurationMs = spec.maxDurationMs ?? input.defaults?.maxDurationMs ?? DEFAULT_ON_EXIT_MAX_DURATION_MS;
  const stdin = spec.stdin ?? input.defaults?.stdin ?? 'none';
  const args = spec.args ?? [];
  const launched = await host.launch({
    command: spec.command,
    args,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    stdin,
    maxDurationMs,
  });
  return {
    processId: launched.processId,
    pid: launched.pid,
    startedAt: launched.startedAt,
    command: spec.command,
    args,
    daemonBootId: input.daemonBootId,
  };
}

function classify(observed: ObservedTermination): { state: TerminationState; reason: TerminationReason } {
  if (observed.timedOut) return { state: 'timed-out', reason: 'max-duration' };
  if (observed.signal) return { state: 'signalled', reason: 'signal' };
  if (observed.exitCode === 0) return { state: 'exited', reason: 'normal' };
  return { state: 'exited', reason: 'nonzero-exit' };
}

/**
 * Builds the termination payload for a child we actually watched exit.
 * `observed: true`, every field here was measured, not inferred.
 */
export function buildTermination(input: {
  readonly process: TrackedProcessRef;
  readonly observed: ObservedTermination;
  readonly now: number;
  readonly outputTailBytes?: number | undefined;
}): TerminationMetadata {
  const { process: ref, observed } = input;
  const tailBytes = input.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
  const endedAt = observed.endedAt ?? input.now;
  const { state, reason } = classify(observed);
  return {
    state,
    reason,
    exitCode: observed.signal ? null : observed.exitCode,
    signal: observed.signal,
    timedOut: observed.timedOut,
    startedAt: ref.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - ref.startedAt),
    command: ref.command,
    args: ref.args,
    pid: ref.pid,
    stdoutTail: tailOf(observed.stdoutTail, tailBytes),
    stderrTail: tailOf(observed.stderrTail, tailBytes),
    observed: true,
  };
}

/**
 * Builds the payload for a child the daemon lost track of across a restart.
 * Everything that cannot be known is null and `observed` is false, so a prompt
 * template that inspects the payload can say "I do not know how this ended"
 * instead of inventing an exit code.
 */
export function buildDaemonRestartTermination(input: {
  readonly process: TrackedProcessRef;
  readonly now: number;
  readonly note?: string | undefined;
}): TerminationMetadata {
  const { process: ref } = input;
  return {
    state: 'unknown',
    reason: 'daemon-restart',
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt: ref.startedAt,
    endedAt: input.now,
    durationMs: Math.max(0, input.now - ref.startedAt),
    command: ref.command,
    args: ref.args,
    pid: ref.pid,
    stdoutTail: '',
    stderrTail: input.note
      ?? 'The daemon restarted while this process was supervised. Its outcome was not observed.',
    observed: false,
  };
}

export function buildCancelledTermination(input: {
  readonly process: TrackedProcessRef;
  readonly now: number;
}): TerminationMetadata {
  const { process: ref } = input;
  return {
    state: 'signalled',
    reason: 'cancelled',
    exitCode: null,
    signal: 'SIGTERM',
    timedOut: false,
    startedAt: ref.startedAt,
    endedAt: input.now,
    durationMs: Math.max(0, input.now - ref.startedAt),
    command: ref.command,
    args: ref.args,
    pid: ref.pid,
    stdoutTail: '',
    stderrTail: 'The trigger was cancelled by an operator before the process finished.',
    observed: true,
  };
}

/**
 * Recovery decision for one on-exit record found on disk.
 *
 * A record written by a previous daemon boot can never be re-observed: the
 * subprocess handle, its pipes and its exit status all died with that daemon,
 * and the pid alone is not evidence of anything. So the answer is always
 * "fire once, honestly" rather than "adopt and hope".
 */
export type OnExitRecoveryDecision =
  | { readonly action: 'resume'; readonly reason: string }
  | { readonly action: 'fire-unknown'; readonly reason: string };

export function decideOnExitRecovery(input: {
  readonly process: TrackedProcessRef;
  readonly currentBootId: string;
  readonly host?: TriggerProcessHost | undefined;
}): OnExitRecoveryDecision {
  if (input.process.daemonBootId === input.currentBootId) {
    return { action: 'resume', reason: 'same daemon boot, the supervised child is still ours to observe' };
  }
  const stillAlive = input.host?.isSameProcessAlive(input.process.pid, input.process.startedAt) === true;
  return {
    action: 'fire-unknown',
    reason: stillAlive
      ? `the daemon restarted; pid ${input.process.pid} may still be running but its exit can no longer be observed by this daemon`
      : 'the daemon restarted and the supervised child is gone; its outcome was never observed',
  };
}

// ─── Default prompt template ──────────────────────────────────────────────────

/**
 * The default agent prompt for an on-exit fire.
 *
 * Written to make the agent inspect the termination state rather than assume
 * success: the state, reason, exit code, signal and timed-out flag all appear
 * before the output, and the unknown case says outright that the outcome was
 * not observed. A template that opened with "your build finished" would be
 * wrong four times out of five states.
 */
export function renderOnExitPrompt(termination: TerminationMetadata, label: string): string {
  const argv = [termination.command, ...termination.args].join(' ');
  const headline = termination.observed
    ? `A supervised process finished. Do not assume it succeeded, read the termination state below before acting.`
    : `A supervised process's outcome is UNKNOWN. The daemon restarted while it was running, so nothing about how it ended was observed. Do not assume success or failure; verify independently before acting.`;

  const lines = [
    headline,
    '',
    `Trigger: ${label}`,
    `Command: ${argv}`,
    `Termination state: ${termination.state} (${termination.reason})`,
    `Exit code: ${termination.exitCode === null ? 'not available' : String(termination.exitCode)}`,
    `Signal: ${termination.signal ?? 'none'}`,
    `Timed out: ${termination.timedOut ? 'yes, it hit its max-duration cap and was terminated' : 'no'}`,
    `Duration: ${Math.round(termination.durationMs / 1000)}s`,
    `Outcome observed: ${termination.observed ? 'yes' : 'no'}`,
    '',
  ];

  if (termination.stdoutTail.trim().length > 0) {
    lines.push('--- stdout tail ---', termination.stdoutTail.trimEnd(), '');
  }
  if (termination.stderrTail.trim().length > 0) {
    lines.push('--- stderr tail ---', termination.stderrTail.trimEnd(), '');
  }
  lines.push(
    termination.observed
      ? 'Decide what the termination state above actually means for this task, then act on that.'
      : 'Establish the real outcome first (check artifacts, logs, or re-run a cheap verification), then act on what you find.',
  );
  return lines.join('\n');
}
