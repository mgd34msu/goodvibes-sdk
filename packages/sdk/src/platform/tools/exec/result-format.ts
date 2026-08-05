/**
 * Exec result formatting — turns an ExecCommandResult into the record the tool
 * returns, honoring the caller's verbosity.
 *
 * Split out of runtime.ts so the denial branch below has room to state its
 * reasoning; runtime.ts is at a shrink-only line ceiling.
 *
 * Shaping rule for this module: it may show LESS, but it may never let the
 * caller believe it showed everything. `minimal` used to return
 * `stdout.split('\n')[0]` bare, so a 42-line device listing arrived as one line
 * that read exactly like a complete answer, and the reader concluded the other
 * 41 devices did not exist. Every drop this module performs — line clamping for
 * verbosity, or an upstream overflow cut — now leaves a counted marker in the
 * stream text itself, at every verbosity, for stdout and stderr both.
 */
import type { ExecCommandResult, ExecVerbosity } from './schema.js';

/**
 * How many leading lines of a stream each verbosity keeps; `null` keeps all.
 * The dropped remainder is never silent — see {@link shapeStream}.
 */
const LINES_KEPT: Record<ExecVerbosity, number | null> = {
  count_only: 0,
  minimal: 1,
  standard: null,
  verbose: null,
};

/**
 * Shape one stream for a verbosity and disclose whatever the shaping removed.
 *
 * Two different things can remove content, and both used to be invisible at
 * `minimal`:
 *  - verbosity line clamping (this function), and
 *  - the upstream overflow cut that sets `stdout_truncated`/`stderr_truncated`
 *    (runtime.ts `truncate`), which `minimal` did not even forward as a flag.
 *
 * A trailing newline is not counted as a line, so the reported count is the
 * number of real lines the caller cannot see.
 *
 * @param text              - The full stream text as captured.
 * @param stream            - Which stream, named in the marker.
 * @param keptLines         - Leading lines to keep, or null for all.
 * @param overflowTruncated - Whether the stream was already cut for size.
 * @returns The shaped text (markers appended) and the dropped line count.
 */
export function shapeStream(
  text: string,
  stream: 'stdout' | 'stderr',
  keptLines: number | null,
  overflowTruncated: boolean,
): { text: string; droppedLines: number } {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body === '' ? [] : body.split('\n');
  const kept = keptLines === null ? lines : lines.slice(0, keptLines);
  const droppedLines = lines.length - kept.length;

  const markers: string[] = [];
  if (droppedLines > 0) {
    const plural = droppedLines === 1 ? '' : 's';
    markers.push(
      kept.length === 0
        ? `[${droppedLines} ${stream} line${plural} omitted — raise verbosity or add a filter]`
        : `[+${droppedLines} more ${stream} line${plural} — raise verbosity or add a filter]`,
    );
  }
  if (overflowTruncated) {
    markers.push(
      `[${stream} was cut at the output size limit and is incomplete — narrow the command or read the overflow file]`,
    );
  }

  if (markers.length === 0) return { text: kept.join('\n'), droppedLines };
  const shown = kept.join('\n');
  return {
    text: shown === '' ? markers.join('\n') : `${shown}\n${markers.join('\n')}`,
    droppedLines,
  };
}

/**
 * The sandbox fields to carry through at every verbosity.
 *
 * These used to survive only under `verbose`, so at the default verbosity a
 * command that ran inside the boundary looked exactly like one that ran on the
 * host. That is how sandbox blindness gets read as host truth: `bluetoothctl`
 * missing inside the boundary is not `bluetoothctl` missing on the machine.
 */
function sandboxFields(result: ExecCommandResult): Record<string, unknown> {
  if (result.sandboxed === undefined) return {};
  return {
    sandboxed: result.sandboxed,
    ...(result.sandbox_boundary && { sandbox_boundary: result.sandbox_boundary }),
    ...(result.sandbox_note && { sandbox_note: result.sandbox_note }),
    ...(result.sandbox_network && { sandbox_network: result.sandbox_network }),
    ...(result.sandbox_escalations?.length && { sandbox_escalations: result.sandbox_escalations }),
  };
}

