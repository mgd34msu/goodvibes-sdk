/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * observed/source.ts — the ObservedAgentSource: the fleet's read-only view of
 * externally-launched coding-agent sessions on this host, plus the one genuine
 * steer channel (tmux send-keys) where a foreign session exposes it.
 *
 * Responsibility boundary (owner ruling): these rows are OBSERVED, not owned.
 * The source is composed as an OPTIONAL registry dep and is deliberately NOT a
 * source in fleet-count.ts — so an observed row can never count against
 * fleet.maxSize (proven structurally, not by a filter). Stop is never offered.
 * Steering rides whatever channel the foreign session genuinely exposes and
 * honestly says when there is none.
 *
 * Cost: detection runs at most once per `refreshIntervalMs` (a lazy TTL over the
 * injected clock), so folding observed rows into every fleet snapshot/tick stays
 * cheap — a cached read between refreshes. The CPU-delta that drives liveness is
 * measured across those refresh boundaries, so `active`/`quiet` reflects CPU
 * burned in the last refresh interval, not per-query noise.
 */
import type { ObservedAgentKind, ObservedLiveness, ObservedSteerChannel, SteerResult } from '../types.js';
import {
  classifyObservedProcesses,
  defaultProcessTableReader,
  defaultTmuxPaneReader,
  paneForTty,
  type ProcessTableReader,
  type TmuxPaneReader,
} from './detect.js';
import { spawnSync } from 'node:child_process';

/** One observed foreign coding-agent session, assembled read-only. The adapter turns this into a ProcessNode. */
export interface ObservedAgentRow {
  readonly externalKind: ObservedAgentKind;
  readonly pid: number;
  readonly ppid: number;
  /** Full command line — the adapter derives the row label from it. */
  readonly args: string;
  readonly cwd?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly liveness: ObservedLiveness;
  readonly steer: ObservedSteerChannel;
}

/** Injectable tmux command runner for the steer send-keys — read/write to the pane only, never a shell. */
export interface TmuxCommandRunner {
  run(args: readonly string[]): { readonly status: number | null; readonly stderr: string };
}

const STEER_TIMEOUT_MS = 5_000;

/** Real send-keys runner: spawnSync tmux, hard timeout, never a shell. */
export function defaultTmuxCommandRunner(): TmuxCommandRunner {
  return {
    run(args) {
      try {
        const result = spawnSync('tmux', [...args], { encoding: 'utf-8', timeout: STEER_TIMEOUT_MS });
        return { status: result.status, stderr: result.stderr ?? '' };
      } catch (error) {
        return { status: null, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export interface ObservedAgentSourceDeps {
  readonly processReader?: ProcessTableReader | undefined;
  readonly paneReader?: TmuxPaneReader | undefined;
  readonly steerRunner?: TmuxCommandRunner | undefined;
  readonly now?: (() => number) | undefined;
  /** Detection cadence — at most one scan per this many ms (default 2500). */
  readonly refreshIntervalMs?: number | undefined;
}

const DEFAULT_REFRESH_INTERVAL_MS = 2_500;

function livenessDetail(state: 'active' | 'quiet', firstSighting: boolean): string {
  if (firstSighting) return 'first observation — no prior CPU sample to compare yet';
  return state === 'active'
    ? 'CPU advanced since the last sample — the session is doing work'
    : 'no CPU burned since the last sample — quiet, but this is not proof it is idle (it may be waiting on the network or on a human)';
}

/**
 * The observed-agent source. `list()` returns the current observed rows,
 * refreshing the read-only scan at most once per `refreshIntervalMs`. `steer()`
 * drives a tmux-hosted foreign session with the exact three-send recipe.
 */
export class ObservedAgentSource {
  private readonly processReader: ProcessTableReader;
  private readonly paneReader: TmuxPaneReader;
  private readonly steerRunner: TmuxCommandRunner;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;

  /** pid → cumulative CPU seconds at the previous refresh (the liveness delta baseline). */
  private readonly cpuByPid = new Map<number, number>();
  private cached: readonly ObservedAgentRow[] = [];
  private lastScanAt = 0;
  private scanned = false;

  constructor(deps: ObservedAgentSourceDeps = {}) {
    this.processReader = deps.processReader ?? defaultProcessTableReader();
    this.paneReader = deps.paneReader ?? defaultTmuxPaneReader();
    this.steerRunner = deps.steerRunner ?? defaultTmuxCommandRunner();
    this.now = deps.now ?? ((): number => Date.now());
    this.refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /** Current observed rows. Lazily re-scans (read-only) at most once per refresh interval. */
  list(): readonly ObservedAgentRow[] {
    const at = this.now();
    if (this.scanned && at - this.lastScanAt < this.refreshIntervalMs) return this.cached;
    this.cached = this.scan();
    this.lastScanAt = at;
    this.scanned = true;
    return this.cached;
  }

  private scan(): readonly ObservedAgentRow[] {
    const classified = classifyObservedProcesses(this.processReader.read());
    const panes = classified.length > 0 ? this.paneReader.listPanes() : [];
    const rows: ObservedAgentRow[] = [];
    const seenPids = new Set<number>();
    for (const proc of classified) {
      seenPids.add(proc.pid);
      const prior = this.cpuByPid.get(proc.pid);
      const firstSighting = prior === undefined;
      const state: 'active' | 'quiet' = !firstSighting && proc.cpuSeconds > prior ? 'active' : 'quiet';
      this.cpuByPid.set(proc.pid, proc.cpuSeconds);
      const pane = paneForTty(panes, proc.tty);
      const steer: ObservedSteerChannel = pane
        ? { kind: 'tmux', paneId: pane.paneId, tty: pane.tty }
        : {
            kind: 'none',
            reason: proc.tty
              ? `no tmux pane maps to this session's terminal (${proc.tty})`
              : 'the session has no controlling terminal to steer through',
          };
      rows.push({
        externalKind: proc.externalKind,
        pid: proc.pid,
        ppid: proc.ppid,
        args: proc.args,
        cwd: proc.cwd,
        startedAt: proc.startedAt,
        liveness: { state, cpuSeconds: proc.cpuSeconds, detail: livenessDetail(state, firstSighting) },
        steer,
      });
    }
    // Prune CPU baselines for pids that are gone so the map cannot grow unbounded.
    for (const pid of [...this.cpuByPid.keys()]) {
      if (!seenPids.has(pid)) this.cpuByPid.delete(pid);
    }
    return rows;
  }

  /**
   * Steer a tmux-hosted foreign session with the exact three-send recipe: one
   * send carries the literal message text, then two separate Enter sends. An
   * honest refusal (queued:false) when the row exposes no tmux channel, or when
   * a send-keys call fails. STOP is never offered here — this is steer only.
   */
  steer(row: ObservedAgentRow, text: string): SteerResult {
    if (row.steer.kind !== 'tmux') {
      return { queued: false, reason: `this session cannot be steered: ${row.steer.reason}` };
    }
    const pane = row.steer.paneId;
    const sends: readonly (readonly string[])[] = [
      ['send-keys', '-t', pane, '-l', '--', text],
      ['send-keys', '-t', pane, 'Enter'],
      ['send-keys', '-t', pane, 'Enter'],
    ];
    for (const args of sends) {
      const result = this.steerRunner.run(args);
      if (result.status !== 0) {
        const detail = result.stderr.trim() || 'tmux send-keys failed';
        return { queued: false, reason: `steering ${pane} failed: ${detail}` };
      }
    }
    return { queued: true, messageId: crypto.randomUUID() };
  }
}
