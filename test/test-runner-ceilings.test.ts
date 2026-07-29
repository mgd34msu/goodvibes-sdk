/**
 * test-runner-ceilings.test.ts
 *
 * The suite runner has to be able to end a run that has stopped making
 * progress, and it has to die with the process that started it.
 *
 * Both come from one incident. The "Platform matrix (bun)" job printed
 * `##[group]test/arch03-error-hierarchy.test.ts:` and then nothing at all for
 * fifteen minutes, until the job timeout killed it — bun's module loader had
 * deadlocked BETWEEN two test files, where no per-test timeout applies, and
 * nothing in the process was in a position to notice. The runner's post-job
 * step then reported two `bun` processes it had to terminate itself, because a
 * job timeout kills the step's SHELL: the parent never received a signal it
 * could relay, so the relay that shipped for exactly this could not fire.
 *
 * Fifteen minutes of silence is indistinguishable from slow progress until
 * something outside the run gives up on it. These cases are what make it
 * distinguishable from the inside, so they are written to FAIL if the ceiling
 * stops firing, if it stops naming what the run was doing, if it stops killing
 * the child, or if the child stops dying with its parent.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnedTestChild } from '../scripts/owned-test-child.ts';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-runner-ceiling-'));
  tmpDirs.push(dir);
  return dir;
}

const envKeys = ['GOODVIBES_TEST_STALL_MS', 'GOODVIBES_TEST_CEILING_MS'] as const;
const savedEnv = new Map<string, string | undefined>();
function setRunnerEnv(key: (typeof envKeys)[number], value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A test file that never finishes loading — the wedge's actual shape. */
function writeWedgedFile(dir: string, name = 'wedged.test.ts'): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "import { test, expect } from 'bun:test';",
      '// Hangs during MODULE EVALUATION, before any test is registered, which is',
      '// where bun 1.3.10 deadlocked. No per-test timeout can reach this.',
      'await new Promise<void>(() => {});',
      "test('never runs', () => { expect(1).toBe(1); });",
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/**
 * A test file that passes, slowly, and prints nothing.
 *
 * Slowly and silently on purpose. A run that finishes inside one poll tick
 * could not tell a working stall ceiling from one that fires on everything,
 * and a run that PRINTS could not tell a working heartbeat from output being
 * mistaken for progress — which is the thing the heartbeat exists to replace,
 * because a green local run prints almost nothing for three minutes.
 */
function writeHealthyFile(dir: string, name = 'healthy.test.ts'): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "import { test, expect } from 'bun:test';",
      'for (const i of [1, 2, 3, 4]) {',
      "  test(`slow case ${i}`, async () => { await Bun.sleep(1000); expect(i).toBeGreaterThan(0); });",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** {@link writeWedgedFile}, but it records its own pid before it wedges. */
