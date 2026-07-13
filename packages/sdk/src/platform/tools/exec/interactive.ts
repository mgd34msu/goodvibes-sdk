/**
 * interactive.ts — PTY-backed prompt-answer path for the exec tool.
 *
 * PROBLEM. All exec spawn paths pipe stdout/stderr and leave stdin unwired, so
 * a child that stops to ask a question (an `ssh` host-key confirmation, a
 * `gh auth login` flow, a `sudo` password ask) hangs until the timeout and the
 * exchange is lost. Many of those prompts are written to and read from the
 * controlling terminal (`/dev/tty`), so even piping stdin would not reach them
 * — the child needs a real PTY.
 *
 * APPROACH. Prompt-prone commands (and any command with `interactive: true`)
 * run under a PTY allocated by the host's `script(1)` binary (util-linux on
 * Linux, the BSD variant on macOS). The PTY wrapper is nested INSIDE the
 * sandbox argv — `[...sandboxArgv, script, ...]` — so when the per-command
 * bwrap boundary is active it stays the outermost layer and holds unchanged
 * under the PTY. When output goes quiet on a prompt-shaped tail, the pending
 * prompt text is surfaced through the injected `requestPromptAnswer` seam —
 * wired at the composition root to the SAME approval broker as a permission
 * ask, so every surface's existing approval/attention machinery renders it.
 * The typed answer is written to the PTY and the run continues; the full
 * exchange (prompt, echoed answer, subsequent output) lands in the tool
 * result transcript.
 *
 * DETECTION LIMITS (honest). There is no in-band signal that a child is
 * blocked reading its terminal — the only observable signals are the output
 * stream and time. Detection is therefore a heuristic: an unterminated final
 * line that looks like a question (ends with `:` or `?`, or carries a
 * `[y/N]` / `(yes/no)` style choice) followed by a quiet window with the
 * process still alive. This misses prompts that do not match the shapes below
 * (a bare `> ` REPL prompt, localized text, full-screen TUIs) and cannot see
 * a no-echo password read that printed nothing. A prompt that is never
 * answered — seam unwired, surface ignored it, or the human walked away —
 * ends in the normal timeout, with the detected prompt text reported on the
 * result (`pending_prompt`) so the failure is diagnosable instead of a silent
 * hang. PTY output merges stderr into stdout by nature; interactive results
 * carry the merged transcript in `stdout` and note `pty: true`.
 */

import { spawnSync } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { sleep } from '../../utils/concurrency.js';
import { normalizeCommand } from '../../runtime/permissions/normalization/index.js';
import type { ExecCommandInput, ExecCommandResult } from './schema.js';

// ── Availability (honest, probed, never faked) ───────────────────────────────

/** The honest, host-probed availability of the PTY backend. */
export interface PtyAvailability {
  readonly available: boolean;
  readonly backend: 'script' | 'none';
  /** Resolved `script` path when available. */
  readonly scriptPath?: string | undefined;
  /** util-linux (`script -qefc cmd /dev/null`) vs BSD (`script -q /dev/null sh -c cmd`) argv shape. */
  readonly flavor?: 'util-linux' | 'bsd' | undefined;
  /** Stated reason — a diagnosis when unavailable, a one-line summary when available. */
  readonly reason: string;
}

/** Raw host-probe inputs so {@link detectPtyAvailability} stays pure and unit-testable. */
export interface PtyHostProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** Resolved `script` path, or null when not on PATH. */
  readonly scriptPath: string | null;
}

/** Decide PTY availability from a host probe. Pure. */
export function detectPtyAvailability(probe: PtyHostProbe): PtyAvailability {
  if (probe.platform !== 'linux' && probe.platform !== 'darwin') {
    return {
      available: false,
      backend: 'none',
      reason: `exec PTY prompt-answer path unavailable: no script(1) argv shape is wired for platform ${probe.platform}`,
    };
  }
  if (!probe.scriptPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'exec PTY prompt-answer path unavailable: script(1) was not found on PATH',
    };
  }
  return {
    available: true,
    backend: 'script',
    scriptPath: probe.scriptPath,
    flavor: probe.platform === 'linux' ? 'util-linux' : 'bsd',
    reason: `PTY prompt-answer path available via ${probe.scriptPath} (${probe.platform === 'linux' ? 'util-linux' : 'bsd'} flavor)`,
  };
}

/** Probe the real host for a `script` binary. Impure; non-PTY platforms short-circuit. */
export function probePtyHost(): PtyHostProbe {
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { platform, scriptPath: null };
  }
  const resolved = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8', timeout: 5000 });
  const scriptPath = resolved.status === 0 ? resolved.stdout.trim() || null : null;
  return { platform, scriptPath };
}

// ── PTY argv (pure) ───────────────────────────────────────────────────────────

/**
 * Construct the PTY wrapper argv that REPLACES `['/bin/sh','-c',cmd]`. The
 * caller prepends the sandbox argv unchanged, so the boundary (when active)
 * wraps the PTY allocation itself: `[...sandboxArgv, ...buildPtyArgv(...)]`.
 */