export function formatResult(result: ExecCommandResult, verbosity: ExecVerbosity): Record<string, unknown> {
  if (result.skipped) {
    return { cmd: result.cmd, success: false, skipped: true };
  }

  // A denial is not command output, so verbosity must not shorten it: nothing
  // ran, and the reason is the entire result. Under `minimal` the reason was
  // cut to its first line and under `count_only` it was dropped altogether,
  // leaving the caller told only that something failed. Report the full reason
  // and the per-segment detail at every verbosity.
  if (result.denied) {
    const detail = result.denial_detail as Record<string, unknown> | undefined;
    return {
      cmd: result.cmd,
      exit_code: result.exit_code,
      success: false,
      denied: true,
      // `stderr` stays populated so existing consumers keep reading the reason
      // where they always have; `denial_reason` adds the same text under a name
      // that says what it is, alongside the structured segment breakdown.
      stderr: result.stderr,
      denial_reason: result.stderr || 'Command denied by policy',
      ...(detail?.segments ? { segments: detail.segments } : {}),
      ...(detail?.ast_mode !== undefined ? { ast_mode: detail.ast_mode } : {}),
    };
  }

  const keptLines = LINES_KEPT[verbosity] ?? null;
  const stdout = shapeStream(result.stdout, 'stdout', keptLines, result.stdout_truncated === true);
  const stderr = shapeStream(result.stderr, 'stderr', keptLines, result.stderr_truncated === true);

  switch (verbosity) {
    case 'count_only':
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        // Counts only — but a dropped stream still says so, with its count.
        ...(stdout.text !== '' && { stdout: stdout.text }),
        ...(stderr.text !== '' && { stderr: stderr.text }),
        ...(stdout.droppedLines > 0 && { stdout_dropped_lines: stdout.droppedLines }),
        ...(stderr.droppedLines > 0 && { stderr_dropped_lines: stderr.droppedLines }),
        ...(result.stdout_truncated && { stdout_truncated: true }),
        ...(result.stderr_truncated && { stderr_truncated: true }),
        ...sandboxFields(result),
      };
    case 'minimal': {
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(stdout.droppedLines > 0 && { stdout_dropped_lines: stdout.droppedLines }),
        ...(stderr.droppedLines > 0 && { stderr_dropped_lines: stderr.droppedLines }),
        // Forwarded at minimal too: an overflow cut is a drop the caller must
        // see regardless of how quiet it asked the output to be.
        ...(result.stdout_truncated && { stdout_truncated: true }),
        ...(result.stderr_truncated && { stderr_truncated: true }),
        ...(result.expectation_error && { expectation_error: result.expectation_error }),
        ...(result.timed_out && { timed_out: true }),
        ...(result.cancelled && { cancelled: true }),
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.progress_file && { progress_file: result.progress_file }),
        ...(result.warnings && { warnings: result.warnings }),
        ...(result.withheld_env && result.withheld_env.length > 0 && { withheld_env: result.withheld_env }),
        ...(result.pending_prompt && { pending_prompt: result.pending_prompt }),
        ...(result.prompt_declined && { prompt_declined: true }),
        ...sandboxFields(result),
      };
    }
    case 'verbose':
      // Everything, plus the overflow marker inside the stream text: `verbose`
      // can still be handed an already-cut stream, and the flag alone reads as
      // metadata rather than as missing content.
      return { ...result, stdout: stdout.text, stderr: stderr.text };
    case 'standard':
    default:
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(result.expectation_error && { expectation_error: result.expectation_error }),
        ...(result.timed_out && { timed_out: true }),
        ...(result.cancelled && { cancelled: true }),
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.stdout_truncated && { stdout_truncated: true }),
        ...(result.stderr_truncated && { stderr_truncated: true }),
        ...(result.retries !== undefined && { retries: result.retries }),
        ...(result.progress_file && { progress_file: result.progress_file }),
        ...(result.warnings && { warnings: result.warnings }),
        ...(result.withheld_env && result.withheld_env.length > 0 && { withheld_env: result.withheld_env }),
        ...(result.pty && { pty: true }),
        ...(result.prompts_answered !== undefined && { prompts_answered: result.prompts_answered }),
        ...(result.pending_prompt && { pending_prompt: result.pending_prompt }),
        ...(result.prompt_declined && { prompt_declined: true }),
        ...sandboxFields(result),
      };
  }
}
