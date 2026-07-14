/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * observed/detect.ts — read-only detection of externally-launched coding-agent
 * sessions this daemon did NOT spawn or host (someone's own Claude Code / Codex
 * process on the same host).
 *
 * Discipline (mirrors remote-access/tailscale.ts detectTailscale): STRICTLY
 * read-only. The process table and the tmux pane list are READ; the observed
 * processes are NEVER exec'd, signalled, or probed. Absence is a quiet empty
 * set, never an error and never a nag. Both readers are injectable so tests
 * never touch a real `/proc` or `tmux`.
 *
 * What is honestly derivable becomes an ObservedRawProcess: binary kind
 * (argv-shape match), pid, working directory, start time, controlling tty, and
 * cumulative CPU seconds (the liveness signal the source turns into
 * active/quiet). The tmux pane list maps a controlling tty to a pane id, which
 * is the one genuine steer channel a tmux-hosted foreign session exposes.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import type { ObservedAgentKind } from '../types.js';

/** One live process as read from the process table — only read-only-derivable facts. */
export interface ObservedRawProcess {
  readonly pid: number;
  readonly ppid: number;
  /** Full command line (argv joined by spaces), for the argv-shape kind match. */
  readonly args: string;
  /** Controlling terminal path (e.g. `/dev/pts/11`), or undefined when the process has none. */
  readonly tty?: string | undefined;
  /** Working directory, when derivable read-only (Linux `/proc/<pid>/cwd`). */
  readonly cwd?: string | undefined;
  /** Epoch ms the process started, when derivable. */
  readonly startedAt?: number | undefined;
  /** Cumulative CPU seconds the OS reports for the process (monotonic per pid). */
  readonly cpuSeconds: number;
}

/** Injectable process-table reader. The default reads Linux `/proc`; tests substitute a stub. */
export interface ProcessTableReader {
  read(): readonly ObservedRawProcess[];
}

/** One tmux pane's tty → pane-id mapping row. */
export interface TmuxPaneRow {
  readonly paneId: string;
  /** The pane's controlling terminal path (tmux `#{pane_tty}`), e.g. `/dev/pts/11`. */
  readonly tty: string;
}

/** Injectable tmux pane reader. The default runs `tmux list-panes -a`; tests substitute a stub. */
export interface TmuxPaneReader {
  listPanes(): readonly TmuxPaneRow[];
}

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Classify a process's argv shape into an external coding-agent kind, or null
 * when it is not one of the known agents (so it is skipped entirely — not an
 * `unknown` row). `unknown` is reserved for a process that matched a launcher
 * shape but whose specific agent could not be named; the current matchers are
 * specific enough that they always name a kind, so null-vs-kind is the real
 * discriminator callers use.
 */
export function classifyExternalKind(args: string): ObservedAgentKind | null {
  if (!args) return null;
  const tokens = args.split(/\s+/).filter(Boolean);
  const basename = (token: string): string => token.split('/').pop() ?? token;
  const argv0base = basename(tokens[0] ?? '');
  // The "effective program": when argv0 is a JS runtime launcher, the agent's
  // real basename is argv1 (e.g. `node /…/bin/codex …` — argv0 is node, the
  // program is codex). Otherwise it is argv0 itself.
  const launcher = /^(node|node-MainThread|bun|deno|npx|bunx)$/.test(argv0base);
  const base = launcher && tokens[1] ? basename(tokens[1]) : argv0base;
  // Codex: the `codex` CLI (basename `codex`/`codex-*`) or its npm package path.
  if (base === 'codex' || base.startsWith('codex-') || args.includes('@openai/codex')) {
    return 'codex';
  }
  // Claude Code: the `claude` / `claude.exe` CLI, or its npm package path. The
  // bare `claude` basename is the CLI; guard against unrelated tools by also
  // accepting the package path. (The daemon's own in-process agents are not a
  // separate `claude` binary, so they never match here.)
  if (base === 'claude' || base === 'claude.exe' || args.includes('@anthropic-ai/claude-code')) {
    return 'claude-code';
  }
  // opencode CLI.
  if (base === 'opencode' || args.includes('/opencode')) {
    return 'opencode';
  }
  return null;
}

/** A classified observed process: a raw row plus the external kind it matched. */
export interface ClassifiedObservedProcess extends ObservedRawProcess {
  readonly externalKind: ObservedAgentKind;
}

/**
 * Classify the process table into observed coding-agent rows, keeping ONE row
 * per session: a matched process whose parent is also a matched process of the
 * same kind is a child helper (e.g. the native `codex` binary under its `node`
 * launcher) and is dropped in favour of its root, so a single session never
 * lists twice.
 */