function writePidRecordingWedgedFile(dir: string, pidPath: string, name = 'wedged.test.ts'): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "import { test, expect } from 'bun:test';",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), 'utf8');`,
      'await new Promise<void>(() => {});',
      "test('never runs', () => { expect(1).toBe(1); });",
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/**
 * A runner that behaves exactly like scripts/test.ts, minus everything the
 * lifecycle does not need — and with BOTH ceilings off, so the only thing that
 * can end the suite in these cases is the thing being tested.
 */
function writeRunnerScript(dir: string, wedged: string, name = 'runner.ts'): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      `import { runOwnedTestChild } from ${JSON.stringify(join(SDK_ROOT, 'scripts/owned-test-child.ts'))};`,
      'await runOwnedTestChild({',
      `  argv: ['--timeout=600000', ${JSON.stringify(wedged)}],`,
      `  cwd: ${JSON.stringify(dir)},`,
      "  env: { ...process.env, GOODVIBES_TEST_STALL_MS: '0', GOODVIBES_TEST_CEILING_MS: '0' },",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** True once `pid` is gone; false if it is still there when time runs out. */
async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(200);
  }
  return false;
}

describe('the stall ceiling ends a run that has stopped starting tests', () => {
  test('a file that never finishes loading is ended, by the runner, with a reason', async () => {
    const dir = mkTemp();
    const wedged = writeWedgedFile(dir);
    setRunnerEnv('GOODVIBES_TEST_STALL_MS', '3000');
    setRunnerEnv('GOODVIBES_TEST_CEILING_MS', '60000');

    const began = Date.now();
    const result = await runOwnedTestChild({
      // A per-test timeout far larger than the stall ceiling: this proves the
      // ceiling is what ended the run, since bun's own budget never applies to
      // a module that never finishes evaluating.
      argv: ['--timeout=600000', wedged],
      cwd: dir,
      env: { ...process.env },
    });
    const elapsed = Date.now() - began;

    expect(result.stopped).toBe('stalled');
    expect(elapsed).toBeLessThan(30_000);
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    // The sentence has to carry the diagnosis, not just the fact of a timeout.
    expect(result.stopReason).toContain('no test has started for');
    expect(result.stopReason).toContain('GOODVIBES_TEST_STALL_MS');
    expect(result.stopReason).toContain('stuck, not slow');
  }, 60_000);

  test('a healthy run that prints nothing for seconds is never touched', async () => {
    const dir = mkTemp();
    const healthy = writeHealthyFile(dir);
    // Four seconds of silent work against a 1.5-second stall ceiling. The run
    // survives ONLY because each test start is reported through the heartbeat:
    // stop writing it, or stop reading it, and this run is declared stuck.
    setRunnerEnv('GOODVIBES_TEST_STALL_MS', '1500');
    const began = Date.now();
    const result = await runOwnedTestChild({
      argv: ['--timeout=30000', healthy],
      cwd: dir,
      env: { ...process.env },
    });
    expect(Date.now() - began).toBeGreaterThanOrEqual(4_000);
    expect(result.stopped).toBeNull();
    expect(result.stopReason).toBeNull();
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test('the stall ceiling can be turned off', async () => {
    const dir = mkTemp();
    const wedged = writeWedgedFile(dir);
    setRunnerEnv('GOODVIBES_TEST_STALL_MS', '0');
    // With the stall ceiling off, the overall ceiling is what ends it — and it
    // says so, which is how the two are told apart in a log.
    setRunnerEnv('GOODVIBES_TEST_CEILING_MS', '4000');
    const result = await runOwnedTestChild({
      argv: ['--timeout=600000', wedged],
      cwd: dir,
      env: { ...process.env },
    });
    expect(result.stopped).toBe('ceiling');
    expect(result.stopReason).toContain('GOODVIBES_TEST_CEILING_MS');
    expect(result.stopReason).toContain('past its ceiling');
  }, 60_000);

  test('a suite that ignores SIGTERM is killed rather than waited on', async () => {
    // A ceiling that asks politely and then waits forever is not a ceiling. One
    // `process.on('SIGTERM')` in a test file is all it takes for the polite
    // request to be ignored, and this is the case that proves the runner does
    // not then park on the child reproducing the silence it exists to end.
    const dir = mkTemp();
    const pidPath = join(dir, 'child.pid');
    const path = join(dir, 'stubborn.test.ts');
    writeFileSync(
      path,
      [
        "import { test, expect } from 'bun:test';",
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGINT', () => {});",
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), 'utf8');`,
        'await new Promise<void>(() => {});',
        "test('never runs', () => { expect(1).toBe(1); });",
        '',
      ].join('\n'),
      'utf8',
    );
    setRunnerEnv('GOODVIBES_TEST_STALL_MS', '3000');
    const began = Date.now();
    const result = await runOwnedTestChild({
      argv: ['--timeout=600000', path],
      cwd: dir,
      env: { ...process.env },
    });
    // Stall ceiling (3s) plus the SIGTERM grace (5s), and nowhere near forever.
    expect(Date.now() - began).toBeLessThan(45_000);
    expect(result.stopped).toBe('stalled');
    const childPid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(await waitForExit(childPid, 10_000), `stubborn child pid ${childPid} survived`).toBe(true);
  }, 90_000);

  test('the child is dead, not merely signalled, once the ceiling has fired', async () => {
    const dir = mkTemp();
    const pidPath = join(dir, 'child.pid');
    const path = writePidRecordingWedgedFile(dir, pidPath);
    setRunnerEnv('GOODVIBES_TEST_STALL_MS', '3000');
    const result = await runOwnedTestChild({
      argv: ['--timeout=600000', path],
      cwd: dir,
      env: { ...process.env },
    });
    expect(result.stopped).toBe('stalled');
    expect(existsSync(pidPath)).toBe(true);
    const childPid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(Number.isInteger(childPid)).toBe(true);
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive, `child pid ${childPid} survived the ceiling`).toBe(false);
  }, 60_000);
});

