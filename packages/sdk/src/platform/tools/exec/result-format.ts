/**
 * Exec result formatting — turns an ExecCommandResult into the record the tool
 * returns, honoring the caller's verbosity.
 *
 * Split out of runtime.ts so the denial branch below has room to state its
 * reasoning; runtime.ts is at a shrink-only line ceiling.
 */
import type { ExecCommandResult, ExecVerbosity } from './schema.js';

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

  switch (verbosity) {
    case 'count_only':
      return { cmd: result.cmd, exit_code: result.exit_code, success: result.success };
    case 'minimal': {
      const firstStdout = result.stdout.split('\n')[0] ?? '';
      const firstStderr = result.stderr.split('\n')[0] ?? '';
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: firstStdout,
        stderr: firstStderr,
        ...(result.expectation_error && { expectation_error: result.expectation_error }),
        ...(result.timed_out && { timed_out: true }),
        ...(result.cancelled && { cancelled: true }),
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.progress_file && { progress_file: result.progress_file }),
        ...(result.warnings && { warnings: result.warnings }),
        ...(result.withheld_env && result.withheld_env.length > 0 && { withheld_env: result.withheld_env }),
        ...(result.pending_prompt && { pending_prompt: result.pending_prompt }),
        ...(result.prompt_declined && { prompt_declined: true }),
      };
    }
    case 'verbose':
      return { ...result };
    case 'standard':
    default:
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
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
      };
  }
}
