/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

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
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  done: boolean;
  /**
   * Timestamp (ms since epoch) when SIGKILL was scheduled after a timeout.
   * Null if the process completed normally or SIGKILL was never scheduled.
   */
  killDeadline: number | null;
  completedAt?: number;
}

const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_COMPLETED_PROCESSES = 100;
const COMPLETED_PROCESS_TTL_MS = 30 * 60 * 1000;

// ─── SpawnOptions ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Abort the process if it hasn't completed within this many ms. Default: 60000. */
  timeout_ms?: number;
  /** Grace period (ms) between SIGTERM and SIGKILL after timeout. Default: 5000. */
  sigterm_grace_ms?: number;
}

// ─── ExecCommandResult subset (for command handler return values) ─────────────

export interface BgCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  process_id?: string;
  pid?: number;
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
    const timeoutMs = opts?.timeout_ms ?? 60_000;
    const sigtermGraceMs = opts?.sigterm_grace_ms ?? 5_000;

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
    const mergedEnv = { ...cleanEnv, ...env };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['/bin/sh', '-c', cmd], {
        cwd,
        env: mergedEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
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
    const collectionPromise = (async () => {
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        readProcessStream(proc.stdout as ReadableStream<Uint8Array>),
        readProcessStream(proc.stderr as ReadableStream<Uint8Array>),
        proc.exited,
      ]);
      entry.stdout.push(stdoutText);
      entry.stderr.push(stderrText);
      entry.exitCode = exitCode;
      entry.done = true;
      entry.completedAt = Date.now();
      this._procs.delete(id);
      this.pruneCompletedProcesses();
    })();

    // Timeout watchdog: SIGTERM → wait grace → SIGKILL
    const timeoutHandle = setTimeout(async () => {
      if (entry.done) return;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      entry.killDeadline = Date.now() + sigtermGraceMs;
      await sleep(sigtermGraceMs);
      if (!entry.done) {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, timeoutMs);
    timeoutHandle.unref?.();

    // Reject the spawn promise if the process errors immediately (ENOENT/EACCES
    // on the child process level) — the outer try/catch handles Bun.spawn throws;
    // this handles async failures surfaced via proc.exited rejecting.
    void collectionPromise.catch(() => {
      clearTimeout(timeoutHandle);
      entry.done = true;
      entry.completedAt = Date.now();
      this._procs.delete(id);
      this.pruneCompletedProcesses();
    });

    // Clear the timeout watchdog once the process completes naturally
    void collectionPromise.then(() => {
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
      try { liveProc.kill('SIGTERM'); } catch { /* already exited */ }
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
      status: e.done ? `done (exit ${e.exitCode})` : 'running',
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
      const entry = this._processes.get(statusMatch[1]);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${statusMatch[1]}`, success: false };
      }
      const status = entry.done ? `done (exit ${entry.exitCode})` : 'running';
      return {
        cmd,
        exit_code: 0,
        stdout: JSON.stringify({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status }),
        stderr: '',
        success: true,
      };
    }

    // bg_output <id>
    const outputMatch = cmd.match(/^bg_output\s+(\S+)$/);
    if (outputMatch) {
      const entry = this._processes.get(outputMatch[1]);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${outputMatch[1]}`, success: false };
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
      const found = this.stop(stopMatch[1]);
      if (!found) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${stopMatch[1]}`, success: false };
      }
      return { cmd, exit_code: 0, stdout: `Stopped ${stopMatch[1]}`, stderr: '', success: true };
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

async function readProcessStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = '';
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_PROCESS_OUTPUT_BYTES - total;
      if (remaining > 0) {
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        output += decoder.decode(chunk, { stream: true });
        total += chunk.byteLength;
      }
      if (value.byteLength > remaining) {
        truncated = true;
      }
    }
    output += decoder.decode();
    return truncated
      ? `${output}\n[goodvibes: output truncated after ${MAX_PROCESS_OUTPUT_BYTES} bytes]\n`
      : output;
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
