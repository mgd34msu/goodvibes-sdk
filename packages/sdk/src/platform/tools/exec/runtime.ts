import { join, resolve, isAbsolute } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import type { Tool } from '../../types/tools.js';
import { logger } from '../../utils/logger.js';
import { EXEC_TOOL_SCHEMA } from './schema.js';
import { DEFAULT_MAX_CHARS, OverflowHandler } from '../shared/overflow.js';
import type { ExecInput, ExecCommandInput, ExecCommandResult, ExecVerbosity } from './schema.js';
import { ProcessManager } from '../shared/process-manager.js';
import { guardExecCommand, formatDenialResponse } from './ast-guard.js';
import { executeFileOperations } from './file-ops.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { DEFAULT_ALLOWED_CLASSES } from '../../runtime/permissions/normalization/verdict.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { compileSafeRegExp, safeRegExpTest } from '../../utils/safe-regex.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const PROGRESS_AUTO_THRESHOLD_MS = 30_000;
const OVERFLOW_SUBDIR = ['.goodvibes', '.overflow'] as const;
const MAX_EXEC_COMMANDS = 10;
const MAX_PARALLEL_EXEC_COMMANDS = 3;

const DANGEROUS_PATTERNS = [
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[\/~]/,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r?\s+[\/~]/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev/,
  /chmod\s+777\s+\//,
  /chown\s+.*\s+\//,
];

function decodeCmd(cmdInput: ExecCommandInput): string {
  if (cmdInput.cmd_base64) {
    return Buffer.from(cmdInput.cmd_base64, 'base64').toString('utf-8');
  }
  if (cmdInput.cmd) return cmdInput.cmd;
  throw new Error('Each command must have either cmd or cmd_base64');
}

function requireWorkingDirectory(input: ExecInput): string {
  if (!input.working_dir || input.working_dir.trim().length === 0) {
    throw new Error('exec requires an explicit working_dir');
  }
  return input.working_dir;
}

function truncate(
  overflowHandler: OverflowHandler,
  s: string,
  label?: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const result = overflowHandler.handle(s, { maxChars, label });
  return { text: result.content, truncated: result.overflowRef !== undefined };
}

function checkDangerous(cmd: string): void {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(cmd)) {
      logger.info(`[exec] WARNING: Potentially dangerous command detected: ${cmd}`);
      break;
    }
  }
}

function resolveCwd(cwd: string | undefined, workingDirectory: string): string {
  const effective = cwd ?? workingDirectory;
  if (isAbsolute(effective)) return effective;
  return resolve(workingDirectory, effective);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function computeRetryDelay(
  attempt: number,
  delayMs: number,
  backoff: 'fixed' | 'exponential',
  maxDelayMs: number = 30_000,
): number {
  if (backoff === 'fixed') return delayMs;
  // Full jitter: random in [0, min(base * 2^attempt, maxDelay)] — avoids thundering herd
  const cap = Math.min(delayMs * Math.pow(2, attempt), maxDelayMs);
  return randomInt(0, Math.max(1, Math.floor(cap) + 1));
}

function buildCleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function applyExpectations(
  result: ExecCommandResult,
  expect: ExecCommandInput['expect'] | undefined,
  exitCode: number | null,
): ExecCommandResult {
  if (!expect) return result;

  const failures: string[] = [];
  const { exit_code: expCode, stdout_contains, stderr_contains } = expect;

  if (expCode !== undefined && exitCode !== expCode) failures.push(`exit_code: expected ${expCode}, got ${exitCode}`);
  if (stdout_contains !== undefined && !result.stdout.includes(stdout_contains)) failures.push(`stdout_contains: '${stdout_contains}' not found`);
  if (stderr_contains !== undefined && !result.stderr.includes(stderr_contains)) failures.push(`stderr_contains: '${stderr_contains}' not found`);

  if (failures.length > 0) {
    return { ...result, success: false, expectation_error: failures.join('; ') };
  }

  return result;
}

function buildTimedOutResult(cmdStr: string, cwd: string | undefined, durationMs: number, progressFile?: string): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, timed_out: true, duration_ms: durationMs, cwd, ...(progressFile ? { progress_file: progressFile } : {}) };
}

function getProgressDirectory(workingDirectory: string): string {
  return join(workingDirectory, ...OVERFLOW_SUBDIR);
}

