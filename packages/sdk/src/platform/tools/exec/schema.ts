/**
 * JSON Schema definition for the `exec` tool.
 *
 * The exec tool runs shell commands, optionally in parallel or background,
 * with retry, timeout, expectation-checking, and pre-command file operations.
 */
export const EXEC_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      description: 'Commands to execute. Run sequentially by default, parallel if parallel=true.',
      items: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description: 'Shell command to execute via sh -c.',
          },
          cmd_base64: {
            type: 'string',
            description: 'Base64-encoded command. Use when cmd contains special characters.',
          },
          cwd: {
            type: 'string',
            description: 'Per-command working directory override. Prefer top-level working_dir for the project root.',
          },
          working_dir: {
            type: 'string',
            description:
              'Alias for cwd on a command item. For a single-command call, this can also supply the required top-level working_dir.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: 'Per-command timeout in milliseconds. Default: 120000 (2 min).',
          },
          env: {
            type: 'object',
            description: 'Additional environment variables merged with the current process env.',
            additionalProperties: { type: 'string' },
          },
          expect: {
            type: 'object',
            description: 'Expectations to validate after the command completes.',
            properties: {
              exit_code: {
                type: 'integer',
                description: 'Expected exit code.',
              },
              stdout_contains: {
                type: 'string',
                description: 'Substring that stdout must contain.',
              },
              stderr_contains: {
                type: 'string',
                description: 'Substring that stderr must contain.',
              },
            },
          },
          background: {
            type: 'boolean',
            description:
              'Run detached — returns immediately with a process_id.'
              + ' Use bg_status <id>, bg_output <id>, bg_stop <id> to manage.',
          },
          retry: {
            type: 'object',
            description: 'Retry configuration for transient failures.',
            properties: {
              max: {
                type: 'integer',
                minimum: 1,
                maximum: 10,
                description: 'Maximum retry attempts. Default: 3.',
              },
              delay_ms: {
                type: 'integer',
                minimum: 0,
                description: 'Base delay between retries in ms. Default: 1000.',
              },
              max_delay_ms: {
                type: 'integer',
                minimum: 0,
                description: 'Max jitter cap for exponential backoff in ms. Default: 30000.',
              },
              backoff: {
                type: 'string',
                enum: ['fixed', 'exponential'],
                description: 'Backoff strategy. Default: exponential.',
              },
              on: {
                type: 'array',
                items: { type: 'string', enum: ['network', 'lock', 'busy', 'oom'] },
                description: 'Error categories to retry on. Default: ["network", "lock", "busy"].',
              },
            },
          },
          until: {
            type: 'object',
            description:
              'Pattern-based early termination. Watch stdout/stderr for a regex match.',
            properties: {
              pattern: {
                type: 'string',
                description: 'Regex to watch for in combined stdout/stderr.',
              },
              timeout_ms: {
                type: 'integer',
                minimum: 1,
                description: 'Max wait time in ms. Defaults to command timeout.',
              },
              kill_after: {
                type: 'boolean',
                description:
                  'Kill the process when pattern matches. Default false (promotes to background).',
              },
            },
            required: ['pattern'],
          },
          progress: {
            type: 'boolean',
            description:
              'Stream stdout lines to a pollable progress file at .goodvibes/.overflow/{id}-progress.txt.'
              + ' Auto-enabled when timeout_ms > 30000. The result includes a progress_file path.',
          },
        },
        // cmd or cmd_base64 required — validated at runtime
      },
      minItems: 1,
      maxItems: 10,
    },
    parallel: {
      type: 'boolean',
      description: 'Run all commands in parallel. Default: false (sequential).',
    },
    working_dir: {
      type: 'string',
      description: 'Global working directory applied to all commands unless overridden per-command.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 1,
      description: 'Global timeout in ms applied to all commands. Default: 120000.',
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'count_only: exit codes only; minimal: exit codes + first line stdout/stderr;'
        + ' standard: full stdout/stderr + exit code (default);'
        + ' verbose: everything + timing, env, cwd.',
    },
    stop_on_error: {
      type: 'boolean',
      description:
        'Alias for fail_fast. Stop sequential execution on first failed command.'
        + ' Unexecuted commands appear as {skipped: true} entries. Default: false.',
    },
    fail_fast: {
      type: 'boolean',
      description:
        'Stop sequential execution on first failed command (non-zero exit, timed_out, or expectation_error).'
        + ' Unexecuted commands appear as {skipped: true} entries. Default: false.'
        + ' Alias: stop_on_error.',
    },
    file_ops: {
      type: 'array',
      description: 'File operations to execute BEFORE commands run.',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['copy', 'move', 'delete'],
            description: 'Operation type.',
          },
          source: {
            type: 'string',
            description: 'Source path (relative or absolute, within project root).',
          },
          destination: {
            type: 'string',
            description: 'Destination path. Required for copy and move.',
          },
          recursive: {
            type: 'boolean',
            description: 'Copy/delete directories recursively.',
          },
          overwrite: {
            type: 'boolean',
            description:
              'Overwrite destination if it already exists (copy/move only). Default: false. '
              + 'When false and destination exists, the operation returns an error.',
            default: false,
          },
          dry_run: {
            type: 'boolean',
            description:
              'Preview what would be deleted without deleting (delete only). Default: false. '
              + 'Returns a list of files that would be deleted.',
            default: false,
          },
          update_imports: {
            type: 'boolean',
            description:
              'After a move, find all TypeScript/JavaScript files that import from the previous path '
              + 'and rewrite their import statements to use the new path for this move. Default: false.',
            default: false,
          },
        },
        required: ['op', 'source'],
      },
    },
  },
  required: ['commands'],
} as const;

