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
 */
export interface OwnedTestChildResult {
  /** The child's exit code, or null when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the child, if one did. */
  readonly signalCode: string | null;
}

export async function runOwnedTestChild(options: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}): Promise<OwnedTestChildResult> {
  const child = Bun.spawn(['bun', 'test', ...options.argv], {
    cwd: options.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: options.env,
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

  try {
    const exitCode = await child.exited;
    return { exitCode, signalCode: child.signalCode };
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onHangup);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    // Reaped, not merely signalled: returning while the child is still dying
    // would let the caller's temp-tree removal race its last writes.
    await child.exited.catch(() => undefined);
  }
}