function getProgressFilePath(workingDirectory: string, id: string): string {
  return join(getProgressDirectory(workingDirectory), `${id}-progress.txt`);
}

function initProgressFile(cmdStr: string, workingDirectory: string): { path: string; append: (line: string) => void } {
  const progressDirectory = getProgressDirectory(workingDirectory);
  try {
    mkdirSync(progressDirectory, { recursive: true });
  } catch (err) {
    logger.debug('initProgressFile: mkdirSync failed (dir may already exist)', { error: summarizeError(err) });
  }
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const filePath = getProgressFilePath(workingDirectory, id);
  writeFileSync(filePath, `# Progress: ${cmdStr}\n# Started: ${new Date().toISOString()}\n`);
  return {
    path: filePath,
    append: (chunk: string) => {
      try { appendFileSync(filePath, chunk); } catch (err) { logger.debug('initProgressFile: appendFileSync failed', { path: filePath, error: summarizeError(err) }); }
    },
  };
}

import { copyFileSync, renameSync, unlinkSync, rmSync, cpSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { summarizeError } from '../../utils/error-display.js';

async function spawnBackground(
  processManager: ProcessManager,
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): Promise<ExecCommandResult> {
  return processManager.spawn(cmd, cwd, env);
}

function handleBgSpecialCommand(processManager: ProcessManager, cmd: string): ExecCommandResult | null {
  return processManager.handleCommand(cmd);
}

async function runCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  const guardResult = await guardExecCommand(cmdStr, DEFAULT_ALLOWED_CLASSES, featureFlags);
  if (!guardResult.allowed) {
    const denial = formatDenialResponse(guardResult, cmdStr);
    return {
      cmd: cmdStr,
      exit_code: null,
      stdout: '',
      stderr: denial.denial_reason as string ?? 'Command denied by policy',
      success: false,
      denied: true,
      denial_detail: denial,
    } as ExecCommandResult;
  }

  checkDangerous(cmdStr);
  const cwd = resolveCwd(cmdInput.cwd, workingDirectory);
  const timeoutMs = cmdInput.timeout_ms ?? globalTimeout;
  const mergedEnv = { ...buildCleanEnv(), ...cmdInput.env };
  const startTime = Date.now();

  if (cmdInput.until) {
    return runUntil(processManager, overflowHandler, cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime);
  }

  const useProgress = cmdInput.progress === true || timeoutMs > PROGRESS_AUTO_THRESHOLD_MS;
  if (useProgress) {
    return runCommandWithProgress(processManager, overflowHandler, cmdStr, cmdInput, workingDirectory, cwd, mergedEnv, timeoutMs, startTime);
  }

  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env: mergedEnv, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutResolve!: () => void;
  const timeoutSentinel = new Promise<void>((res) => { timeoutResolve = res; });

  killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
    } catch (err: unknown) {
      // OBS-11: Non-fatal — process may have already exited before kill
      logger.debug('[ExecRuntime] kill on timeout failed (process may have exited)', { error: String(err) });
    }
    timeoutResolve();
  }, timeoutMs);
  killTimer.unref?.();

  try {
    type ProcResult = [string, string, number];
    const procPromise = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]) as Promise<ProcResult>;

    let procResult: ProcResult | undefined;
    await Promise.race([
      procPromise.then((r) => { procResult = r; }),
      timeoutSentinel,
    ]);

    clearTimeout(killTimer);
    if (timedOut) {
      try {
        await procPromise;
      } catch (error) {
        logger.debug('exec foreground command collection failed after timeout', {
          command: cmdStr,
          error: summarizeError(error),
        });
      }
      return buildTimedOutResult(cmdStr, cwd, Date.now() - startTime);
    }

    const [stdoutRaw, stderrRaw, exitCode] = procResult!;
    const stdoutResult = truncate(overflowHandler, stdoutRaw, 'stdout');
    const stderrResult = truncate(overflowHandler, stderrRaw, 'stderr');
    const duration = Date.now() - startTime;
    const result: ExecCommandResult = {
      cmd: cmdStr,
      exit_code: exitCode,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      success: exitCode === 0,
      duration_ms: duration,
      cwd,
      env: cmdInput.env,
      ...(stdoutResult.truncated && { stdout_truncated: true }),
      ...(stderrResult.truncated && { stderr_truncated: true }),
    };
    return applyExpectations(result, cmdInput.expect, exitCode);
  } catch (err) {
    clearTimeout(killTimer);
    throw err;
  }
}