export function buildPtyArgv(availability: PtyAvailability, command: string): string[] {
  if (!availability.available || !availability.scriptPath) {
    throw new Error(`buildPtyArgv called without an available PTY backend: ${availability.reason}`);
  }
  if (availability.flavor === 'bsd') {
    return [availability.scriptPath, '-q', '/dev/null', '/bin/sh', '-c', command];
  }
  // util-linux: -q quiet, -e return child exit code, -f flush per write, -c command
  return [availability.scriptPath, '-qefc', command, '/dev/null'];
}

// ── Prompt-shape detection (pure heuristic; see module doc for limits) ───────

const MAX_PROMPT_TAIL_CHARS = 500;

const PROMPT_TAIL_PATTERNS: readonly RegExp[] = [
  /[:?]\s*$/, // "Password:", "Are you sure ...?", "Username for 'https://…':"
  /\[[^\]\n]{1,12}\]\s*$/, // "[y/N]", "[Y/n/a]", "[fingerprint]"
  /\((?:yes\/no|y\/n)(?:\/[^)\n]{1,20})?\)\s*$/i, // "(yes/no)", "(yes/no/[fingerprint])"
];

/**
 * Extract the pending prompt from an output transcript tail, or null when the
 * tail does not look like a prompt. A prompt is an unterminated (no trailing
 * newline) final line of plausible length matching a known question shape.
 */
export function findPendingPrompt(transcript: string): string | null {
  if (transcript.length === 0) return null;
  if (transcript.endsWith('\n')) return null;
  const lastNewline = transcript.lastIndexOf('\n');
  const tail = transcript.slice(lastNewline + 1);
  const trimmed = tail.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_TAIL_CHARS) return null;
  return PROMPT_TAIL_PATTERNS.some((pattern) => pattern.test(trimmed)) ? trimmed : null;
}

/**
 * Base commands whose normal operation stops on terminal prompts (host-key
 * confirmations, credential asks). Deliberately small: auto-engaging the PTY
 * merges stderr into stdout for the run, so only commands where a hidden
 * prompt is the dominant failure mode are listed. Anything else opts in with
 * `interactive: true`.
 */
const PROMPT_PRONE_BASE_COMMANDS: ReadonlySet<string> = new Set([
  'ssh',
  'scp',
  'sftp',
  'sudo',
  'su',
  'passwd',
]);

/** Whether any segment of the command has a prompt-prone base command. */
export function isPromptProneCommand(command: string): boolean {
  try {
    const normalized = normalizeCommand(command);
    return normalized.segments.some((seg) => PROMPT_PRONE_BASE_COMMANDS.has(seg.command));
  } catch {
    return false;
  }
}

// ── The interaction runtime (seam wired at the composition root) ─────────────

/** A pending prompt surfaced through the approval/attention machinery. */
export interface ExecPromptAsk {
  readonly command: string;
  /** The detected prompt line (the unterminated output tail). */
  readonly prompt: string;
  /** Bounded recent transcript for context (last ~2000 chars). */
  readonly recentOutput: string;
  readonly workingDirectory?: string | undefined;
}

/** The surface's answer. `answered: false` means the ask was declined. */
export interface ExecPromptAnswer {
  readonly answered: boolean;
  /** The text to feed the waiting child (a trailing newline is appended). */
  readonly text?: string | undefined;
}

/**
 * The resolved interactive context the exec runtime threads per call. Null on
 * a createExecTool with no interactive wiring — then every command runs the
 * unchanged pipe-based path.
 */
export interface ExecInteractionRuntime {
  readonly availability: PtyAvailability;
  /**
   * Broker a pending-prompt answer through the approval broker. Wired at the
   * composition root (see runtime/permissions/exec-prompt-wiring.ts). When
   * absent, prompts are still detected and reported on the result, but cannot
   * be answered.
   */
  readonly requestPromptAnswer?: ((ask: ExecPromptAsk) => Promise<ExecPromptAnswer>) | undefined;
  /** Quiet window before a prompt-shaped tail counts as pending. Default 1200ms. */
  readonly quietWindowMs?: number | undefined;
}

const DEFAULT_QUIET_WINDOW_MS = 1200;
const QUIET_POLL_INTERVAL_MS = 150;
const RECENT_OUTPUT_CONTEXT_CHARS = 2000;

/**
 * Whether this command should take the PTY path: explicit `interactive: true`,
 * or a prompt-prone base command — in both cases only when the host actually
 * has a PTY backend (never faked; unavailable → the unchanged pipe path).
 */
export function shouldRunInteractive(
  interaction: ExecInteractionRuntime | null,
  cmdInput: ExecCommandInput,
  cmdStr: string,
): boolean {
  if (!interaction?.availability.available) return false;
  if (cmdInput.background || cmdInput.until) return false;
  if (cmdInput.interactive === true) return true;
  if (cmdInput.interactive === false) return false;
  return isPromptProneCommand(cmdStr);
}

