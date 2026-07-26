/**
 * activity-logger-durability.test.ts — the shared debug logger's writes land,
 * and when they cannot it says so once instead of forever.
 *
 * Defect class, observed twice in one session:
 *   1. A daemon shutting down never got its final lines to disk. The logger
 *      buffered and appended asynchronously, and the exit paths call
 *      process.exit(), which discards both the buffer and any append still in
 *      flight — so the one event worth reading about was the one missing.
 *   2. `[ActivityLogger] flush error: ENOENT …` repeating during teardown: the
 *      destination directory had been removed under a live logger, and every
 *      flush for the rest of the process wrote the same line to stderr while
 *      continuing to accept entries as though they were being recorded.
 *
 * The first test spawns a REAL child process that exits immediately after
 * logging, because that is the only way to prove the guarantee holds against an
 * actual process.exit rather than against a function call that stands in for it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActivityLogger } from '../packages/sdk/src/platform/utils/logger.ts';

const LOGGER_MODULE = join(import.meta.dir, '..', 'packages/sdk/src/platform/utils/logger.ts');

const dirs: string[] = [];
const loggers: ActivityLogger[] = [];

function tempDir(): string {
  const dir = join(tmpdir(), `gv-logger-durability-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function track(logger: ActivityLogger): ActivityLogger {
  loggers.push(logger);
  return logger;
}

/** Let the buffered writer's 100ms flush timer drain, a few times over. */
async function settle(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const logger of loggers.splice(0)) logger.dispose();
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('ActivityLogger durability at exit', () => {
  test('lines still buffered when the process exits are on disk afterwards', async () => {
    const dir = tempDir();
    const script = join(dir, 'exit-now.ts');
    // Fewer entries than the buffer maximum and no await anywhere: nothing but
    // the process-exit flush can put these on disk.
    writeFileSync(script, [
      `import { configureActivityLogger, logger } from ${JSON.stringify(LOGGER_MODULE)};`,
      `configureActivityLogger(${JSON.stringify(join(dir, 'logs'))});`,
      "logger.info('daemon is resigning');",
      "logger.info('handing over to the successor');",
      'process.exit(0);',
    ].join('\n'), 'utf-8');

    const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const written = readFileSync(join(dir, 'logs', 'activity.md'), 'utf-8');
    expect(written).toContain('daemon is resigning');
    expect(written).toContain('handing over to the successor');
  });

  test('flushSync puts the buffer on disk without waiting for the timer', () => {
    const dir = tempDir();
    const logger = track(new ActivityLogger());
    logger.configure(dir);
    logger.info('written and flushed on this thread');
    logger.flushSync();
    expect(readFileSync(join(dir, 'activity.md'), 'utf-8')).toContain('written and flushed on this thread');
  });
});

describe('ActivityLogger destination loss', () => {
  test('a destination directory removed underneath the logger is recreated and the entry lands', async () => {
    const dir = tempDir();
    const logger = track(new ActivityLogger());
    logger.configure(dir);
    logger.info('before the directory went away');
    await settle();
    expect(existsSync(join(dir, 'activity.md'))).toBe(true);

    // Exactly the teardown shape that produced the repeating ENOENT.
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);

    logger.info('after the directory went away');
    await settle();

    expect(logger.isDegraded).toBe(false);
    const written = readFileSync(join(dir, 'activity.md'), 'utf-8');
    expect(written).toContain('after the directory went away');
  });

  test('a destination that cannot be recreated is reported once, and never again', async () => {
    const base = tempDir();
    const logDir = join(base, 'logs');
    const reports: string[] = [];
    const logger = track(new ActivityLogger());
    logger.configure(logDir, { report: (line) => { reports.push(line); } });
    logger.info('while the destination still worked');
    await settle();

    // Make the destination permanently unreachable: its PARENT becomes a file,
    // so the directory is gone (ENOENT on append) and cannot be recreated.
    rmSync(base, { recursive: true, force: true });
    writeFileSync(base, 'not a directory', 'utf-8');

    logger.info('first entry after the destination broke');
    await settle(600);

    expect(logger.isDegraded).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('is not writable');
    expect(reports[0]).toContain('activity logging is stopped');

    // The spam case: keep logging hard, well past several flush intervals.
    for (let i = 0; i < 200; i += 1) logger.info(`entry ${i} into the void`);
    await settle(600);
    expect(reports).toHaveLength(1);
  });

  test('entries buffered before a destination is named stay bounded', () => {
    const logger = track(new ActivityLogger());
    // No configure(): every entry accumulates in memory.
    for (let i = 0; i < 5_000; i += 1) logger.info(`unconfigured entry ${i}`);

    const dir = tempDir();
    logger.configure(dir);
    logger.flushSync();

    const written = readFileSync(join(dir, 'activity.md'), 'utf-8');
    // The cap held: the oldest entries were dropped, the newest survived, and
    // the gap is stated in the log rather than left to be inferred.
    expect(written).toContain('ActivityLogger dropped 4000 buffered entries before this point');
    expect(written).not.toContain('unconfigured entry 0\n');
    expect(written).toContain('unconfigured entry 4999');
  });
});
