/**
 * Run `bun test` as a child the calling script owns for its whole life.
 *
 * Shared by both direct-`bun test` entry points — `scripts/test.ts` and
 * `scripts/leak-scan.ts` — for the same reason they share `withRunTmpDir`:
 * this is one lifecycle, and a second copy of it is a second thing to forget.
 *
 * Both used to spawn synchronously (`execFileSync` / `spawnSync`). A
 * synchronous wait parks the parent inside a native call where no JavaScript
 * runs, so a signal handler cannot fire and the child is never told anything
 * when the parent is killed — a CI job timeout, a cancelled run, Ctrl-C. The
 * CI job that this module was written for ended with the runner's post-job
 * step reporting `Terminate orphan process: pid (2410) (bun)` and
 * `pid (2421) (bun)`: the runner script and its test child, both still alive
 * after the step that started them was gone.
 *
 * Owning the child means both halves:
 *   - a termination signal the parent receives is relayed to the child, and
 *   - the child is killed and reaped in a `finally`, on every path out of this
 *     function, including one where the caller's own cleanup throws.
 *
 * The temp-directory containment in `scripts/test-run-tmp.ts` does the
 * equivalent for directories. It does not and cannot do it for processes: it
 * never had a handle on one.
 *
 * ## What the relay could not cover, and what covers it now
 *
 * The relay above is correct whenever a signal is delivered. A GitHub Actions
 * job timeout does not deliver one: it kills the step's SHELL, so this parent
 * is reparented and keeps waiting, and the child keeps running underneath it.
 * That is why the orphan sweep still reported two live `bun` processes on a
 * later run of the same job, after the relay had already shipped. Three
 * additions close it, and none of them replaces the relay:
 *
 *   - a PARENT-DEATH WATCHDOG here: this process polls its own parent and gives
 *     up when it is gone, so a killed shell takes the runner with it;
 *   - the same watchdog inside the child (`scripts/test-child-watchdog.ts`),
 *     so a SIGKILLed runner — which can relay nothing, by definition — takes
 *     the suite with it;
 *   - a STALL CEILING and an overall CEILING, below, so a run that stops making
 *     progress says so, by name, instead of buying fifteen minutes of silence
 *     and then being killed by something that can only report a timeout.
 *
 * ## Why a stall is measured in tests started, not in output
 *
 * The wedge that motivated the ceiling produced NO output at all: bun's module
 * loader deadlocked between two test files, where no per-test timeout applies.
 * Output is not a liveness signal either way — a fully green local run prints
 * almost nothing for three minutes — so the child reports each test it starts
 * through a heartbeat file, and silence in THAT is what a stall means. The
 * child's last line of output is still captured, because in CI it is the name
 * of the file bun was working on, which is the first thing anyone reading the
 * failure wants.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// From the env-names module, never from the watchdog itself: that one imports
// `bun:test` and registers a global `beforeEach`, and this runs in the PARENT.
import { HEARTBEAT_PATH_ENV, PARENT_PID_ENV } from './test-child-watchdog-env.ts';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_WATCHDOG = resolve(__dirname, 'test-child-watchdog.ts');

/**
 * How long a run may go without a single test STARTING before this module ends
 * it and says so.
 *
 * A ceiling, not a budget: nothing waits it out, and a healthy run never
 * approaches it. Three minutes is comfortably longer than the slowest gap a
 * green run produces (the daemon-backed spine files take tens of seconds each,
 * on a loaded host) and comfortably shorter than the 15-minute CI job timeout,
 * which is the thing it has to beat. Override with `GOODVIBES_TEST_STALL_MS`;
 * set it to 0 to turn the stall ceiling off entirely.
 */
const DEFAULT_STALL_MS = 180_000;

/**
 * The whole run's ceiling, whatever it is doing.
 *
 * Twelve minutes, deliberately under the 15-minute job timeout so that a run
 * which overruns is ended HERE — with the last file bun named and the number of
 * tests it had started — rather than by a runner that can only report that the
 * operation was cancelled. Override with `GOODVIBES_TEST_CEILING_MS`; set it to
 * 0 for no overall ceiling.
 */