// ── The interactive runner ────────────────────────────────────────────────────

interface InteractiveRunInput {
  readonly cmdStr: string;
  readonly cwd: string | undefined;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly startTime: number;
  /** Sandbox argv prefix — prepended UNCHANGED so the boundary wraps the PTY. */
  readonly sandboxArgv: readonly string[];
  readonly interaction: ExecInteractionRuntime;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run a command under a PTY with the prompt-answer loop. The transcript
 * (stdout+stderr merged by the PTY) accumulates in `stdout`; each detected
 * prompt is brokered through `requestPromptAnswer` and the answer is written
 * back to the child's terminal. See the module doc for detection limits.
 */
export async function runInteractiveCommand(input: InteractiveRunInput): Promise<ExecCommandResult> {
  const { cmdStr, cwd, env, timeoutMs, startTime, interaction, signal } = input;
  const ptyArgv = buildPtyArgv(interaction.availability, cmdStr);
  const quietWindowMs = interaction.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;

  const proc = Bun.spawn([...input.sandboxArgv, ...ptyArgv], {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  } as Parameters<typeof Bun.spawn>[1]);

  let transcript = '';
  let lastDataAt = Date.now();
  let exited = false;
  let timedOut = false;
  let cancelled = false;
  let promptsAnswered = 0;
  let promptDeclined = false;
  let pendingPrompt: string | undefined;
  /** Transcript length at the last brokered ask — re-ask only on NEW output. */
  let askedAtLength = -1;
  let askInFlight = false;

  const kill = async (): Promise<void> => {
    try {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] kill failed (process may have exited)', { error: String(err) });
    }
  };

  const killTimer = setTimeout(() => {
    timedOut = true;
    void kill();
  }, timeoutMs);
  killTimer.unref?.();

  const onAbort = (): void => {
    if (timedOut || cancelled) return;
    cancelled = true;
    void kill();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const readStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // PTYs emit CRLF; normalize so transcripts and prompt tails are stable.
        transcript += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        lastDataAt = Date.now();
      }
    } catch (err: unknown) {
      logger.debug('[ExecInteractive] stream read ended with error', { error: summarizeError(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const writeAnswer = (text: string): void => {
    try {
      const stdin = proc.stdin as { write: (chunk: string) => unknown; flush?: () => unknown };
      stdin.write(`${text}\n`);
      stdin.flush?.();
    } catch (err: unknown) {
      logger.warn('[ExecInteractive] failed to write prompt answer to PTY', { error: summarizeError(err) });
    }
  };

  const brokerPrompt = async (prompt: string): Promise<void> => {
    askInFlight = true;
    try {
      const answer = await interaction.requestPromptAnswer!({
        command: cmdStr,
        prompt,
        recentOutput: transcript.slice(-RECENT_OUTPUT_CONTEXT_CHARS),
        ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
      });
      if (exited || timedOut || cancelled) return;
      if (answer.answered && typeof answer.text === 'string') {
        pendingPrompt = undefined;
        promptsAnswered += 1;
        writeAnswer(answer.text);
      } else {
        // Declined: the honest move is to stop the run now, not burn the
        // remaining timeout on a child that will never get its answer.
        promptDeclined = true;
        void kill();
      }
    } catch (err: unknown) {
      logger.warn('[ExecInteractive] prompt-answer broker failed; prompt left pending', { error: summarizeError(err) });
    } finally {
      askInFlight = false;
    }
  };

  // The quiet-window watcher: a prompt-shaped unterminated tail + no new
  // output while the child is still alive → a pending prompt.
  const watcher = (async (): Promise<void> => {
    while (!exited && !timedOut && !cancelled) {
      await sleep(QUIET_POLL_INTERVAL_MS);
      if (exited || timedOut || cancelled || askInFlight || promptDeclined) continue;
      if (Date.now() - lastDataAt < quietWindowMs) continue;
      const prompt = findPendingPrompt(transcript);
      if (!prompt) continue;
      pendingPrompt = prompt;
      if (interaction.requestPromptAnswer && transcript.length !== askedAtLength) {
        askedAtLength = transcript.length;
        void brokerPrompt(prompt);
      }
    }
  })();

  const io = Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  const exitCode = await proc.exited;
  exited = true;
  clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  // Bounded drain — a PTY grandchild can hold the pipe open past the kill.
  await Promise.race([io.then(() => undefined, () => undefined), sleep(500)]);
  await watcher;

  const duration = Date.now() - startTime;
  const base: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: timedOut || cancelled ? null : exitCode,
    stdout: transcript,
    stderr: '',
    success: !timedOut && !cancelled && !promptDeclined && exitCode === 0,
    duration_ms: duration,
    cwd,
    pty: true,
    ...(promptsAnswered > 0 ? { prompts_answered: promptsAnswered } : {}),
    ...(pendingPrompt !== undefined ? { pending_prompt: pendingPrompt } : {}),
    ...(promptDeclined ? { prompt_declined: true } : {}),
    ...(timedOut ? { timed_out: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
  return base;
}