async function runCommandWithProgress(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  cwd: string | undefined,
  mergedEnv: Record<string, string>,
  timeoutMs: number,
  startTime: number,
): Promise<ExecCommandResult> {
  const progressFile = initProgressFile(cmdStr, workingDirectory);
  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env: mergedEnv, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutResolve!: () => void;
  const timeoutSentinel = new Promise<void>((res) => { timeoutResolve = res; });

  killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
    } catch (err: unknown) {
      logger.debug('[ExecRuntime] kill on streamed timeout failed (process may have exited)', { error: String(err) });
    }
    progressFile.append('# Timed out\n');
    timeoutResolve();
  }, timeoutMs);
  killTimer.unref?.();

  let stdoutBuf = '';
  let stderrBuf = '';
  const readStdout = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        stdoutBuf += chunk;
        progressFile.append(chunk);
      }
    } catch (err: unknown) {
      logger.debug('[ExecRuntime] stdout stream read ended with error', { error: String(err) });
    } finally {
      reader.releaseLock();
    }
  };
  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        stderrBuf += chunk;
      }
    } catch (err: unknown) {
      logger.debug('[ExecRuntime] stderr stream read ended with error', { error: String(err) });
    } finally {
      reader.releaseLock();
    }
  };

  const ioPromise = Promise.all([readStdout(), readStderr(), proc.exited]);
  await Promise.race([ioPromise, timeoutSentinel]);
  clearTimeout(killTimer);

  if (timedOut) {
    try {
      await ioPromise;
    } catch (error) {
      logger.debug('exec progress command IO collection failed after timeout', {
        command: cmdStr,
        error: summarizeError(error),
      });
    }
    return { ...buildTimedOutResult(cmdStr, cwd, Date.now() - startTime, progressFile.path), stdout: stdoutBuf, stderr: stderrBuf };
  }

  const ioResult = await ioPromise.catch((error) => {
    logger.debug('exec progress command IO collection failed', {
      command: cmdStr,
      error: summarizeError(error),
    });
    return [undefined, undefined, undefined] as [void, void, number | undefined];
  });
  const actualExitCode = (ioResult[2] as number | undefined) ?? await proc.exited;
  const stdoutResult = truncate(overflowHandler, stdoutBuf, 'stdout');
  const stderrResult = truncate(overflowHandler, stderrBuf, 'stderr');
  const duration = Date.now() - startTime;
  progressFile.append(`# Completed: exit=${actualExitCode} duration=${duration}ms\n`);

  const result: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: actualExitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    success: actualExitCode === 0,
    duration_ms: duration,
    cwd,
    env: cmdInput.env,
    progress_file: progressFile.path,
    ...(stdoutResult.truncated && { stdout_truncated: true }),
    ...(stderrResult.truncated && { stderr_truncated: true }),
  };
  return applyExpectations(result, cmdInput.expect, actualExitCode);
}

async function runUntil(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  cwd: string | undefined,
  env: Record<string, string>,
  timeoutMs: number,
  startTime: number,
): Promise<ExecCommandResult> {
  const until = cmdInput.until!;
  const pattern = compileSafeRegExp(until.pattern, '', { operation: 'exec until pattern' });
  const untilTimeout = until.timeout_ms ?? timeoutMs;
  const killAfter = until.kill_after ?? false;
  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env, stdout: 'pipe', stderr: 'pipe' });

  let stdoutBuf = '';
  let stderrBuf = '';
  let matched = false;

  const readStream = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (isStderr) stderrBuf += chunk; else stdoutBuf += chunk;
        if (!matched && safeRegExpTest(pattern, stdoutBuf + stderrBuf, { operation: 'exec until pattern', maxInputChars: 500_000 })) {
          matched = true;
          if (killAfter) {
            killExecProcess(proc, cmdStr, 'match');
          }
          reader.releaseLock();
          return;
        }
      }
    } catch (error) {
      logger.debug('exec run-until stream read failed', {
        command: cmdStr,
        stream: isStderr ? 'stderr' : 'stdout',
        error: summarizeError(error),
      });
      reader.releaseLock();
    }
  };

  const timeoutPromise = sleep(untilTimeout).then(() => undefined);
  await Promise.race([Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true)]), timeoutPromise]);

  if (!killAfter && !matched) {
    killExecProcess(proc, cmdStr, 'timeout');
  }

  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;
  const stdoutResult = truncate(overflowHandler, stdoutBuf, 'stdout');
  const stderrResult = truncate(overflowHandler, stderrBuf, 'stderr');
  return {
    cmd: cmdStr,
    exit_code: exitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    success: matched,
    duration_ms: duration,
    cwd,
    ...(stdoutResult.truncated && { stdout_truncated: true }),
    ...(stderrResult.truncated && { stderr_truncated: true }),
  };
}