export function classifyObservedProcesses(
  processes: readonly ObservedRawProcess[],
): ClassifiedObservedProcess[] {
  const kindByPid = new Map<number, ObservedAgentKind>();
  const byPid = new Map<number, ObservedRawProcess>();
  for (const proc of processes) {
    const kind = classifyExternalKind(proc.args);
    if (kind) {
      kindByPid.set(proc.pid, kind);
      byPid.set(proc.pid, proc);
    }
  }
  const rows: ClassifiedObservedProcess[] = [];
  for (const [pid, kind] of kindByPid) {
    const proc = byPid.get(pid)!;
    const parentKind = kindByPid.get(proc.ppid);
    // Drop a matched child of a same-kind matched parent (helper under launcher).
    if (parentKind === kind) continue;
    rows.push({ ...proc, externalKind: kind });
  }
  return rows;
}

/** Map a controlling tty to a tmux pane id, from the pane list. */
export function paneForTty(panes: readonly TmuxPaneRow[], tty: string | undefined): TmuxPaneRow | undefined {
  if (!tty) return undefined;
  return panes.find((pane) => pane.tty === tty);
}

// ── Default readers (Linux /proc + tmux), spawn-free where possible ──────────

const CLOCK_TICKS = 100; // SC_CLK_TCK on Linux; the /proc reader's fixed assumption.

function readBootTimeMs(): number | undefined {
  try {
    const stat = readFileSync('/proc/stat', 'utf-8');
    const match = /^btime\s+(\d+)/m.exec(stat);
    return match ? Number(match[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function readControllingTty(pid: number): string | undefined {
  for (const fd of ['0', '1', '2']) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (target.startsWith('/dev/pts/') || (target.startsWith('/dev/tty') && target !== '/dev/tty')) {
        return target;
      }
    } catch {
      // fd absent or not readable — try the next one.
    }
  }
  return undefined;
}

/**
 * The real process-table reader over Linux `/proc`. Every field is read from a
 * pseudo-file or a symlink — no child process is spawned and no target process
 * is signalled or probed. On a host without `/proc` (non-Linux) it yields an
 * empty set, so detection is honestly quiet rather than wrong.
 */
export function defaultProcessTableReader(): ProcessTableReader {
  return {
    read(): readonly ObservedRawProcess[] {
      if (!existsSync('/proc')) return [];
      const bootMs = readBootTimeMs();
      const rows: ObservedRawProcess[] = [];
      let entries: string[];
      try {
        entries = readdirSync('/proc');
      } catch {
        return [];
      }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        let stat: string;
        try {
          stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
        } catch {
          continue; // process exited between readdir and read — skip quietly.
        }
        // comm can contain spaces/parens; it is the substring between the first
        // '(' and the last ')'. Every numeric field follows the last ')'.
        const close = stat.lastIndexOf(')');
        if (close < 0) continue;
        const after = stat.slice(close + 2).split(' ');
        // after[0]=state, after[1]=ppid, after[11]=utime, after[12]=stime, after[19]=starttime (0-based).
        const ppid = Number(after[1] ?? 0);
        const utime = Number(after[11] ?? 0);
        const stime = Number(after[12] ?? 0);
        const starttime = Number(after[19] ?? 0);
        const cpuSeconds = (utime + stime) / CLOCK_TICKS;
        const startedAt = bootMs !== undefined && Number.isFinite(starttime)
          ? bootMs + (starttime / CLOCK_TICKS) * 1000
          : undefined;
        let args = '';
        try {
          args = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replace(/\0+$/, '').split('\0').join(' ');
        } catch {
          continue;
        }
        if (!args) continue; // kernel threads have an empty cmdline — never agents.
        let cwd: string | undefined;
        try {
          cwd = readlinkSync(`/proc/${entry}/cwd`);
        } catch {
          cwd = undefined;
        }
        rows.push({
          pid,
          ppid,
          args,
          tty: readControllingTty(pid),
          cwd,
          startedAt,
          cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0,
        });
      }
      return rows;
    },
  };
}

/**
 * The real tmux pane reader. Runs `tmux list-panes -a -F '#{pane_tty} #{pane_id}'`
 * once (read-only; never a state-changing tmux verb, never a shell). No tmux
 * server, or no panes, yields an empty set — detection then honestly reports no
 * steer channel for every tty.
 */
export function defaultTmuxPaneReader(): TmuxPaneReader {
  return {
    listPanes(): readonly TmuxPaneRow[] {
      let result;
      try {
        result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}'], {
          encoding: 'utf-8',
          timeout: COMMAND_TIMEOUT_MS,
        });
      } catch {
        return [];
      }
      if (result.status !== 0 || !result.stdout) return [];
      const rows: TmuxPaneRow[] = [];
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(' ');
        if (sep <= 0) continue;
        const tty = trimmed.slice(0, sep);
        const paneId = trimmed.slice(sep + 1).trim();
        if (tty && paneId) rows.push({ paneId, tty });
      }
      return rows;
    },
  };
}