// ─── TypeScript interfaces ────────────────────────────────────────────────────

export type ExecVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';

export interface ExecExpect {
  exit_code?: number | undefined;
  stdout_contains?: string | undefined;
  stderr_contains?: string | undefined;
}

export interface ExecRetry {
  max?: number | undefined;
  delay_ms?: number | undefined;
  /** Max jitter cap for exponential backoff. Default: 30000. */
  max_delay_ms?: number | undefined;
  backoff?: 'fixed' | 'exponential' | undefined;
  /** Error categories to retry on. Default: ['network', 'lock', 'busy']. */
  on?: ReadonlyArray<'network' | 'lock' | 'busy' | 'oom'> | undefined;
}

export interface ExecUntil {
  pattern: string;
  timeout_ms?: number | undefined;
  kill_after?: boolean | undefined;
}

export interface ExecFileOp {
  op: 'copy' | 'move' | 'delete';
  source: string;
  destination?: string | undefined;
  recursive?: boolean | undefined;
  /** Overwrite destination if it exists (copy/move only). Default: false. */
  overwrite?: boolean | undefined;
  /** Preview what would be deleted without deleting (delete only). Default: false. */
  dry_run?: boolean | undefined;
  /** Rewrite TS/JS import paths after move (move only). Default: false. */
  update_imports?: boolean | undefined;
}

export interface ExecCommandInput {
  cmd?: string | undefined;
  cmd_base64?: string | undefined;
  cwd?: string | undefined;
  working_dir?: string | undefined;
  timeout_ms?: number | undefined;
  env?: Record<string, string> | undefined;
  expect?: ExecExpect | undefined;
  background?: boolean | undefined;
  retry?: ExecRetry | undefined;
  until?: ExecUntil | undefined;
  /** Stream stdout to a pollable progress file. Auto-enabled when timeout_ms > 30000. */
  progress?: boolean | undefined;
}

export interface ExecInput {
  commands: ExecCommandInput[];
  parallel?: boolean | undefined;
  working_dir?: string | undefined;
  timeout_ms?: number | undefined;
  verbosity?: ExecVerbosity | undefined;
  file_ops?: ExecFileOp[] | undefined;
  /**
   * Stop sequential execution on first failed command.
   * Unexecuted commands appear as {skipped: true} entries. Default: false.
   */
  fail_fast?: boolean | undefined;
  /** Alias for fail_fast. */
  stop_on_error?: boolean | undefined;
}

// ─── Result interfaces ────────────────────────────────────────────────────────

export interface ExecCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  /** Set when expectations are violated. */
  expectation_error?: string | undefined;
  /** Set when command exceeded timeout. */
  timed_out?: boolean | undefined;
  /** Set when command ran in background. */
  process_id?: string | undefined;
  pid?: number | undefined;
  /** Timing info (verbose only). */
  duration_ms?: number | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Truncation note. */
  stdout_truncated?: boolean | undefined;
  stderr_truncated?: boolean | undefined;
  /** Number of retry attempts used. */
  retries?: number | undefined;
  /** Set when this command was not executed due to fail_fast/stop_on_error. */
  skipped?: boolean | undefined;
  /** Path to the pollable progress file when progress tracking is enabled. */
  progress_file?: string | undefined;
  /** Tool-level warnings for degraded command collection or side effects. */
  warnings?: string[] | undefined;
}

// BackgroundProcess is defined in shared/process-manager and re-exported here for consumers of this schema module.
export type { BackgroundProcess } from '../shared/process-manager.js';
