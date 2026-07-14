/**
 * power/linux-logind.ts — the Linux implementation of the power seam.
 *
 * Inhibitors are held by spawning `systemd-inhibit` (the stock unprivileged
 * logind D-Bus client — it calls org.freedesktop.login1.Manager.Inhibit and
 * holds the returned fd for the life of its child). No root, no sudo, ever:
 * an unprivileged user can always hold idle/sleep inhibitors; a lid-switch
 * block may be refused by polkit, which surfaces as an honest per-class
 * denial rather than a fake grant. Requesting classes individually is what
 * makes the per-class grant/deny split observable.
 *
 * The sleep edge is the logind PrepareForSleep signal, watched with a
 * long-lived `dbus-monitor --system` subscription (read-only; no privileges
 * required for signal watching).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from './types.js';

/** Grace period for an inhibit child to prove it started (denials exit fast). */
const START_PROBE_MS = 300;

/**
 * The owner-pid stamp carried in every inhibit child's --who string. A crashed
 * owner cannot release its children, so each child is marked with the pid that
 * spawned it — the reaper kills a stamped child exactly when that pid is dead.
 */
function stampWho(who: string, ownerPid: number): string {
  return `${who} [owner-pid ${ownerPid}]`;
}

const OWNER_PID_STAMP = /\[owner-pid (\d+)\]/;

/**
 * The owner-pid stamp carried by every sleep-edge dbus-monitor child. The
 * watcher is a read-only subscription, so there is no --who string to stamp;
 * instead a SECOND dbus-monitor match rule is appended that can never fire (no
 * such interface or member is ever emitted on the system bus) and whose member
 * name encodes the spawning pid. dbus-monitor accepts multiple match rules and
 * evaluates them as a union, so the real PrepareForSleep rule keeps forwarding
 * while the stamp rule is inert — it exists only so `ps`/the reaper can
 * associate a watcher child with the process that spawned it, exactly like the
 * inhibitor's --who owner-pid stamp. A watcher whose owner pid is dead is a
 * leaked orphan (nothing will ever reap it) and the reaper kills it.
 */
function sleepWatchOwnerMatchRule(ownerPid: number): string {
  return `type='signal',interface='org.goodvibes.SleepWatch',member='GoodvibesSleepWatchOwner${ownerPid}'`;
}

const SLEEP_WATCH_OWNER_PID = /GoodvibesSleepWatchOwner(\d+)/;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is not ours — alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Live sleep-edge dbus-monitor children spawned in this process. An exiting
 * process must never leave a watcher parented to init: an accumulation of
 * orphaned monitors exhausts the system D-Bus broker's per-uid connection
 * quota and can lock every process of that uid out of the system bus. The
 * registry + the once-only exit/signal hooks below guarantee every watcher
 * dies with us — the same discipline the inhibitor children get through the
 * PowerManager's process-exit cleanup.
 */
const liveSleepWatchers = new Set<ChildProcess>();
let sleepWatcherExitHooksInstalled = false;

function killAllSleepWatchers(): void {
  for (const child of liveSleepWatchers) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  liveSleepWatchers.clear();
}

/**
 * Install process exit + SIGINT/SIGTERM/SIGHUP cleanup for sleep-edge watchers
 * ONCE per process. Mirrors the inhibitor exit-hook shape (see manager.ts): a
 * signal handler kills the watchers and re-raises the signal only when it was
 * the sole listener, so a host application that also handles the signal keeps
 * owning shutdown while this handler still reaps the watchers.
 */
