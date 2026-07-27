/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/concurrency.js';
import { resolveCredentialEnvScrub, scrubCredentialEnv, type ResolvedCredentialEnvScrub } from '../exec/credential-env.js';

/**
 * ProcessManager — tracks background processes for a single GoodVibes runtime.
 *
 * Extracted from tools/exec/index.ts so that other modules (UI, agent system,
 * live-tail) can query running processes without importing the exec tool.
 */

// ─── BackgroundProcess interface ──────────────────────────────────────────────

export interface BackgroundProcess {
  id: string;
  pid: number;
  cmd: string;
  startTime: number;
  /**
   * Output chunks collected so far. Appended AS THE PROCESS RUNS, not only at
   * exit, so `bg_output` on a still-running process returns what it has printed
   * up to now. This is also what supplies the output tail an on-exit trigger
   * payload carries.
   */
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  done: boolean;
  /**
   * Timestamp (ms since epoch) when SIGKILL was scheduled after a timeout.
   * Null if the process completed normally or SIGKILL was never scheduled.
   */
  killDeadline: number | null;
  completedAt?: number | undefined;
  /** POSIX signal name that terminated the process, or null if it exited. */
  signal?: string | null | undefined;
  /** True when the watchdog terminated the process at its timeout. */
  timedOut?: boolean | undefined;
}

const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
/**
 * How long to keep draining stdout/stderr AFTER the spawned process has exited.
 *
 * The pipe's write end is inherited by every descendant, so it reaches EOF only
 * once the LAST holder closes it. A command that leaves a child behind — which
 * is any `/bin/sh -c` whose shell did not exec-optimize into a single command —
 * keeps that write end open after the process we spawned is gone, and after a
 * timeout kill that reached only the shell. Waiting for EOF in that case means
 * waiting for the survivor, so the process is never reported finished at all.
 *
 * Exit is therefore what completes a process; this is only the window in which
 * output already in flight is still collected. Normal exits close their pipes
 * at once and never approach it, and output a process wrote before exiting is
 * already in the pipe buffer, so draining it costs microseconds — this bound
 * only decides how long a process whose pipe a survivor holds is delayed
 * before it is reported finished.
 */
const OUTPUT_DRAIN_GRACE_MS = 500;
const MAX_COMPLETED_PROCESSES = 100;
const COMPLETED_PROCESS_TTL_MS = 30 * 60 * 1000;

// ─── SpawnOptions ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Abort the process if it hasn't completed within this many ms. Default: 60000. */
  timeout_ms?: number | undefined;
  /** Grace period (ms) between SIGTERM and SIGKILL after timeout. Default: 5000. */
  sigterm_grace_ms?: number | undefined;
  /**
   * Whether the timeout watchdog may terminate the process. Default: true.
   *
   * Set false for a process whose lifetime is not the caller's to end — a
   * browser, an editor, a long-running server. `timeout_ms` then bounds only
   * how long a caller waits, and the process keeps running until it is stopped
   * explicitly. Killing such a process on a routine timeout destroys a
   * user-facing application as the default outcome of a normal parameter.
   */
  kill_on_timeout?: boolean | undefined;
  /**
   * Credential-bearing env-var scrub applied to the inherited base environment
   * before spawning. Defaults to enabled with an empty allowlist, so a
   * background process is protected even when a caller does not thread config.
   */
  credentialEnvScrub?: ResolvedCredentialEnvScrub | undefined;
  /**
   * Child stdin. Defaults to 'ignore' (closed): a background process has
   * nobody at the keyboard, so a prompt must EOF rather than hang.
   */
  stdin?: 'ignore' | 'pipe' | undefined;
}

// ─── ExecCommandResult subset (for command handler return values) ─────────────

export interface BgCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  process_id?: string | undefined;
  pid?: number | undefined;
}

// ─── ProcessManager ───────────────────────────────────────────────────────────

export class ProcessManager {
  private _counter = 0;
  private _processes = new Map<string, BackgroundProcess>();
  private _procs = new Map<string, ReturnType<typeof Bun.spawn>>();

  // ─── Private helpers ────────────────────────────────────────────────────────