const DEFAULT_CEILING_MS = 720_000;

/** SGR colour sequences, stripped before a captured line is quoted back. */
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** How often the ceilings and the parent are checked. */
const POLL_MS = 1_000;

/**
 * How long a child gets to exit on SIGTERM before it is SIGKILLed.
 *
 * A ceiling that asks politely and then waits forever is not a ceiling. A test
 * file only has to install a SIGTERM handler — deliberately, or as part of
 * exercising some shutdown path — for the polite request to be ignored, and
 * this module would then be parked on `child.exited` reproducing the exact
 * silence it exists to end. Five seconds is enough for an honest shutdown.
 */
const KILL_GRACE_MS = 5_000;

/**
 * The heartbeat file lives under the REAL system temp dir, in a directory named
 * for this tool, and every run sweeps its own stale siblings before creating
 * one.
 *
 * It cannot live in the run temp tree: `scripts/test.ts` points the CHILD's
 * `tmpdir()` at that tree, and this file is written by the child and read by
 * the parent, which does not share it. So it gets the same treatment every
 * other direct-`os.tmpdir()` user in this repo gets — a signal kill skips the
 * `finally` that would have removed it, exactly as it skips an `afterAll`, and
 * an unreclaimed per-run directory is an inode leak on a tmpfs.
 *
 * An hour is far longer than any run, so a sibling that is genuinely still
 * going is never touched.
 */
const HEARTBEAT_PREFIX = 'goodvibes-test-heartbeat-';
const STALE_HEARTBEAT_MS = 60 * 60 * 1000;

/** Why this module ended a run itself, when it did. */
export type OwnedTestChildStop = 'stalled' | 'ceiling' | 'parent-died';

export interface OwnedTestChildResult {
  /** The child's exit code, or null when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the child, if one did. */
  readonly signalCode: string | null;
  /** Set when this module ended the run rather than the child finishing. */
  readonly stopped: OwnedTestChildStop | null;
  /** A sentence naming what the run was doing when it was ended. */
  readonly stopReason: string | null;
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** `{ at, started }` from the child's heartbeat, or null before the first one. */
function readHeartbeat(path: string): { at: number; started: number } | null {
  try {
    const [at, started] = readFileSync(path, 'utf8').trim().split(/\s+/);
    const atMs = Number(at);
    if (!Number.isFinite(atMs)) return null;
    return { at: atMs, started: Number(started) || 0 };
  } catch {
    return null;
  }
}

function describeSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Stream a child pipe to this process's own, remembering enough of it to name
 * what the run was doing if it has to be ended.
 */
async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: NodeJS.WriteStream,
  seen: { lastLine: string | null; lastFile: string | null },
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    sink.write(chunk);
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.replace(ANSI_SGR, '').trim();
      if (text === '') continue;
      seen.lastLine = text;
      // bun opens each file with a header — `path/to.test.ts:`, wrapped in a
      // `::group::` under GitHub Actions. That header is printed BEFORE the
      // file is loaded, which is precisely why it is the last thing a wedged
      // run ever printed.
      const header = /^(?:::group::)?([\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(text);
      if (header) seen.lastFile = header[1] as string;
    }
  }
}