function killExecProcess(proc: ReturnType<typeof Bun.spawn>, command: string, reason: string): void {
  try {
    proc.kill('SIGTERM');
  } catch (error) {
    logger.debug('exec process kill failed; process may already be exited', {
      command,
      reason,
      error: summarizeError(error),
    });
  }
}

/**
 * Classify whether a failed exec result is retryable.
 *
 * Retryable: network errors (ECONNRESET, ENOTFOUND, ETIMEDOUT), lock/busy
 * (EBUSY, ENOMEM, ECONNREFUSED), HTTP-gateway-style exit codes (124=timeout,
 * 28=curl timeout). Terminal: permission denied (EACCES), missing binary
 * (ENOENT), syntax errors.
 *
 * @param result - The failed command result.
 * @param allowed - Optional allowlist of error category strings.
 */
export function isRetryableExecResult(
  result: ExecCommandResult,
  allowed?: ReadonlyArray<'network' | 'lock' | 'busy' | 'oom'>,
): boolean {
  // Timed-out commands are never auto-retried — callers must decide
  if (result.timed_out) return false;

  const combined = `${result.stdout}\n${result.stderr}`;

  // Terminal errors — always skip retry
  const TERMINAL_PATTERNS = [
    /ENOENT/,           // missing binary / file
    /EACCES/,           // permission denied
    /Permission denied/, // shell-level perm error
    /command not found/, // bash: command not found
    /syntax error/i,    // shell syntax
    /No such file or directory/,
  ];
  for (const pat of TERMINAL_PATTERNS) {
    if (pat.test(combined)) return false;
  }

  // Map error categories to patterns
  const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
    network: [/ECONNRESET/, /ENOTFOUND/, /ETIMEDOUT/, /EHOSTUNREACH/, /ENETUNREACH/],
    lock:    [/ECONNREFUSED/, /EAGAIN/],
    busy:    [/EBUSY/, /Resource temporarily unavailable/],
    oom:     [/ENOMEM/, /Cannot allocate memory/, /Out of memory/],
  };

  const effectiveAllowed = allowed ?? ['network', 'lock', 'busy'];

  for (const category of effectiveAllowed) {
    const patterns = CATEGORY_PATTERNS[category] ?? [];
    for (const pat of patterns) {
      if (pat.test(combined)) return true;
    }
  }

  // Exit code 124 = timeout via `timeout` command; 75 = tempfail (sysexits.h)
  const retryableExitCodes = [124, 75];
  if (result.exit_code !== null && retryableExitCodes.includes(result.exit_code)) {
    return effectiveAllowed.includes('network') || effectiveAllowed.includes('busy');
  }

  return false;
}

async function runWithRetry(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  if (!cmdInput.retry) {
    return runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout);
  }

  const maxRetries = Math.min(cmdInput.retry.max ?? 3, 10);
  const delayMs = cmdInput.retry.delay_ms ?? 1000;
  const maxDelayMs = cmdInput.retry.max_delay_ms ?? 30_000;
  const backoff = cmdInput.retry.backoff ?? 'exponential';
  const retryOn = cmdInput.retry.on;
  let lastResult: ExecCommandResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout);
    if (lastResult.success) {
      return { ...lastResult, retries: attempt };
    }
    if (attempt < maxRetries) {
      // Classify error: if we can determine it's terminal, stop immediately
      if (!isRetryableExecResult(lastResult, retryOn)) {
        logger.debug('exec: terminal error — not retrying', { cmd: cmdStr, attempt, stderr: lastResult.stderr.slice(0, 200) });
        return { ...lastResult, retries: attempt };
      }
      const delay = computeRetryDelay(attempt, delayMs, backoff, maxDelayMs);
      logger.debug('exec: retrying after jittered delay', { cmd: cmdStr, attempt, delay: Math.round(delay) });
      await sleep(delay);
    }
  }

  return { ...lastResult!, retries: maxRetries };
}

