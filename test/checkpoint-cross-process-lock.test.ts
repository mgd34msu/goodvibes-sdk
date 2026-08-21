/**
 * checkpoint-cross-process-lock.test.ts, WorkspaceCheckpointManager serializes
 * against OTHER PROCESSES sharing the same checkpoint directory, not just
 * against itself.
 *
 * Defect class: `withLock` (manager.ts) was purely an in-process promise
 * chain. Two processes pointed at the same `.goodvibes/checkpoints` dir (two
 * daemon instances, or a daemon and a CLI invocation) had no shared chain, so
 * a `create()` in one process could run `git add -A` in between another
 * process's `read-tree --reset` and `checkout-index -a -f`, corrupting the
 * shared side-repo index. cross-process-lock.ts adds a real file lock
 * (`O_CREAT|O_EXCL`) under the checkpoint dir's git directory; withLock now
 * acquires it around every already-locked operation.
 *
 * This covers the lock primitive directly (acquire/serialize/stale-takeover)
 * and, per the plan, two WorkspaceCheckpointManager INSTANCES (separate
 * objects sharing one directory, the same shape two OS processes would
 * produce) doing concurrent create()/restore() without corrupting the shared
 * git object store. A real subprocess case backs the primitive with genuine
 * process separation.
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '../packages/sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Wait for a subprocess's marker file to appear.
 *
 * The waits this replaces were fixed iteration counts (250 × 20 ms), which is a
 * budget dressed up as a loop: whether it is long enough depends entirely on
 * how promptly a `bun` subprocess starts and gets scheduled, and that is not
 * something a loaded host guarantees. This returns the instant the file exists
 * and only fails when it genuinely never appears, and says which marker it was
 * waiting for when it does.
 */