export async function runOwnedTestChild(options: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}): Promise<OwnedTestChildResult> {
  const stallMs = positiveEnvMs('GOODVIBES_TEST_STALL_MS', DEFAULT_STALL_MS);
  const ceilingMs = positiveEnvMs('GOODVIBES_TEST_CEILING_MS', DEFAULT_CEILING_MS);
  sweepStaleTmpDirs(tmpdir(), HEARTBEAT_PREFIX, STALE_HEARTBEAT_MS);
  const heartbeatDir = mkdtempSync(join(tmpdir(), HEARTBEAT_PREFIX));
  const heartbeatPath = join(heartbeatDir, 'progress');
  const startedAt = Date.now();
  const initialPpid = process.ppid;

  const child = Bun.spawn(['bun', 'test', '--preload', CHILD_WATCHDOG, ...options.argv], {
    cwd: options.cwd,
    stdin: 'inherit',
    // Piped rather than inherited, so this process can see what the suite last
    // said and quote it back if it has to end the run. Every byte is written
    // straight through unchanged; the capture is a copy, not a filter.
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // A pipe costs the child its colour, because bun colours for a terminal
      // and there is no longer one on the other end. Handing it FORCE_COLOR
      // back when THIS process has a terminal keeps an interactive run looking
      // exactly as it did, and leaves a CI log — which never had one — alone.
      ...(process.stdout.isTTY && options.env.FORCE_COLOR === undefined
        ? { FORCE_COLOR: '1' }
        : {}),
      ...options.env,
      [PARENT_PID_ENV]: String(process.pid),
      [HEARTBEAT_PATH_ENV]: heartbeatPath,
    },
  });

  const relay = (signal: NodeJS.Signals) => (): void => {
    try { child.kill(signal); } catch { /* already gone */ }
  };
  const onInterrupt = relay('SIGINT');
  const onTerminate = relay('SIGTERM');
  const onHangup = relay('SIGHUP');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onHangup);

  const seen: { lastLine: string | null; lastFile: string | null } = { lastLine: null, lastFile: null };
  const pumps = Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array> | undefined, process.stdout, seen),
    pump(child.stderr as ReadableStream<Uint8Array> | undefined, process.stderr, seen),
  ]).catch(() => undefined);

  let stopped: OwnedTestChildStop | null = null;
  let stopReason: string | null = null;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = (kind: OwnedTestChildStop, reason: string): void => {
    if (stopped !== null) return;
    stopped = kind;
    stopReason = reason;
    process.stderr.write(`\ngoodvibes: ${reason}\n`);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    escalation = setTimeout(() => {
      process.stderr.write(
        `goodvibes: the suite did not exit ${describeSeconds(KILL_GRACE_MS)} after SIGTERM; killing it\n`,
      );
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, KILL_GRACE_MS);
    escalation.unref?.();
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    const beat = readHeartbeat(heartbeatPath);
    const progress = beat === null
      ? 'no test has started yet'
      : `${beat.started} tests started, the last of them ${describeSeconds(now - beat.at)} ago`;
    const where = seen.lastFile !== null
      ? `the last file bun named was ${seen.lastFile}`
      : seen.lastLine !== null
        ? `the last line it printed was ${JSON.stringify(seen.lastLine.slice(0, 160))}`
        : 'it has printed nothing at all';

    if (process.ppid !== initialPpid) {
      stop(
        'parent-died',
        `the process that started this runner (pid ${initialPpid}) is gone — ending the suite `
        + `rather than outliving it (${progress}; ${where})`,
      );
      return;
    }
    const idleSince = beat?.at ?? startedAt;
    if (stallMs > 0 && now - idleSince >= stallMs) {
      stop(
        'stalled',
        `no test has started for ${describeSeconds(now - idleSince)} `
        + `(ceiling ${describeSeconds(stallMs)}, GOODVIBES_TEST_STALL_MS) — ${progress}; ${where}. `
        + `A suite that stops starting tests is stuck, not slow; ending it here so the reason is `
        + `on the record instead of a job timeout fifteen minutes from now.`,
      );
      return;
    }
    if (ceilingMs > 0 && now - startedAt >= ceilingMs) {
      stop(
        'ceiling',
        `the suite has run for ${describeSeconds(now - startedAt)}, past its ceiling of `
        + `${describeSeconds(ceilingMs)} (GOODVIBES_TEST_CEILING_MS) — ${progress}; ${where}`,
      );
    }
  }, POLL_MS);

  try {
    const exitCode = await child.exited;
    await pumps;
    return { exitCode, signalCode: child.signalCode, stopped, stopReason };
  } finally {
    clearInterval(watchdog);
    if (escalation !== null) clearTimeout(escalation);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onHangup);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    // Reaped, not merely signalled: returning while the child is still dying
    // would let the caller's temp-tree removal race its last writes.
    await child.exited.catch(() => undefined);
    await pumps;
    rmSync(heartbeatDir, { recursive: true, force: true });
  }
}
