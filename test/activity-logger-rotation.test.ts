/**
 * activity-logger-rotation.test.ts — the shared debug logger stops growing
 * unbounded.
 *
 * Defect class: utils/logger.ts appended to `.goodvibes/logs/activity.md`
 * forever (a real 22.8 MB file was observed). The logger now rotates the live
 * file to `activity.md.1` (one backup kept) once it reaches a size cap, with a
 * cheap in-memory byte counter rather than a per-write stat.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureActivityLogger, logger } from '../packages/sdk/src/platform/utils/logger.ts';

const dirs: string[] = [];

function tempLogDir(): string {
  const dir = join(tmpdir(), `gv-logger-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Force the buffered writer to drain synchronously enough for assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('ActivityLogger rotation', () => {
  test('a seeded oversize file rotates to .1 on the next write, keeping one backup', async () => {
    const dir = tempLogDir();
    const activity = join(dir, 'activity.md');
    // Seed an existing file already past a small cap.
    const seeded = 'X'.repeat(4096) + '\n';
    writeFileSync(activity, seeded, 'utf-8');

    // Configure with a tiny cap so the seeded file is already over-limit.
    configureActivityLogger(dir, { maxBytes: 1024 });
    logger.info('first message after configure');
    await settle();

    // The seeded content was rotated to the backup, and the live file now holds
    // only the post-rotation message.
    expect(existsSync(`${activity}.1`)).toBe(true);
    expect(readFileSync(`${activity}.1`, 'utf-8')).toBe(seeded);
    const live = readFileSync(activity, 'utf-8');
    expect(live).toContain('first message after configure');
    expect(live).not.toContain('XXXX');
  });

  test('only one backup is kept — a second rotation overwrites .1', async () => {
    const dir = tempLogDir();
    const activity = join(dir, 'activity.md');
    configureActivityLogger(dir, { maxBytes: 512 });

    // Drive enough volume to cross the cap at least twice.
    const big = 'A'.repeat(600);
    logger.info(big);
    await settle();
    logger.info('boundary marker one');
    await settle();
    const secondBig = 'B'.repeat(600);
    logger.info(secondBig);
    await settle();
    logger.info('boundary marker two');
    await settle();

    // Exactly one backup file exists (no .2), and the live file is bounded.
    expect(existsSync(`${activity}.1`)).toBe(true);
    expect(existsSync(`${activity}.2`)).toBe(false);
    // The live file never accumulates unbounded history: it holds less than the
    // full written volume because at least one rotation reclaimed older content.
    const liveSize = statSync(activity).size;
    expect(liveSize).toBeLessThan(600 * 2);
  });

  test('under the cap the file is not rotated', async () => {
    const dir = tempLogDir();
    const activity = join(dir, 'activity.md');
    configureActivityLogger(dir, { maxBytes: 10 * 1024 * 1024 });
    logger.info('a modest line');
    await settle();
    expect(existsSync(activity)).toBe(true);
    expect(existsSync(`${activity}.1`)).toBe(false);
  });
});