function ensureSleepWatcherExitHooks(): void {
  if (sleepWatcherExitHooksInstalled) return;
  sleepWatcherExitHooksInstalled = true;
  process.on('exit', killAllSleepWatchers);
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.once(signal, () => {
      killAllSleepWatchers();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

/**
 * Injectable spawner for the sleep-edge monitor child so unit tests can drive
 * the watcher's subscribe/parse/reap contract without launching a real
 * dbus-monitor. The default spawns the real read-only system-bus monitor.
 */
export type SleepWatchSpawner = (command: string, args: readonly string[]) => ChildProcess;

function defaultSleepWatchSpawner(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Injectable process-table seams so the reaper is fixture-testable. */
export interface OrphanReaperDeps {
  /** List candidate processes: pid + full command line. Default: Linux /proc scan. */
  readonly listProcesses?: (() => ReadonlyArray<{ pid: number; args: string }>) | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  readonly kill?: ((pid: number) => void) | undefined;
  readonly selfPid?: number | undefined;
}

function defaultListProcesses(): ReadonlyArray<{ pid: number; args: string }> {
  if (!existsSync('/proc')) return [];
  const rows: Array<{ pid: number; args: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replace(/\0+$/, '').split('\0').join(' ');
      if (args) rows.push({ pid: Number(entry), args });
    } catch {
      // process exited between readdir and read — skip.
    }
  }
  return rows;
}

/**
 * The dead owner pid stamped on a goodvibes-owned power child in `args`, or
 * null when the row is not one of ours. Two child shapes carry a stamp: the
 * inhibitor (`systemd-inhibit --who=<who> … [owner-pid N]`) and the sleep-edge
 * watcher (`dbus-monitor … member='GoodvibesSleepWatchOwner<N>'`). Anything
 * else — another tool's inhibitor, an unstamped process — returns null and is
 * never touched.
 */
function stampedOwnerPid(args: string, who: string): number | null {
  if (args.includes('systemd-inhibit') && (args.includes(`--who=${who} `) || args.includes(`--who=${who} [`))) {
    const stamp = OWNER_PID_STAMP.exec(args);
    if (stamp) return Number(stamp[1]);
  }
  if (args.includes('dbus-monitor') && args.includes('PrepareForSleep')) {
    const stamp = SLEEP_WATCH_OWNER_PID.exec(args);
    if (stamp) return Number(stamp[1]);
  }
  return null;
}

/**
 * Kill goodvibes-owned power children whose stamped owner pid is DEAD (a
 * crashed owner: nothing will ever release them). Covers both the sleep/idle
 * inhibitors (`systemd-inhibit`, which otherwise block host sleep with no
 * owner) and the sleep-edge watchers (`dbus-monitor`, which otherwise pile up
 * against the system bus's per-uid connection quota). Matches only processes
 * carrying this module's own owner-pid stamp — never anything else. Returns the
 * number reaped.
 */
export async function reapOrphanedInhibitors(who: string, deps: OrphanReaperDeps = {}): Promise<number> {
  const list = deps.listProcesses ?? defaultListProcesses;
  const isAlive = deps.isAlive ?? pidIsAlive;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const selfPid = deps.selfPid ?? process.pid;
  let reaped = 0;
  for (const row of list()) {
    const ownerPid = stampedOwnerPid(row.args, who);
    if (ownerPid === null) continue;
    if (ownerPid === selfPid || isAlive(ownerPid)) continue;
    try {
      kill(row.pid);
      reaped += 1;
      logger.info('[power] reaped an orphaned power child from a dead process', { childPid: row.pid, deadOwnerPid: ownerPid });
    } catch (error) {
      logger.warn('[power] orphaned power-child reap failed', { childPid: row.pid, error: summarizeError(error) });
    }
  }
  return reaped;
}

function spawnInhibitChild(cls: PowerInhibitClass, who: string, why: string): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'systemd-inhibit',
      [`--what=${cls}`, `--who=${who}`, `--why=${why}`, '--mode=block', 'sleep', 'infinity'],
      { stdio: 'ignore', detached: false },
    );
    let settled = false;
    const settle = (value: ChildProcess | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', () => settle(null));
    // A polkit denial exits within milliseconds; a granted inhibitor's child
    // stays alive holding the fd. Probe shortly after spawn.
    child.once('exit', () => settle(null));
    setTimeout(() => {
      if (child.exitCode === null && child.pid) settle(child);
      else settle(null);
    }, START_PROBE_MS).unref?.();
  });
}

export function createLinuxLogindSeam(
  options: { readonly who?: string | undefined; readonly spawnMonitor?: SleepWatchSpawner | undefined } = {},
): PowerPlatformSeam {
  const who = options.who ?? 'goodvibes';
  const spawnMonitor = options.spawnMonitor ?? defaultSleepWatchSpawner;
  return {
    platform: 'linux-logind',
    async isAvailable(): Promise<boolean> {
      return new Promise((resolve) => {
        execFile('systemd-inhibit', ['--list', '--no-legend'], { timeout: 5_000 }, (error) => {
          resolve(!error);
        });
      });
    },
    async reapOrphans(): Promise<number> {
      return reapOrphanedInhibitors(who);
    },
    async inhibit(input): Promise<PowerInhibitHandle | null> {
      const children: Array<{ cls: PowerInhibitClass; child: ChildProcess }> = [];
      const granted: PowerInhibitClass[] = [];
      const denied: PowerInhibitClass[] = [];
      for (const cls of input.classes) {
        // Stamped with the owning pid so a crashed owner's children are
        // recoverable by the reaper (nothing else will ever release them).
        const child = await spawnInhibitChild(cls, stampWho(who, process.pid), input.why);
        if (child) {
          children.push({ cls, child });
          granted.push(cls);
        } else {
          denied.push(cls);
        }
      }
      if (granted.length === 0) return null;
      let released = false;
      return {
        grantedClasses: granted,
        deniedClasses: denied,
        release: async () => {
          if (released) return;
          released = true;
          for (const { cls, child } of children) {
            try {
              child.kill('SIGTERM');
            } catch (error) {
              logger.warn('[power] inhibitor release failed', { cls, error: summarizeError(error) });
            }
          }
        },
      };
    },
    onPrepareForSleep(callback): () => void {
      // Register the process-exit reaper before the first spawn so the watcher
      // can never outlive us (see liveSleepWatchers).
      ensureSleepWatcherExitHooks();
      const monitor = spawnMonitor('dbus-monitor', [
        '--system',
        "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'",
        // Inert stamp rule carrying our pid so a leaked watcher is reapable.
        sleepWatchOwnerMatchRule(process.pid),
      ]);
      liveSleepWatchers.add(monitor);
      let sawSignalHeader = false;
      monitor.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf-8').split('\n')) {
          if (line.includes('member=PrepareForSleep')) {
            sawSignalHeader = true;
            continue;
          }
          if (!sawSignalHeader) continue;
          const match = line.match(/boolean (true|false)/);
          if (match) {
            sawSignalHeader = false;
            try {
              callback(match[1] === 'true');
            } catch (error) {
              logger.warn('[power] PrepareForSleep callback failed', { error: summarizeError(error) });
            }
          }
        }
      });
      monitor.once('error', (error) => {
        liveSleepWatchers.delete(monitor);
        logger.warn('[power] dbus-monitor unavailable; sleep-edge signal disabled', { error: summarizeError(error) });
      });
      // Self-deregister if the monitor exits on its own so the registry never
      // holds a dead child reference.
      monitor.once('exit', () => {
        liveSleepWatchers.delete(monitor);
      });
      monitor.unref?.();
      return () => {
        liveSleepWatchers.delete(monitor);
        try {
          monitor.kill('SIGTERM');
        } catch {
          // already gone
        }
      };
    },
  };
}
