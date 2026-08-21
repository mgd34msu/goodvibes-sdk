/**
 * test-child-watchdog.ts, preloaded into the `bun test` child by
 * scripts/owned-test-child.ts. Two jobs, both about a run that stops being
 * watched by anyone.
 *
 * ## 1. Die when the parent dies, without being told
 *
 * scripts/owned-test-child.ts relays SIGINT/SIGTERM/SIGHUP to this process,
 * which is correct whenever a signal is actually delivered. It is not what
 * happens on a GitHub Actions job timeout: the runner kills the STEP'S SHELL,
 * so the `bun scripts/test.ts` parent never receives anything it could relay,
 * and this process is simply reparented and left running. The job that this
 * file was written for ended with the runner's post-job step reporting
 * `Terminate orphan process: pid (2403) (bun)` and `pid (2414) (bun)`, the
 * runner script and its test child, both still alive after the step that
 * started them was gone, and both still holding whatever they had open.
 *
 * A relay cannot cover that, because nothing is relayed. Parent death has to be
 * OBSERVED. `process.kill(pid, 0)` against the pid recorded at spawn is the
 * observation, on a one-second poll: the signal-0 probe never delivers a signal,
 * it only asks whether the process is still there. It is checked against a
 * recorded pid rather than `process.ppid` because reparenting is exactly the
 * event being detected, and a subreaper can make `ppid` land on something other
 * than 1.
 *
 * ## 2. Report that tests are still starting
 *
 * The wedge this round was diagnosed from was fifteen minutes of complete
 * silence: bun's module loader deadlocked BETWEEN two test files, where no
 * per-test timeout applies, and nothing in the process was in a position to
 * notice. Output is not a usable liveness signal, a fully green local run
 * prints almost nothing for three minutes, so the signal is "a test started",
 * written here and read by the parent.
 *
 * Throttled to one write a second, because 9 722 tests do not need 9 722
 * writes to answer the only question being asked of them.
 */
import { beforeEach } from 'bun:test';
import { writeFileSync } from 'node:fs';

import { HEARTBEAT_PATH_ENV, PARENT_GONE_EXIT_CODE, PARENT_PID_ENV } from './test-child-watchdog-env.ts';

const HEARTBEAT_THROTTLE_MS = 1_000;
const PARENT_POLL_MS = 1_000;

function installParentDeathWatchdog(): void {
  const parentPid = Number(process.env[PARENT_PID_ENV] ?? '');
  if (!Number.isInteger(parentPid) || parentPid <= 1) return;
  const timer = setInterval(() => {
    try {
      // Signal 0 delivers nothing; it asks whether the process still exists.
      process.kill(parentPid, 0);
    } catch {
      process.stderr.write(
        `\ngoodvibes: test runner (pid ${parentPid}) is gone; ending this suite rather than outliving it\n`,
      );
      process.exit(PARENT_GONE_EXIT_CODE);
    }
  }, PARENT_POLL_MS);
  // Unref'd: this must never be the reason the suite stays alive. It still
  // fires for as long as the process is running, which is all it is for.
  timer.unref?.();
}

function installProgressHeartbeat(): void {
  const path = process.env[HEARTBEAT_PATH_ENV];
  if (!path) return;
  let started = 0;
  let lastWrite = 0;
  beforeEach(() => {
    started += 1;
    const now = Date.now();
    if (now - lastWrite < HEARTBEAT_THROTTLE_MS) return;
    lastWrite = now;
    try {
      writeFileSync(path, `${now} ${started}\n`, 'utf8');
    } catch {
      // A heartbeat that cannot be written must never fail a test. The parent
      // reports the silence instead, which is the same outcome one step later.
    }
  });
}

installParentDeathWatchdog();
installProgressHeartbeat();