describe('the suite dies with the process that started it', () => {
  test('a SIGKILLed runner — which can relay nothing — still takes the suite with it', async () => {
    const dir = mkTemp();
    const pidPath = join(dir, 'child.pid');
    const wedged = writePidRecordingWedgedFile(dir, pidPath);
    // Both ceilings off inside the runner: the ONLY thing that may end the
    // child here is its parent disappearing, so a pass cannot be a ceiling
    // firing by accident.
    const runner = writeRunnerScript(dir, wedged);

    const logPath = join(dir, 'runner.log');
    const log = Bun.file(logPath);
    const parent = Bun.spawn(['bun', runner], {
      cwd: dir,
      stdout: log,
      stderr: log,
      env: { ...process.env, GOODVIBES_TEST_STALL_MS: '0', GOODVIBES_TEST_CEILING_MS: '0' },
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!existsSync(pidPath) && Date.now() < deadline) await Bun.sleep(100);
      const runnerLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no output)';
      expect(existsSync(pidPath), `the suite child never started; runner said: ${runnerLog}`).toBe(true);
      const childPid = Number(readFileSync(pidPath, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      // SIGKILL, deliberately: uncatchable, so nothing in the parent runs and
      // nothing is relayed. This is the shape of a CI job timeout.
      parent.kill('SIGKILL');
      await parent.exited;

      expect(
        await waitForExit(childPid, 30_000),
        `suite child pid ${childPid} outlived its SIGKILLed parent`,
      ).toBe(true);
    } finally {
      try { parent.kill('SIGKILL'); } catch { /* already gone */ }
      await parent.exited.catch(() => undefined);
    }
  }, 150_000);

  test('a runner whose own shell is killed gives up instead of being orphaned', async () => {
    // The CI shape, exactly: a job timeout kills the STEP'S SHELL. The runner
    // is not signalled — it is reparented — so the only thing that can end it
    // is noticing that the process which started it is gone. Both `bun`
    // processes the orphan sweep reported were this pair.
    const dir = mkTemp();
    const pidPath = join(dir, 'child.pid');
    const runnerPidPath = join(dir, 'runner.pid');
    const wedged = writePidRecordingWedgedFile(dir, pidPath);
    const runner = writeRunnerScript(dir, wedged);

    const shell = Bun.spawn(
      ['bash', '-c', `bun ${JSON.stringify(runner)} & echo $! > ${JSON.stringify(runnerPidPath)}; wait`],
      {
        cwd: dir,
        stdout: 'ignore',
        stderr: 'ignore',
        env: { ...process.env, GOODVIBES_TEST_STALL_MS: '0', GOODVIBES_TEST_CEILING_MS: '0' },
      },
    );
    try {
      const deadline = Date.now() + 60_000;
      while (!(existsSync(pidPath) && existsSync(runnerPidPath)) && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      expect(existsSync(pidPath), 'the suite child never started').toBe(true);
      const childPid = Number(readFileSync(pidPath, 'utf8').trim());
      const runnerPid = Number(readFileSync(runnerPidPath, 'utf8').trim());
      expect(Number.isInteger(childPid) && Number.isInteger(runnerPid)).toBe(true);

      shell.kill('SIGKILL');
      await shell.exited;

      expect(await waitForExit(runnerPid, 30_000), `runner pid ${runnerPid} outlived its shell`).toBe(true);
      expect(await waitForExit(childPid, 30_000), `suite child pid ${childPid} outlived its shell`).toBe(true);
    } finally {
      try { shell.kill('SIGKILL'); } catch { /* already gone */ }
      await shell.exited.catch(() => undefined);
    }
  }, 150_000);

  test('the runner half of the lifecycle never imports bun:test', () => {
    // scripts/test-child-watchdog.ts imports `bun:test` and registers a global
    // `beforeEach` — correct inside the suite, and a defect in the PARENT,
    // which would then carry a lifecycle hook of its own into every run. The
    // shared env names live in their own import-free module for this reason.
    // Invisible at runtime until something odd happens, so it is scanned for.
    const parentSide = readFileSync(resolve(SDK_ROOT, 'scripts/owned-test-child.ts'), 'utf8');
    const imports = [...parentSide.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).not.toContain('bun:test');
    expect(imports).toContain('./test-child-watchdog-env.ts');
    expect(imports).not.toContain('./test-child-watchdog.ts');
    // And the module it does import must stay import-free itself, or the
    // separation is undone one edit later.
    const envModule = readFileSync(resolve(SDK_ROOT, 'scripts/test-child-watchdog-env.ts'), 'utf8');
    expect(envModule).not.toMatch(/^\s*import\s/m);
  });
});