async function executeResolvedCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  workingDirectory: string,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  const bgSpecial = handleBgSpecialCommand(processManager, cmdStr);
  if (bgSpecial) return bgSpecial;
  if (cmdInput.background) {
    return spawnBackground(processManager, cmdStr, resolveCwd(cmdInput.cwd, workingDirectory), cmdInput.env);
  }
  return runWithRetry(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout);
}

async function executeResolvedCommands(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }>,
  parallel: boolean,
  workingDirectory: string,
  globalTimeout: number,
  failFast: boolean,
): Promise<ExecCommandResult[]> {
  if (parallel) {
    return mapWithConcurrency(
      resolvedCmds,
      MAX_PARALLEL_EXEC_COMMANDS,
      ({ cmdStr, cmdInput }) =>
        executeResolvedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout),
    );
  }

  const results: ExecCommandResult[] = [];
  let stopped = false;
  for (const { cmdStr, cmdInput } of resolvedCmds) {
    if (stopped) {
      results.push({ cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, skipped: true });
      continue;
    }

    const result = await executeResolvedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, workingDirectory, globalTimeout);
    results.push(result);
    if (failFast && !result.success) {
      stopped = true;
    }
  }

  return results;
}

function formatResult(result: ExecCommandResult, verbosity: ExecVerbosity): Record<string, unknown> {
  if (result.skipped) {
    return { cmd: result.cmd, success: false, skipped: true };
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
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.progress_file && { progress_file: result.progress_file }),
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
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.stdout_truncated && { stdout_truncated: true }),
        ...(result.stderr_truncated && { stderr_truncated: true }),
        ...(result.retries !== undefined && { retries: result.retries }),
        ...(result.progress_file && { progress_file: result.progress_file }),
      };
  }
}

export function createExecTool(
  processManager: ProcessManager,
  options: {
    readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
    readonly overflowHandler?: OverflowHandler;
  } = {},
): Tool {
  if (!options.overflowHandler) {
    throw new Error('createExecTool requires an explicit overflowHandler');
  }
  const overflowHandler = options.overflowHandler;
  const featureFlags = options.featureFlags ?? null;

  return {
    definition: {
      name: 'exec',
      description:
        'Execute shell commands. Supports batch, parallel, background, retry, timeout,'
        + ' expectation-checking, until-pattern, and pre-command file operations.',
      parameters: EXEC_TOOL_SCHEMA,
      sideEffects: ['exec', 'read_fs', 'write_fs'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(args: Record<string, unknown>) {
      try {
        if (!Array.isArray(args['commands']) || (args['commands'] as unknown[]).length === 0) {
          return { success: false, error: 'commands must be a non-empty array' };
        }
        if ((args['commands'] as unknown[]).length > MAX_EXEC_COMMANDS) {
          return { success: false, error: `Too many commands: maximum ${MAX_EXEC_COMMANDS} per exec call` };
        }
        const input = args as unknown as ExecInput;
        const workingDirectory = requireWorkingDirectory(input);
        const verbosity: ExecVerbosity = (input.verbosity as ExecVerbosity) ?? 'standard';
        const globalTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const failFast = input.fail_fast === true || input.stop_on_error === true;
        const projectRoot = resolve(workingDirectory);

        const { fileOpResults, fileOpError } = await executeFileOperations(input.file_ops, projectRoot);
        if (fileOpError) return { success: false, error: fileOpError };

        const resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }> = [];
        for (const cmdInput of input.commands) {
          let cmdStr: string;
          try {
            cmdStr = decodeCmd(cmdInput);
          } catch (err) {
            const msg = summarizeError(err);
            return { success: false, error: msg };
          }
          resolvedCmds.push({ cmdStr, cmdInput });
        }

        const results = await executeResolvedCommands(
          processManager,
          overflowHandler,
          featureFlags,
          resolvedCmds,
          input.parallel === true,
          workingDirectory,
          globalTimeout,
          failFast,
        );
        const formatted = results.map((r) => formatResult(r, verbosity));
        const allSuccess = results.every((r) => r.success);
        const responseData: Record<string, unknown> = formatted.length === 1 ? { ...formatted[0] } : { commands: formatted, total: formatted.length };
        if (fileOpResults.length > 0) responseData.file_ops = fileOpResults;

        return { success: allSuccess, output: JSON.stringify(responseData) };
      } catch (err) {
        const message = summarizeError(err);
        return { success: false, error: message };
      }
    },
  };
}