  private newId(): string {
    return `bg_${++this._counter}_${Date.now()}`;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn a background process and start collecting its output.
   *
   * @param cmd  Shell command to run via /bin/sh -c.
   * @param cwd  Working directory (undefined = inherit).
   * @param env  Extra env vars merged with the current process env.
   * @param opts Timeout and SIGKILL grace configuration.
   *
   * @returns A BgCommandResult with the process_id and pid, or rejects if
   *          the binary is missing (ENOENT) or exec permission is denied (EACCES).
   */
  async spawn(
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch(['/bin/sh', '-c', cmd], cmd, cwd, env, opts);
  }

  /**
   * Spawn a background process from argv, with NO shell in between.
   *
   * Same tracking, credential-env scrub, live output collection and timeout
   * watchdog as `spawn` — the only difference is that nothing is handed to
   * /bin/sh, so no argument can be reinterpreted as a shell metacharacter.
   * On-exit triggers use this: their command is pre-registered and
   * digest-pinned, and keeping it argv-shaped means the pin covers exactly
   * what runs.
   */
  async spawnArgv(
    command: string,
    args: readonly string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch([command, ...args], [command, ...args].join(' '), cwd, env, opts);
  }

  private async launch(
    argv: readonly string[],
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    const timeoutMs = opts?.timeout_ms ?? 60_000;
    const sigtermGraceMs = opts?.sigterm_grace_ms ?? 5_000;
    const killOnTimeout = opts?.kill_on_timeout ?? true;

    const id = this.newId();
    const entry: BackgroundProcess = {
      id,
      pid: 0,
      cmd,
      startTime: Date.now(),
      stdout: [],
      stderr: [],
      exitCode: null,
      done: false,
      killDeadline: null,
    };
    this.pruneCompletedProcesses();
    this._processes.set(id, entry);

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    // Scrub credential-bearing vars out of the inherited base env before merging
    // the caller-supplied env (an explicit opt-in) on top. Without this, the
    // background spawn would re-introduce every secret from process.env that the
    // foreground scrub already removed.
    const scrubbedBase = scrubCredentialEnv(cleanEnv, opts?.credentialEnvScrub ?? resolveCredentialEnvScrub()).env;
    const mergedEnv = { ...scrubbedBase, ...env };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...argv], {
        ...(cwd !== undefined ? { cwd } : {}),
        env: mergedEnv,
        // Closed by default. An unattended command that stops to ask for a
        // password gets EOF and fails instead of blocking forever.
        stdin: opts?.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      } as Parameters<typeof Bun.spawn>[1]);
    } catch (spawnErr: unknown) {
      // Surface ENOENT / EACCES immediately — callers should not retry these
      this._processes.delete(id);
      throw spawnErr;
    }

    entry.pid = proc.pid;
    this._procs.set(id, proc);

    // Async collection with timeout escalation — SIGTERM then SIGKILL
    // Cast stdout/stderr to ReadableStream — Bun guarantees these are ReadableStream
    // when stdout/stderr is set to 'pipe', but the return type is a union.
    const drain = new AbortController();
    const streams = Promise.all([
      readProcessStream(proc.stdout as ReadableStream<Uint8Array>, entry.stdout, drain.signal),
      readProcessStream(proc.stderr as ReadableStream<Uint8Array>, entry.stderr, drain.signal),
    ]).catch((error: unknown) => {
      // A cancelled or broken pipe ends collection early; the exit code still
      // decides the outcome, so this is reported rather than thrown.
      logger.debug('Background process output collection ended early', {
        processId: id,
        error: summarizeError(error),
      });
    });
    const collectionPromise = (async () => {
      const exitCode = await proc.exited;
      // The process we spawned is gone. Collect whatever its pipes still hold,
      // but never block completion on them: a surviving descendant holds the
      // same write end, so EOF may never come. Cancelling the readers releases
      // them instead of leaving a task pending on a pipe nobody will close.
      await Promise.race([streams, sleep(OUTPUT_DRAIN_GRACE_MS)]);
      drain.abort();
      entry.exitCode = exitCode;
      // Bun reports the terminating signal on the handle; capture it so a
      // caller can tell "exited 1" from "killed by SIGKILL", which an on-exit
      // trigger payload has to distinguish.
      entry.signal = readSignalCode(proc);
      entry.done = true;
      entry.completedAt = Date.now();
      this._procs.delete(id);
      this.pruneCompletedProcesses();
    })();

    // Timeout watchdog: SIGTERM → wait grace → SIGKILL.
    //
    // A termination here is always announced. It used to be silent: a routine
    // timeout would kill a tracked process and log nothing, so the only trace
    // was an exitCode of null that read as an ordinary cancellation. When
    // kill_on_timeout is false the deadline is still recorded and reported, but
    // the process is left running.
    const timeoutHandle = setTimeout(async () => {
      if (entry.done) return;
      entry.timedOut = true;
      if (!killOnTimeout) {
        logger.info('Background process passed its timeout and was left running', {
          processId: id,
          pid: entry.pid,
          cmd,
          timeoutMs,
        });
        return;
      }
      logger.warn('Background process timed out — terminating', {
        processId: id,
        pid: entry.pid,
        cmd,
        timeoutMs,
        signal: 'SIGTERM',
        sigtermGraceMs,
      });
      killTrackedProcess(proc, 'SIGTERM', id);
      entry.killDeadline = Date.now() + sigtermGraceMs;
      await sleep(sigtermGraceMs);
      if (!entry.done) {
        logger.warn('Background process did not exit after SIGTERM — killing', {
          processId: id,
          pid: entry.pid,
          cmd,
          timeoutMs,
          signal: 'SIGKILL',
        });
        killTrackedProcess(proc, 'SIGKILL', id);
      }
    }, timeoutMs);
    timeoutHandle.unref?.();

    // Reject the spawn promise if the process errors immediately (ENOENT/EACCES
    // on the child process level) — the outer try/catch handles Bun.spawn throws;
    // this handles async failures surfaced via proc.exited rejecting.
    void collectionPromise.catch((error) => {
      logger.warn('Background process output collection failed', { processId: id, error: summarizeError(error) });
      clearTimeout(timeoutHandle);
      entry.done = true;
      entry.completedAt = Date.now();
      this._procs.delete(id);
      this.pruneCompletedProcesses();
    });

    // Clear the timeout watchdog once the process completes naturally
    void collectionPromise
      .then(() => {
        clearTimeout(timeoutHandle);
      })
      .catch((error) => {
        logger.debug('Background process timeout cleanup after failed collection', {
          processId: id,
          error: summarizeError(error),
        });
        clearTimeout(timeoutHandle);
      });

    return {
      cmd,
      exit_code: null,
      stdout: '',
      stderr: '',
      success: true,
      process_id: id,
      pid: proc.pid,
    };
  }

  /** Get the status record for a background process, or undefined if not found. */
  getStatus(id: string): BackgroundProcess | undefined {
    this.pruneCompletedProcesses();
    return this._processes.get(id);
  }

  /** Get the accumulated stdout/stderr for a background process. */
  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    this.pruneCompletedProcesses();
    const entry = this._processes.get(id);
    if (!entry) return undefined;
    return {
      stdout: entry.stdout.join(''),
      stderr: entry.stderr.join(''),
    };
  }

  /**
   * Stop a background process by ID.
   * Returns true if the process was found and stopped, false if unknown.
   */
  stop(id: string): boolean {
    const entry = this._processes.get(id);
    if (!entry) return false;

    const liveProc = this._procs.get(id);
    if (liveProc && !entry.done) {
      killTrackedProcess(liveProc, 'SIGTERM', id);
    }
    entry.done = true;
    this._procs.delete(id);
    this._processes.delete(id);
    return true;
  }

  /** List all tracked background processes with their status summaries. */
  list(): Array<{ id: string; pid: number; cmd: string; status: string }> {
    this.pruneCompletedProcesses();
    return Array.from(this._processes.values()).map((e) => ({
      id: e.id,
      pid: e.pid,
      cmd: e.cmd,
      status: describeProcessStatus(e),
    }));
  }

  /**
   * Handle bg_status / bg_output / bg_stop / bg_list special commands.
   * Returns a BgCommandResult if the command was handled, null otherwise.
   */
  handleCommand(cmd: string): BgCommandResult | null {
    this.pruneCompletedProcesses();
    // bg_status <id>
    const statusMatch = cmd.match(/^bg_status\s+(\S+)$/);
    if (statusMatch) {
      const entry = this._processes.get(statusMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${statusMatch[1]!}`, success: false };
      }
      const status = describeProcessStatus(entry);
      return {
        cmd,
        exit_code: 0,
        stdout: JSON.stringify({
          id: entry.id,
          pid: entry.pid,
          cmd: entry.cmd,
          status,
          exit_code: entry.exitCode,
          signal: entry.signal ?? null,
          timed_out: entry.timedOut === true,
          duration_ms: (entry.completedAt ?? Date.now()) - entry.startTime,
        }),
        stderr: '',
        success: true,
      };
    }

    // bg_output <id>
    const outputMatch = cmd.match(/^bg_output\s+(\S+)$/);
    if (outputMatch) {
      const entry = this._processes.get(outputMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${outputMatch[1]!}`, success: false };
      }
      return {
        cmd,
        exit_code: 0,
        stdout: entry.stdout.join(''),
        stderr: entry.stderr.join(''),
        success: true,
      };
    }

    // bg_stop <id>
    const stopMatch = cmd.match(/^bg_stop\s+(\S+)$/);
    if (stopMatch) {
      const found = this.stop(stopMatch[1]!);
      if (!found) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${stopMatch[1]!}`, success: false };
      }
      return { cmd, exit_code: 0, stdout: `Stopped ${stopMatch[1]!}`, stderr: '', success: true };
    }

    // bg_list
    if (cmd.trim() === 'bg_list') {
      return { cmd, exit_code: 0, stdout: JSON.stringify(this.list()), stderr: '', success: true };
    }

    return null;
  }

  private pruneCompletedProcesses(now = Date.now()): void {
    const completed = [...this._processes.values()]
      .filter((entry) => entry.done)
      .sort((a, b) => (b.completedAt ?? b.startTime) - (a.completedAt ?? a.startTime));
    for (let i = 0; i < completed.length; i++) {
      const entry = completed[i]!;
      const completedAt = entry.completedAt ?? entry.startTime;
      if (now - completedAt <= COMPLETED_PROCESS_TTL_MS && i < MAX_COMPLETED_PROCESSES) continue;
      this._processes.delete(entry.id);
    }
  }
}

/**
 * One status line that never claims success it cannot prove: a timed-out or
 * signalled process reads as such rather than as "done (exit null)".
 */
export function describeProcessStatus(entry: BackgroundProcess): string {
  if (!entry.done) return 'running';
  if (entry.timedOut === true) return `timed out (signal ${entry.signal ?? 'SIGKILL'})`;
  if (entry.signal) return `killed by ${entry.signal}`;
  return `done (exit ${entry.exitCode})`;
}

/**
 * Reads the terminating signal off a finished Bun subprocess handle without
 * asserting a shape the runtime does not guarantee.
 */
function readSignalCode(proc: ReturnType<typeof Bun.spawn>): string | null {
  const candidate = (proc as unknown as { signalCode?: unknown }).signalCode;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function killTrackedProcess(proc: ReturnType<typeof Bun.spawn>, signal: Parameters<ReturnType<typeof Bun.spawn>['kill']>[0], id: string): void {
  try {
    proc.kill(signal);
  } catch (error) {
    logger.debug('Background process kill failed; process may already be exited', {
      processId: id,
      signal,
      error: summarizeError(error),
    });
  }
}

/**
 * Drains a child stream into `sink` as chunks arrive.
 *
 * The defect this replaces: the previous implementation accumulated the whole
 * stream into a local string and returned it only when the stream closed, and
 * the caller pushed that single string into `entry.stdout` after `proc.exited`
 * resolved. Until the process ended, `entry.stdout` was empty — so `bg_output`
 * on a running process reported nothing, which is exactly the case a person
 * runs it in. Pushing each decoded chunk into the live array as it is read
 * makes `bg_output` reflect the process's output up to that moment, and gives
 * an on-exit trigger a real output tail to put in its payload.
 *
 * The byte cap is unchanged and is still enforced across the whole stream; the
 * truncation notice is appended once, at the point the cap is first crossed.
 */
async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
  cancelSignal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let truncated = false;

  // Abort releases the read loop for a pipe whose write end a surviving
  // descendant still holds; without it the pending read outlives the process.
  const onAbort = (): void => {
    void reader.cancel().catch(() => {
      /* the stream is already gone; nothing to release */
    });
  };
  if (cancelSignal?.aborted === true) onAbort();
  else cancelSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_PROCESS_OUTPUT_BYTES - total;
      if (remaining > 0) {
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded.length > 0) sink.push(decoded);
        total += chunk.byteLength;
      }
      if (value.byteLength > remaining && !truncated) {
        truncated = true;
        sink.push(`\n[goodvibes: output truncated after ${MAX_PROCESS_OUTPUT_BYTES} bytes]\n`);
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) sink.push(tail);
  } finally {
    cancelSignal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}


