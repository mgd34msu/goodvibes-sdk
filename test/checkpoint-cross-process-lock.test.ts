/**
 * checkpoint-cross-process-lock.test.ts — WorkspaceCheckpointManager serializes
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
 * objects sharing one directory — the same shape two OS processes would
 * produce) doing concurrent create()/restore() without corrupting the shared
 * git object store. A real subprocess case backs the primitive with genuine
 * process separation.
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '../packages/sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
 * Count checkpoint refs directly in the shared side git repo — the ground
 * truth for "how many checkpoints genuinely exist", independent of the JSON
 * manifest (index.json). Each manager instance keeps its OWN in-memory
 * manifest hydrated once at its own init(); two independent instances (like
 * two OS processes) racing manifest writes is a separate, pre-existing
 * last-write-wins limitation of the single JSON manifest file — NOT the git
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
    // A pid that (almost certainly) does not exist, with a fresh mtime — the
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
    // slow restore) had its lock stolen while it was still running — two
    // processes then touched the same git index. A held lock now refreshes
    // its own mtime for as long as it is held.
    const dir = tempDir('gv-lock-long-holder-');
    const lockPath = join(dir, '.gv-lock');
    const staleMs = 200;
    const release = await acquireCrossProcessLock(lockPath, { staleMs });

    // Hold for well over staleMs (four refresh intervals' worth), the way a
    // real long operation would: awaiting, not blocking.
    await new Promise((resolve) => setTimeout(resolve, staleMs * 4));

    // A waiter using the same staleMs must still be refused — the holder is alive.
    await expect(
      acquireCrossProcessLock(lockPath, { staleMs, initialBackoffMs: 5, maxBackoffMs: 20, totalTimeoutMs: 120 }),
    ).rejects.toThrow(/timed out/);

    // The long operation finishes normally and hands the lock over cleanly.
    release();
    expect(existsSync(lockPath)).toBe(false);
    const next = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 1000 });
    next();
  });

  test('after a takeover, the dispossessed holder\'s late release does NOT delete the new holder\'s lock', async () => {
    // Defect class: release() unlinked the lock path unconditionally, so the
    // previous holder's `finally { release() }` deleted whichever lock was
    // there — handing a third process the lock while the takeover winner was
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
        // pace only while this holder is healthy — we then stop refreshing by
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
      for (let i = 0; i < 250 && !existsSync(acquiredMarker); i++) await new Promise((r) => setTimeout(r, 20));
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
      for (let i = 0; i < 250 && !existsSync(doneVal); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(doneVal)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      releaseWinner();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

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
  test('eight real processes racing stale takeovers never hold the lock at the same time', async () => {
    // The takeover race can only be exercised with real OS-level parallelism:
    // within one process, a whole acquire attempt runs to completion between
    // awaits, so two in-process waiters can never interleave inside it.
    //
    // Each worker repeatedly acquires the lock, brackets its ~1ms critical
    // section with ENTER/EXIT lines in a shared append-only ledger, and plants
    // an ABANDONED lock (dead pid, ancient mtime, nobody refreshing it) on the
    // way out of every cycle — so the next acquisition by any of the other
    // seven is a genuine, simultaneous stale-takeover race. 160 critical
    // sections means ~160 such races, back to back.
    //
    // The invariant checked afterwards is mutual exclusion itself: the ledger
    // must be perfectly nested (every ENTER immediately followed by its own
    // EXIT). Two simultaneous holders — a double takeover, a loser's release
    // deleting the winner's lock, or a takeover of a lock whose payload had
    // not been written yet — show up as interleaved ENTERs. Nothing may go
    // missing either: all 160 sections must be present, so a takeover storm
    // cannot deadlock the store.
    //
    // Calibration: run against the pre-fix implementation (unlink-in-place
    // takeover + unconditional release + open-then-write publication), this
    // configuration reports ~120-160 overlaps per run rather than zero.
    const dir = tempDir('gv-lock-multiproc-');
    const lockPath = join(dir, '.gv-lock');
    const ledgerPath = join(dir, 'ledger.txt');
    writeFileSync(ledgerPath, '', 'utf-8');
    const workerCount = 8;
    const cycles = 20;

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
        `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));`,
        `for (let i = 0; i < cycles; i++) {`,
        `  const release = await acquireCrossProcessLock(lockPath, {`,
        `    staleMs: 1000, initialBackoffMs: 1, maxBackoffMs: 4, totalTimeoutMs: 30000,`,
        `  });`,
        `  appendFileSync(ledgerPath, \`ENTER \${tag} \${i}\\n\`);`,
        `  await sleep(1);`,
        `  appendFileSync(ledgerPath, \`EXIT \${tag} \${i}\\n\`);`,
        `  release();`,
        `  // Plant an abandoned lock: a holder that died without releasing.`,
        `  try {`,
        `    const fd = openSync(lockPath, 'wx');`,
        `    writeSync(fd, JSON.stringify({ pid: 999999, token: 'crashed', acquiredAt: Date.now() - 60000 }));`,
        `    closeSync(fd);`,
        `    const past = Date.now() / 1000 - 600;`,
        `    utimesSync(lockPath, past, past);`,
        `  } catch { /* another worker got there first — fine */ }`,
        `}`,
      ].join('\n'),
      'utf-8',
    );

    const exits = await Promise.all(
      Array.from({ length: workerCount }, (_, index) =>
        Bun.spawn(['bun', scriptPath, lockPath, ledgerPath, `w${index}`, String(cycles)], {
          cwd: join(import.meta.dir, '..'),
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited),
    );
    expect(exits).toEqual(Array.from({ length: workerCount }, () => 0));

    const lines = readFileSync(ledgerPath, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(workerCount * cycles * 2);

    let holder: string | null = null;
    const overlaps: string[] = [];
    for (const line of lines) {
      const [kind, tag, index] = line.split(' ');
      const key = `${tag} ${index}`;
      if (kind === 'ENTER') {
        if (holder !== null) overlaps.push(`${key} entered while ${holder} held the lock`);
        holder = key;
      } else {
        if (holder !== key) overlaps.push(`${key} exited while ${holder ?? 'nobody'} held the lock`);
        holder = null;
      }
    }
    expect(overlaps).toEqual([]);
    expect(holder).toBeNull();
  }, 60_000);
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
    // existing no-op-tree behavior — see manager.ts) — that is unrelated to
    // this lock. What the lock guarantees is that every call that DID return
    // a real checkpoint corresponds to exactly one genuine, uncorrupted git
    // ref: no torn writes, no silently lost checkpoint.
    const nonNullCount = results.filter((r) => r !== null).length;
    expect(nonNullCount).toBeGreaterThan(0);
    expect(countCheckpointRefs(root)).toBe(nonNullCount);

    // git's own integrity check on the shared side repo — parentless
    // checkpoint commits show up as "dangling", which is expected and NOT a
    // fsck failure; a real corruption fails with a non-zero exit code.
    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);
  });

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

    // None of these may throw — that alone proves the lock serialized every
    // git-touching call instead of letting them interleave.
    await expect(Promise.all(ops.map((fn) => fn()))).resolves.toBeDefined();

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);

    // The store is still fully usable afterward — list()/diff() work cleanly.
    const managerC = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
    const all = await managerC.list();
    expect(all.length).toBeGreaterThan(0);
  });
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
    // returns null — the exact same no-op-tree behavior a single process
    // gets from its own back-to-back creates. The invariant this test proves
    // is not "each process always gets exactly N checkpoints" (timing-
    // dependent) but "every create() that DID report success corresponds to
    // exactly one real, uncorrupted git ref — nothing is silently lost".
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
    // uncorrupted git ref — nothing silently lost, nothing torn.
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
    // file-contention path, then release — it must acquire promptly.
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