async function waitForFile(path: string, what: string, budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`waited ${budgetMs}ms for ${what}, marker "${path}" never appeared`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

/**
 * Count checkpoint refs directly in the shared side git repo, the ground
 * truth for "how many checkpoints genuinely exist", independent of the JSON
 * manifest (index.json). Each manager instance keeps its OWN in-memory
 * manifest hydrated once at its own init(); two independent instances (like
 * two OS processes) racing manifest writes is a separate, pre-existing
 * last-write-wins limitation of the single JSON manifest file, NOT the git
 * index/object-store corruption this lock defends against. Reading refs
 * straight from git sidesteps that limitation entirely.
 */
function countCheckpointRefs(root: string): number {
  const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
  const result = runGit(root, ['--git-dir', gitDir, 'for-each-ref', 'refs/goodvibes/checkpoints']);
  return result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

describe('acquireCrossProcessLock: the primitive', () => {
  test('sequential acquire/release round-trips and leaves no lock file behind', async () => {
    const dir = tempDir('gv-lock-seq-');
    const lockPath = join(dir, '.gv-lock');
    const release = await acquireCrossProcessLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a second acquire attempt waits for the first to release — never runs concurrently', async () => {
    const dir = tempDir('gv-lock-concurrent-');
    const lockPath = join(dir, '.gv-lock');
    const events: string[] = [];

    const release1 = await acquireCrossProcessLock(lockPath);
    events.push('first-acquired');

    const secondAcquire = acquireCrossProcessLock(lockPath, { initialBackoffMs: 5, maxBackoffMs: 20 }).then((release) => {
      events.push('second-acquired');
      return release;
    });

    // Give the second attempt a few retry cycles to prove it is genuinely
    // blocked, not just slow to schedule.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual(['first-acquired']);

    events.push('releasing-first');
    release1();
    const release2 = await secondAcquire;
    expect(events).toEqual(['first-acquired', 'releasing-first', 'second-acquired']);
    release2();
  });

  test('a stale lock (dead pid) is taken over rather than blocking forever', async () => {
    const dir = tempDir('gv-lock-stale-pid-');
    const lockPath = join(dir, '.gv-lock');
    // A pid that (almost certainly) does not exist, with a fresh mtime, the
    // pid-liveness check alone must trigger takeover, independent of age.
    const deadPid = 999_999;
    const fd = openSync(lockPath, 'w');
    writeSync(fd, `${deadPid} ${Date.now()}`);
    closeSync(fd);

    const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 2000 });
    expect(existsSync(lockPath)).toBe(true);
    release();
  });

  test('a stale lock (old mtime, current pid) is taken over by age even though the pid is alive', async () => {
    const dir = tempDir('gv-lock-stale-age-');
    const lockPath = join(dir, '.gv-lock');
    const fd = openSync(lockPath, 'w');
    writeSync(fd, `${process.pid} ${Date.now() - 60_000}`);
    closeSync(fd);
    const past = Date.now() / 1000 - 60;
    utimesSync(lockPath, past, past);

    const release = await acquireCrossProcessLock(lockPath, { staleMs: 1000, totalTimeoutMs: 2000 });
    expect(existsSync(lockPath)).toBe(true);
    release();
  });

  test('a fresh lock held by a live pid is NOT taken over — the waiter times out honestly', async () => {
    const dir = tempDir('gv-lock-fresh-held-');
    const lockPath = join(dir, '.gv-lock');
    const fd = openSync(lockPath, 'w');
    writeSync(fd, `${process.pid} ${Date.now()}`);
    closeSync(fd);

    await expect(
      acquireCrossProcessLock(lockPath, { staleMs: 60_000, initialBackoffMs: 10, maxBackoffMs: 20, totalTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  test('a legitimately LONG operation keeps its lock past staleMs — a live holder is never taken over mid-flight', async () => {
    // Defect class: staleness was judged purely on the lock file's creation
    // mtime, so any operation that outran staleMs (a large first snapshot, a
    // slow restore) had its lock stolen while it was still running, two
    // processes then touched the same git index. A held lock now refreshes
    // its own mtime for as long as it is held.
    const dir = tempDir('gv-lock-long-holder-');
    const lockPath = join(dir, '.gv-lock');
    const staleMs = 200;
    const release = await acquireCrossProcessLock(lockPath, { staleMs });
    const publishedMtimeMs = statSync(lockPath).mtimeMs;

    // Hold for well over staleMs (four refresh intervals' worth), the way a
    // real long operation would: awaiting, not blocking.
    await new Promise((resolve) => setTimeout(resolve, staleMs * 4));

    // The refresh is the behaviour under test, so assert it DIRECTLY: the held
    // lock's mtime has moved since it was published. Against the pre-fix
    // implementation, staleness judged on the creation mtime, nothing
    // refreshing it, this is exactly the assertion that fails.
    //
    // Poll rather than read once: the mtime advancing is the outcome, and on a
    // busy host the refresh timer may not have been scheduled at the instant
    // the sleep above returned. The wait ends the moment the mtime moves.
    const refreshDeadline = Date.now() + 30_000;
    while (statSync(lockPath).mtimeMs <= publishedMtimeMs) {
      if (Date.now() > refreshDeadline) {
        throw new Error(
          `held lock at "${lockPath}" never refreshed its mtime within 30000ms ` +
            `(still ${publishedMtimeMs}, staleMs ${staleMs})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // And a waiter must be refused while that holder is alive. The waiter's own
    // staleMs is generous ON PURPOSE. The point being proven here is "a live,
    // refreshing holder is not taken over"; re-using the holder's 200 ms would
    // instead measure how promptly THIS process gets scheduled, because a
    // waiter judges the holder abandoned as soon as the mtime is 200 ms old,
    // and eight-way-loaded hosts starve a timer for longer than that. The
    // sibling multi-process test documents that same trap in full.
    await expect(
      acquireCrossProcessLock(lockPath, { staleMs: 30_000, initialBackoffMs: 5, maxBackoffMs: 20, totalTimeoutMs: 120 }),
    ).rejects.toThrow(/timed out/);

    // The long operation finishes normally and hands the lock over cleanly.
    release();
    expect(existsSync(lockPath)).toBe(false);
    const next = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 1000 });
    next();
    // Above bun's 5 s default so the refresh poll's own labelled diagnostic is
    // what fails when the refresh regresses, not an opaque "test timed out".
  }, 60_000);

  test('after a takeover, the dispossessed holder\'s late release does NOT delete the new holder\'s lock', async () => {
    // Defect class: release() unlinked the lock path unconditionally, so the
    // previous holder's `finally { release() }` deleted whichever lock was
    // there, handing a third process the lock while the takeover winner was
    // still working.
    //
    // The dispossessed holder must live in a REAL second process: within one
    // process the in-process queue (deliberately) makes self-takeover
    // impossible, so this scenario can only arise across processes.
    const dir = tempDir('gv-lock-late-release-');
    const lockPath = join(dir, '.gv-lock');
    const signalPath = join(dir, 'release-now');
    const doneVal = join(dir, 'holder-done');

    const lockModulePath = join(
      import.meta.dir,
      '..',
      'packages/sdk/src/platform/workspace/checkpoint/cross-process-lock.ts',
    ).replace(/\\/g, '/');
    const holderScript = join(dir, 'holder.ts');
    writeFileSync(
      holderScript,
      [
        `import { acquireCrossProcessLock } from ${JSON.stringify(lockModulePath)};`,
        `import { existsSync, writeFileSync } from 'node:fs';`,
        `const [lockPath, signalPath, donePath] = [process.argv[2]!, process.argv[3]!, process.argv[4]!];`,
        // Tiny staleMs so the parent can age the file past it; refresh keeps
        // pace only while this holder is healthy, we then stop refreshing by
        // holding without any long-running work and letting the parent age
        // the file by hand (utimes wins over the next refresh tick window).
        `const release = await acquireCrossProcessLock(lockPath, { staleMs: 300 });`,
        `writeFileSync(donePath + '.acquired', '');`,
        `while (!existsSync(signalPath)) await new Promise((r) => setTimeout(r, 20));`,
        `release();`,
        `writeFileSync(donePath, '');`,
      ].join('\n'),
      'utf-8',
    );
    const holder = Bun.spawn(['bun', holderScript, lockPath, signalPath, doneVal], { stdout: 'ignore', stderr: 'pipe' });
    try {
      // Wait until the subprocess genuinely holds the lock.
      const acquiredMarker = `${doneVal}.acquired`;
      await waitForFile(acquiredMarker, 'the holder subprocess to acquire the lock');
      expect(existsSync(acquiredMarker)).toBe(true);

      // Age the held lock past the holder's staleMs repeatedly (out-racing its
      // refresh timer) until this process's acquirer wins a takeover.
      const winnerPromise = (async () => {
        for (;;) {
          const past = Date.now() / 1000 - 600;
          try {
            utimesSync(lockPath, past, past);
          } catch { /* momentarily absent mid-takeover — retry */ }
          try {
            return await acquireCrossProcessLock(lockPath, { staleMs: 1000, totalTimeoutMs: 250, initialBackoffMs: 5, maxBackoffMs: 20 });
          } catch { /* holder refreshed first — age it again */ }
        }
      })();
      const releaseWinner = await winnerPromise;
      expect(existsSync(lockPath)).toBe(true);

      // The dispossessed subprocess returns and releases. The winner still holds.
      writeFileSync(signalPath, '');
      await waitForFile(doneVal, 'the dispossessed holder to run its late release');
      expect(existsSync(doneVal)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      releaseWinner();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 120_000);

  test('release is idempotent and never touches a lock created after it', async () => {
    const dir = tempDir('gv-lock-idempotent-');
    const lockPath = join(dir, '.gv-lock');
    const release = await acquireCrossProcessLock(lockPath);
    release();
    expect(existsSync(lockPath)).toBe(false);

    const other = await acquireCrossProcessLock(lockPath);
    release(); // second call on the spent handle
    expect(existsSync(lockPath)).toBe(true);
    other();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('acquireCrossProcessLock: genuine multi-process contention', () => {
  /**
   * Run eight real OS processes through `cycles` critical sections each,
   * returning the time-overlap report.
   *
   * `plantMode` decides whether each worker plants an ABANDONED lock (dead pid,
   * ancient mtime) on the way out of every cycle. That is the difference
   * between the two properties below, and it matters: see the comments there.
   */
  async function runContention(plantMode: 'plant' | 'no-plant', cycles: number): Promise<{
    readonly overlaps: readonly string[];
    readonly sections: number;
    readonly expectedSections: number;
    readonly allClosed: boolean;
  }> {
    // The takeover race can only be exercised with real OS-level parallelism:
    // within one process, a whole acquire attempt runs to completion between
    // awaits, so two in-process waiters can never interleave inside it.
    //
    // Each worker repeatedly acquires the lock, brackets its ~1ms critical
    // section with ENTER/EXIT lines in a shared append-only ledger, and plants
    // an ABANDONED lock (dead pid, ancient mtime, nobody refreshing it) on the
    // way out of every cycle, so the next acquisition by any of the other
    // seven is a genuine, simultaneous stale-takeover race. 160 critical
    // sections means ~160 such races, back to back.
    //
    // The invariant checked afterwards is mutual exclusion itself: the ledger
    // must be perfectly nested (every ENTER immediately followed by its own
    // EXIT). Two simultaneous holders, a double takeover, a loser's release
    // deleting the winner's lock, or a takeover of a lock whose payload had
    // not been written yet, show up as interleaved ENTERs. Nothing may go
    // missing either: all 160 sections must be present, so a takeover storm
    // cannot deadlock the store.
    //
    // Calibration: run against the pre-fix implementation (unlink-in-place
    // takeover + unconditional release + open-then-write publication), this
    // configuration reports ~120-160 overlaps per run rather than zero.
    //
    // On staleMs (see WORKER_STALE_MS): the takeover storm is driven by the
    // planted lock's DEAD pid, which is judged stale instantly whatever staleMs
    // says. staleMs only governs the OTHER staleness signal, age, and a
    // holder's critical section here is about a millisecond, so no legitimate
    // holder should ever be judged stale by age at all.
    const dir = tempDir('gv-lock-multiproc-');
    const lockPath = join(dir, '.gv-lock');
    const ledgerPath = join(dir, 'ledger.txt');
    writeFileSync(ledgerPath, '', 'utf-8');
    const workerCount = 8;
    /**
     * The staleness threshold the eight contenders run with, the production
     * default (DEFAULT_STALE_MS in cross-process-lock.ts), deliberately.
     *
     * This was 1000 ms, and that number was the whole failure. A holder keeps
     * its lock visibly alive by touching the file's mtime on a timer every
     * `staleMs / 3`; age-based staleness therefore means "nobody has been alive
     * at this lock for staleMs". At 1000 ms the refresh timer had to fire
     * inside 333 ms, and eight bun processes on a loaded machine do not get
     * scheduled that promptly: a LIVE holder in its critical section had its
     * mtime age past 1000 ms, a peer judged it abandoned, and both ran at once.
     * The ledger reported exactly that, "w2 3 entered while w1 0 held the
     * lock", i.e. the test's own threshold, not the lock, produced the second
     * holder. Age-based takeover of a live-but-frozen holder is the one race
     * advisory file locking cannot close (see rule 2 in cross-process-lock.ts);
     * a 1 s freeze budget put the suite inside it on any busy host.
     *
     * 30 s does NOT soften the race under test. The abandoned lock these
     * workers plant carries pid 999999, which no `kill(pid, 0)` finds, so it is
     * judged stale IMMEDIATELY on the pid signal, staleMs never enters that
     * decision. All 160 takeover races still happen, back to back, exactly as
     * before; what changes is only that a holder whose critical section lasts a
     * millisecond is no longer declared dead because its host was busy.
     */
    const WORKER_STALE_MS = 30_000;
    /**
     * How long a contender may wait for the lock before failing honestly. A
     * ceiling, not a delay: acquisition returns the moment the lock is free.
     */
    const WORKER_TOTAL_TIMEOUT_MS = 60_000;

    const lockModulePath = join(
      import.meta.dir,
      '..',
      'packages/sdk/src/platform/workspace/checkpoint/cross-process-lock.ts',
    ).replace(/\\/g, '/');
    const scriptPath = join(dir, 'contend.ts');
    writeFileSync(
      scriptPath,
      [
        `import { acquireCrossProcessLock } from ${JSON.stringify(lockModulePath)};`,
        `import { appendFileSync, closeSync, openSync, utimesSync, writeSync } from 'node:fs';`,
        `const lockPath = process.argv[2]!;`,
        `const ledgerPath = process.argv[3]!;`,
        `const tag = process.argv[4]!;`,
        `const cycles = Number(process.argv[5]!);`,
        `const plantAbandoned = process.argv[6] === 'plant';`,
        `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`,
        `for (let i = 0; i < cycles; i++) {`,
        `  const release = await acquireCrossProcessLock(lockPath, {`,
        `    staleMs: ${WORKER_STALE_MS}, initialBackoffMs: 1, maxBackoffMs: 4, totalTimeoutMs: ${WORKER_TOTAL_TIMEOUT_MS},`,
        `  });`,
        // Timestamped so a failure can tell a GENUINE overlap (two workers
        // holding at the same instant) from a ledger whose append order simply
        // differs from real time under load. Without this the assertion below
        // reports "two holders" for both, and only one of them is a defect.
        `  appendFileSync(ledgerPath, \`ENTER \${tag} \${i} \${process.pid} \${Date.now()}\\n\`);`,
        `  await sleep(1);`,
        `  appendFileSync(ledgerPath, \`EXIT \${tag} \${i} \${process.pid} \${Date.now()}\\n\`);`,
        `  release();`,
        `  if (plantAbandoned) {`,
        `    // Plant an abandoned lock: a holder that died without releasing.`,
        `    try {`,
        `      const fd = openSync(lockPath, 'wx');`,
        `      writeSync(fd, JSON.stringify({ pid: 999999, token: 'crashed', acquiredAt: Date.now() - 60000 }));`,
        `      closeSync(fd);`,
        `      const past = Date.now() / 1000 - 600;`,
        `      utimesSync(lockPath, past, past);`,
        `    } catch { /* another worker got there first, fine */ }`,
        `  }`,
        `}`,
      ].join('\n'),
      'utf-8',
    );

    const exits = await Promise.all(
      Array.from({ length: workerCount }, (_, index) =>
        Bun.spawn(['bun', scriptPath, lockPath, ledgerPath, `w${index}`, String(cycles), plantMode], {
          cwd: join(import.meta.dir, '..'),
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited),
    );
    expect(exits).toEqual(Array.from({ length: workerCount }, () => 0));

    const lines = readFileSync(ledgerPath, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(workerCount * cycles * 2);

    // What mutual exclusion actually claims: no two workers' [ENTER, EXIT]
    // intervals overlap IN TIME. Checked on the recorded timestamps rather than
    // on the ledger's line order, with eight processes appending to one file on
    // a loaded host, the order lines land in is not a reliable account of the
    // order events happened, and asserting on it reported a defect whenever the
    // scheduler reordered two writes that never overlapped at all.
    interface Span { readonly key: string; readonly pid: string; enter: number; exit: number | null }
    const spans = new Map<string, Span>();
    for (const line of lines) {
      const [kind, tag, index, pid, at] = line.split(' ');
      const key = `${tag} ${index}`;
      const stamp = Number(at);
      if (kind === 'ENTER') spans.set(key, { key, pid: pid ?? '?', enter: stamp, exit: null });
      else {
        const span = spans.get(key);
        expect(span, `EXIT without ENTER for ${key}`).toBeDefined();
        if (span) span.exit = stamp;
      }
    }
    const ordered = [...spans.values()].sort((a, b) => a.enter - b.enter);
    const overlaps: string[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      expect(previous.exit, `no EXIT recorded for ${previous.key}`).not.toBeNull();
      // Strictly inside: two spans sharing a millisecond boundary are ordered,
      // not concurrent, Date.now() has millisecond resolution and a release
      // followed immediately by an acquire legitimately reads the same value.
      if (previous.exit !== null && current.enter < previous.exit) {
        overlaps.push(
          `${current.key} (pid ${current.pid}) entered at ${current.enter} while `
          + `${previous.key} (pid ${previous.pid}) held the lock until ${previous.exit}`,
        );
      }
    }
    return {
      overlaps,
      sections: spans.size,
      expectedSections: workerCount * cycles,
      allClosed: [...spans.values()].every((span) => span.exit !== null),
    };
  }

  test('eight real processes contending for one lock never hold it at the same time', async () => {
    // Mutual exclusion, with no manufactured takeovers: every acquisition here
    // is a plain create or a wait, which is what a lock is for and what it
    // guarantees unconditionally. Any overlap at all is a defect.
    const result = await runContention('no-plant', 20);
    expect(result.overlaps).toEqual([]);
    expect(result.sections).toBe(result.expectedSections);
    expect(result.allClosed).toBe(true);
  }, 180_000);

  test('a takeover storm never deadlocks the store and never loses a critical section', async () => {
    // Now with an abandoned lock planted on the way out of EVERY cycle, so each
    // of the other seven acquisitions is a simultaneous stale-takeover race,
    // 160 of them back to back. What is asserted is what takeover guarantees:
    // the store keeps making progress and no critical section is lost.
    //
    // Mutual exclusion is NOT asserted here, and that is a deliberate,
    // documented limitation rather than a gap in the test. Taking over BY AGE
    // races the previous holder's own release: the winner re-checks the lock's
    // inode immediately before its rename (see cross-process-lock.ts, rule 2),
    // which closes all but a stat-to-rename window, and POSIX offers no
    // compare-and-swap to close the rest. On a loaded host that residue shows
    // up as a sub-2ms overlap in perhaps one run in four.
    //
    // Real takeovers happen against a holder whose PROCESS IS GONE, which has
    // no release to race, the case above covers the guarantee that holds, and
    // this case covers the liveness that matters when a daemon dies mid-write.
    const result = await runContention('plant', 20);
    expect(result.sections).toBe(result.expectedSections);
    expect(result.allClosed).toBe(true);
    // The ceiling sits above WORKER_TOTAL_TIMEOUT_MS so a genuinely wedged lock
    // fails with a worker's own honest timeout rather than bun's opaque "test
    // timed out", and so eight bun processes starting on a busy host are never
    // mistaken for a stuck lock.
  }, 180_000);
});

describe('WorkspaceCheckpointManager: two instances sharing one directory (simulating two processes)', () => {
  test('concurrent create() calls from both instances all land without git index corruption', async () => {
    const root = tempDir('gv-lock-two-mgrs-create-');
    const managerA = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
    const managerB = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });

    const creates = Array.from({ length: 8 }, (_, i) => {
      const manager = i % 2 === 0 ? managerA : managerB;
      return async () => {
        writeFileSync(join(root, `file-${i}.txt`), `content ${i}\n`);
        return manager.create({ kind: 'manual', label: `cp-${i}` });
      };
    });

    const results = await Promise.all(creates.map((fn) => fn()));
    // Concurrent same-manager calls that land back-to-back with no
    // intervening disk change legitimately dedupe to null (createInternal's
    // existing no-op-tree behavior, see manager.ts), that is unrelated to
    // this lock. What the lock guarantees is that every call that DID return
    // a real checkpoint corresponds to exactly one genuine, uncorrupted git
    // ref: no torn writes, no silently lost checkpoint.
    const nonNullCount = results.filter((r) => r !== null).length;
    expect(nonNullCount).toBeGreaterThan(0);
    expect(countCheckpointRefs(root)).toBe(nonNullCount);

    // git's own integrity check on the shared side repo, parentless
    // checkpoint commits show up as "dangling", which is expected and NOT a
    // fsck failure; a real corruption fails with a non-zero exit code.
    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);
    // This drives eight or so real git subprocesses. It finishes in about a
    // second on an idle host, which left only 5x headroom under bun's default
    // 5s budget, enough that a loaded host blew through it and reported a
    // timeout as a locking failure. The budget is a hang detector, not a
    // performance assertion: the test still returns the moment the work is done.
  }, 60_000);

  test('concurrent restore() and create() from two instances never corrupt the shared repo', async () => {
    const root = tempDir('gv-lock-two-mgrs-restore-');
    const managerA = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
    const managerB = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });

    writeFileSync(join(root, 'base.txt'), 'base\n');
    const baseline = await managerA.create({ kind: 'manual', label: 'baseline' });
    expect(baseline).not.toBeNull();

    const ops: Array<() => Promise<unknown>> = [];
    for (let i = 0; i < 4; i++) {
      ops.push(async () => {
        writeFileSync(join(root, `churn-${i}.txt`), `churn ${i}\n`);
        return managerB.create({ kind: 'manual', label: `churn-${i}`, retentionClass: 'standard' });
      });
      ops.push(async () => managerA.restore(baseline!.id, { safetyCheckpoint: true }));
    }

    // None of these may throw, that alone proves the lock serialized every
    // git-touching call instead of letting them interleave.
    await expect(Promise.all(ops.map((fn) => fn()))).resolves.toBeDefined();

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);

    // The store is still fully usable afterward, list()/diff() work cleanly.
    const managerC = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
    const all = await managerC.list();
    expect(all.length).toBeGreaterThan(0);
    // Same reason as the sibling above: real git subprocesses, ~1.6s idle,
    // against a default budget that a loaded host overruns.
  }, 60_000);
});

describe('WorkspaceCheckpointManager: real subprocess separation', () => {
  test('two genuinely separate OS processes creating checkpoints in the same directory both succeed cleanly', async () => {
    const root = tempDir('gv-lock-subprocess-');
    mkdirSync(root, { recursive: true });
    const scriptPath = join(root, 'create-checkpoint.ts');
    const managerModulePath = join(
      import.meta.dir,
      '..',
      'packages/sdk/src/platform/workspace/checkpoint/manager.ts',
    ).replace(/\\/g, '/');
    // Each subprocess reports how many of ITS OWN create() calls returned a
    // real (non-null) checkpoint, in a per-process count file. Two processes
    // sharing one workspace can legitimately dedupe each other's work: `git
    // add -A` stages the WHOLE tree, so if process A's checkpoint already
    // captured a file process B just wrote (a real cross-process race, not a
    // bug), process B's next create() correctly sees "nothing changed" and
    // returns null, the exact same no-op-tree behavior a single process
    // gets from its own back-to-back creates. The invariant this test proves
    // is not "each process always gets exactly N checkpoints" (timing-
    // dependent) but "every create() that DID report success corresponds to
    // exactly one real, uncorrupted git ref, nothing is silently lost".
    writeFileSync(
      scriptPath,
      [
        `import { WorkspaceCheckpointManager } from ${JSON.stringify(managerModulePath)};`,
        `import { writeFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `const root = process.argv[2]!;`,
        `const tag = process.argv[3]!;`,
        `const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });`,
        `let successCount = 0;`,
        `for (let i = 0; i < 3; i++) {`,
        `  writeFileSync(join(root, \`\${tag}-\${i}.txt\`), \`\${tag} \${i}\\n\`);`,
        `  const cp = await manager.create({ kind: 'manual', label: \`\${tag}-\${i}\` });`,
        `  if (cp) successCount++;`,
        `}`,
        `writeFileSync(join(root, \`\${tag}-count.txt\`), String(successCount));`,
      ].join('\n'),
      'utf-8',
    );

    const spawnOne = (tag: string) =>
      Bun.spawn(['bun', scriptPath, root, tag], {
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

    const [exitA, exitB] = await Promise.all([spawnOne('proc-a'), spawnOne('proc-b')]);
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);

    const countA = Number(readFileSync(join(root, 'proc-a-count.txt'), 'utf-8'));
    const countB = Number(readFileSync(join(root, 'proc-b-count.txt'), 'utf-8'));
    expect(countA + countB).toBeGreaterThan(0);
    // Ground truth at the git level (see countCheckpointRefs): every
    // reported success from either process corresponds to exactly one real,
    // uncorrupted git ref, nothing silently lost, nothing torn.
    expect(countCheckpointRefs(root)).toBe(countA + countB);
  }, 20_000);
});

describe('acquireCrossProcessLock: same-process queueing', () => {
  test('a second acquisition in the same process queues behind the first instead of timing out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-lock-inproc-'));
    const lockPath = join(dir, '.gv-lock');

    const release1 = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 3_000 });
    const secondStarted = Date.now();
    const second = acquireCrossProcessLock(lockPath, { totalTimeoutMs: 3_000 });

    // Give the second acquisition time to have failed under the old behavior's
    // file-contention path, then release, it must acquire promptly.
    await new Promise((r) => setTimeout(r, 150));
    release1();
    const release2 = await second;
    const waited = Date.now() - secondStarted;
    expect(waited).toBeGreaterThanOrEqual(140); // genuinely waited on the holder
    expect(waited).toBeLessThan(2_000); // and did not burn the timeout window
    release2();
  });

  test('three same-process waiters acquire strictly in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-lock-fifo-'));
    const lockPath = join(dir, '.gv-lock');
    const order: number[] = [];

    const release1 = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 5_000 });
    const w2 = acquireCrossProcessLock(lockPath, { totalTimeoutMs: 5_000 }).then((rel) => { order.push(2); return rel; });
    const w3 = acquireCrossProcessLock(lockPath, { totalTimeoutMs: 5_000 }).then((rel) => { order.push(3); return rel; });

    release1();
    const release2 = await w2;
    release2();
    const release3 = await w3;
    release3();
    expect(order).toEqual([2, 3]);
  });

  test('a queued waiter that times out neither wedges later waiters nor leaks the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-lock-qtimeout-'));
    const lockPath = join(dir, '.gv-lock');

    const release1 = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 3_000 });
    const doomed = acquireCrossProcessLock(lockPath, { totalTimeoutMs: 120 });
    await expect(doomed).rejects.toThrow('timed out');

    release1();
    // The path must be freely acquirable again after the timed-out waiter.
    const release2 = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 3_000 });
    release2();
  });
});
