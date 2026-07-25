/**
 * kv-state-session-retention.test.ts
 *
 * Regression evidence that the `session_<8hex>.json` store is actually bounded.
 *
 * The defect: `KVState.cleanupOldSessions` existed and had ZERO production
 * callers anywhere in the SDK or its surfaces, and no age bound or count bound
 * was applied on any other path. Every session and every agent spawn wrote a
 * file into `<wd>/.goodvibes/<surface>/state/` that nothing ever removed, so a
 * long-lived working directory accumulated them without limit. The `.json`
 * extension also put them outside the append-only retention sweep, which filters
 * on `.jsonl` and deliberately skips the whole state directory because it also
 * holds live files.
 *
 * These tests pin the replacement contract: both bounds run at recovery (the
 * first `load()`), the CURRENT session's file is exempt from both, only
 * `session_<8hex>.json` is ever touched, the pass discloses real counts and
 * bytes, a pass that reclaims nothing says nothing, and a second pass over an
 * already-reaped directory is a no-op.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KVState } from '../packages/sdk/src/platform/state/kv-state.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';

/** Mirrors SESSION_MAX_AGE_MS in kv-state.ts — the contract these tests hold it to. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Mirrors SESSION_KEEP_COUNT in kv-state.ts. */
const KEEP_COUNT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(label: string): string {
  const dir = join(tmpdir(), `gv-kv-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Eight lowercase hex characters — the only session-id shape this store recognises. */
function hexId(seed: number): string {
  return seed.toString(16).padStart(8, '0');
}

/** Write a session file and stamp its mtime `ageMs` into the past. */
function writeSessionFile(dir: string, id: string, ageMs: number, body: unknown = { id, started_at: 'then' }): string {
  const path = join(dir, `session_${id}.json`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

function sessionFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => /^session_[0-9a-f]{8}\.json$/.test(name)).sort();
}

interface CapturedInfo {
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

/**
 * Run `body` with `logger.info` intercepted. The logger is a process-wide
 * singleton with no sink hook, so the method is swapped and restored rather than
 * the whole logger being reconfigured (which would redirect every other suite in
 * the same bun process).
 */
async function captureInfo(body: () => Promise<void>): Promise<CapturedInfo[]> {
  const captured: CapturedInfo[] = [];
  const original = logger.info;
  logger.info = (message: string, data?: Record<string, unknown>): void => {
    captured.push({ message, data });
  };
  try {
    await body();
  } finally {
    logger.info = original;
  }
  return captured;
}

const disposables: KVState[] = [];

/** Build a KVState and remember it, so its sweep interval is cleared after the test. */
function kvState(options: { stateDir: string; sessionId?: string; legacyStateDir?: string }): KVState {
  const state = new KVState(options);
  disposables.push(state);
  return state;
}

afterEach(async () => {
  // dispose() clears the housekeeping interval; an unref'd timer would not hold
  // the runner open, but leaving dozens of them ticking across a suite would.
  while (disposables.length > 0) {
    const state = disposables.pop();
    if (state) await state.dispose().catch(() => undefined);
  }
});

describe('KVState session-file retention — the reap that now actually runs', () => {
  test('files past the age bound are reclaimed at recovery, and the current session survives its own', async () => {
    const stateDir = tempDir('age');
    // The current session was last written a MONTH ago — a long-dormant session
    // being resumed is exactly the case a naive age sweep would destroy.
    writeSessionFile(stateDir, 'aaaaaaaa', 30 * DAY_MS, { id: 'aaaaaaaa', started_at: 'then', keep: 'me' });
    writeSessionFile(stateDir, 'bbbbbbbb', MAX_AGE_MS + DAY_MS);
    writeSessionFile(stateDir, 'cccccccc', 90 * DAY_MS);
    writeSessionFile(stateDir, 'dddddddd', MAX_AGE_MS - DAY_MS);

    const state = kvState({ stateDir, sessionId: 'aaaaaaaa' });
    expect(await state.get(['keep'])).toEqual({ keep: 'me' });

    expect(sessionFilesIn(stateDir)).toEqual(['session_aaaaaaaa.json', 'session_dddddddd.json']);
  });

  test('the count bound holds the store flat when a burst of sessions outruns the age bound', async () => {
    const stateDir = tempDir('count');
    // KEEP_COUNT + 10 files, all recent, each a minute older than the last.
    for (let i = 0; i < KEEP_COUNT + 10; i += 1) {
      writeSessionFile(stateDir, hexId(i + 1), i * 60_000);
    }
    writeSessionFile(stateDir, 'ffffffff', 0);

    const state = kvState({ stateDir, sessionId: 'ffffffff' });
    await state.load();

    const survivors = sessionFilesIn(stateDir);
    // The current session's file is exempt from the count bound, so KEEP_COUNT
    // others survive alongside it.
    expect(survivors).toHaveLength(KEEP_COUNT + 1);
    expect(survivors).toContain('session_ffffffff.json');
    // Newest-first: the oldest ten went, the newest stayed.
    expect(survivors).toContain(`session_${hexId(1)}.json`);
    expect(survivors).not.toContain(`session_${hexId(KEEP_COUNT + 10)}.json`);
  });

  test('the current session file survives even when it is BOTH the oldest and past the count bound', async () => {
    const stateDir = tempDir('current-exempt');
    for (let i = 0; i < KEEP_COUNT + 5; i += 1) {
      writeSessionFile(stateDir, hexId(i + 1), i * 60_000);
    }
    // Older than every other file AND older than the age bound.
    writeSessionFile(stateDir, 'ffffffff', MAX_AGE_MS + 40 * DAY_MS, { id: 'ffffffff', started_at: 'ancient', mine: 1 });

    const state = kvState({ stateDir, sessionId: 'ffffffff' });
    expect(await state.get(['mine'])).toEqual({ mine: 1 });

    expect(existsSync(join(stateDir, 'session_ffffffff.json'))).toBe(true);
  });

  test('nothing but session_<8hex>.json is listed, stat-ed or removed', async () => {
    const stateDir = tempDir('siblings');
    // Live, unrelated files that share this directory. They are why the
    // append-only registry refuses to sweep the state dir at all.
    const bystanders = ['retries.json', 'agent-tracking.json', 'session_nothex.json', 'session_0123456.json', 'notes.txt'];
    for (const name of bystanders) {
      const path = join(stateDir, name);
      writeFileSync(path, '{}', 'utf-8');
      const seconds = (Date.now() - 400 * DAY_MS) / 1000;
      utimesSync(path, seconds, seconds);
    }
    mkdirSync(join(stateDir, 'workflows'), { recursive: true });
    writeSessionFile(stateDir, '11111111', 400 * DAY_MS);

    const state = kvState({ stateDir, sessionId: '99999999' });
    await state.load();

    expect(readdirSync(stateDir).sort()).toEqual([...bystanders, 'workflows'].sort());
  });

  test('the disclosure carries the real counts and byte total, split by which bound fired', async () => {
    const stateDir = tempDir('disclose');
    const agedPaths = [
      writeSessionFile(stateDir, '00000001', MAX_AGE_MS + DAY_MS, { id: '00000001', filler: 'x'.repeat(100) }),
      writeSessionFile(stateDir, '00000002', 60 * DAY_MS, { id: '00000002', filler: 'y'.repeat(250) }),
    ];
    const expectedBytes = agedPaths.reduce((sum, path) => sum + statSync(path).size, 0);
    writeSessionFile(stateDir, '00000003', DAY_MS);

    const captured = await captureInfo(async () => {
      await kvState({ stateDir, sessionId: 'abcdef01' }).load();
    });

    const disclosures = captured.filter((entry) => entry.message.includes('reclaimed stale session state files'));
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.data).toEqual({
      stateDir,
      filesRemoved: 2,
      agedOut: 2,
      overCap: 0,
      bytesReclaimed: expectedBytes,
    });
    // Counts, a directory and a byte total — never a file's contents.
    expect(JSON.stringify(disclosures[0]?.data)).not.toContain('filler');
  });

  test('a pass that reclaims nothing logs nothing — silence means nothing was deleted', async () => {
    const stateDir = tempDir('quiet');
    writeSessionFile(stateDir, '00000001', DAY_MS);
    writeSessionFile(stateDir, '00000002', 2 * DAY_MS);

    const captured = await captureInfo(async () => {
      await kvState({ stateDir, sessionId: '00000009' }).load();
    });

    expect(captured.filter((entry) => entry.message.includes('reclaimed stale session state files'))).toHaveLength(0);
    expect(sessionFilesIn(stateDir)).toEqual(['session_00000001.json', 'session_00000002.json']);
  });

  test('reaping twice is a no-op the second time — idempotent, and safe to race', async () => {
    const stateDir = tempDir('idempotent');
    writeSessionFile(stateDir, '00000001', 60 * DAY_MS);
    writeSessionFile(stateDir, '00000002', 60 * DAY_MS);
    writeSessionFile(stateDir, '00000003', DAY_MS);

    const first = await captureInfo(async () => {
      await kvState({ stateDir, sessionId: 'aaaa0001' }).load();
    });
    const afterFirst = sessionFilesIn(stateDir);

    // A second instance over the same directory — the shape a second process
    // recovering concurrently takes.
    const second = await captureInfo(async () => {
      await kvState({ stateDir, sessionId: 'aaaa0002' }).load();
    });

    expect(first.filter((e) => e.message.includes('reclaimed stale session state files'))).toHaveLength(1);
    expect(second.filter((e) => e.message.includes('reclaimed stale session state files'))).toHaveLength(0);
    expect(sessionFilesIn(stateDir)).toEqual(afterFirst);
    expect(afterFirst).toEqual(['session_00000003.json']);
  });

  test('an unlink losing the race to another process is success, not an error', async () => {
    // Two reaps driven concurrently over one directory: whichever call wins each
    // unlink, the directory ends up in the same state and neither throws.
    const stateDir = tempDir('race');
    for (let i = 0; i < 6; i += 1) writeSessionFile(stateDir, hexId(i + 1), 60 * DAY_MS);

    await Promise.all([
      kvState({ stateDir, sessionId: 'bbbb0001' }).load(),
      kvState({ stateDir, sessionId: 'bbbb0002' }).load(),
      kvState({ stateDir, sessionId: 'bbbb0003' }).load(),
    ]);

    expect(sessionFilesIn(stateDir)).toEqual([]);
  });

  test('an absent state directory is not an error and reclaims nothing', async () => {
    const stateDir = join(tmpdir(), `gv-kv-missing-${randomUUID()}`);
    const captured = await captureInfo(async () => {
      await kvState({ stateDir, sessionId: '0000000a' }).load();
    });
    expect(captured.filter((e) => e.message.includes('reclaimed'))).toHaveLength(0);
  });

  test('the legacy unscoped dir gets the AGE bound only — a shared directory must not be count-capped', async () => {
    const stateDir = tempDir('legacy-scoped');
    const legacyStateDir = tempDir('legacy-unscoped');
    // Copy-forward never deletes the source, so legacy files strand there
    // permanently. Age them out.
    writeSessionFile(legacyStateDir, '00000001', 60 * DAY_MS);
    writeSessionFile(legacyStateDir, '00000002', MAX_AGE_MS + DAY_MS);
    // Recent files belonging to some OTHER product sharing this unscoped
    // directory: far more than the count bound, none of them stale. All must
    // survive — a count bound here could delete a session another surface
    // resumes tomorrow.
    for (let i = 0; i < KEEP_COUNT + 20; i += 1) {
      writeSessionFile(legacyStateDir, hexId(0x100 + i), i * 60_000);
    }

    await kvState({ stateDir, legacyStateDir, sessionId: '0000ffff' }).load();

    const survivors = sessionFilesIn(legacyStateDir);
    expect(survivors).toHaveLength(KEEP_COUNT + 20);
    expect(survivors).not.toContain('session_00000001.json');
    expect(survivors).not.toContain('session_00000002.json');
  });

  test('a legacy file being copied forward is never reaped out from under its own session', async () => {
    const stateDir = tempDir('legacy-current-scoped');
    const legacyStateDir = tempDir('legacy-current-unscoped');
    writeSessionFile(legacyStateDir, '0000abcd', 90 * DAY_MS, { id: '0000abcd', started_at: 'then', carried: 'forward' });

    const state = kvState({ stateDir, legacyStateDir, sessionId: '0000abcd' });
    expect(await state.get(['carried'])).toEqual({ carried: 'forward' });
    expect(existsSync(join(legacyStateDir, 'session_0000abcd.json'))).toBe(true);
  });

  test('the static cleanupOldSessions still applies its count bound, and tolerates a missing dir', () => {
    const stateDir = tempDir('static');
    for (let i = 0; i < 5; i += 1) writeSessionFile(stateDir, hexId(i + 1), i * 60_000);

    KVState.cleanupOldSessions(3, { stateDir });
    expect(sessionFilesIn(stateDir)).toHaveLength(3);

    KVState.cleanupOldSessions(10, { stateDir });
    expect(sessionFilesIn(stateDir)).toHaveLength(3);

    expect(() => KVState.cleanupOldSessions(3, { stateDir: join(tmpdir(), `gv-kv-nope-${randomUUID()}`) })).not.toThrow();
  });
});

describe('KVState session-file reads — validated by content, not existence', () => {
  test('a torn (truncated) session file is rejected, not served as state', async () => {
    const stateDir = tempDir('torn');
    writeFileSync(join(stateDir, 'session_1234abcd.json'), '{"id":"1234abcd","star', 'utf-8');

    await expect(kvState({ stateDir, sessionId: '1234abcd' }).load()).rejects.toThrow('JsonFileStore failed to load');
  });

  test('a zero-byte session file is rejected, not served as an empty session', async () => {
    const stateDir = tempDir('zero-byte');
    writeFileSync(join(stateDir, 'session_1234abcd.json'), '', 'utf-8');

    await expect(kvState({ stateDir, sessionId: '1234abcd' }).load()).rejects.toThrow('JsonFileStore failed to load');
  });

  for (const [label, body] of [
    ['an array', '[]'],
    ['a bare number', '1234'],
    ['a bare string', '"session"'],
    ['JSON true', 'true'],
  ] as const) {
    test(`a session file holding ${label} is rejected rather than installed as state`, async () => {
      const stateDir = tempDir('non-object');
      writeFileSync(join(stateDir, 'session_1234abcd.json'), body, 'utf-8');

      await expect(kvState({ stateDir, sessionId: '1234abcd' }).load()).rejects.toThrow(
        'parsed content is not a session state object',
      );
    });
  }

  test('a LEGACY file holding a non-object is treated as absent, and the session starts clean', async () => {
    // The legacy fallback may only ever recover data, never turn junk in the old
    // unscoped directory into a failure for a session that would have started
    // clean — the same rule the corrupt-legacy case already follows.
    const stateDir = tempDir('legacy-non-object-scoped');
    const legacyStateDir = tempDir('legacy-non-object');
    writeFileSync(join(legacyStateDir, 'session_1234abcd.json'), '[1,2,3]', 'utf-8');

    const state = kvState({ stateDir, legacyStateDir, sessionId: '1234abcd' });
    await state.load();

    const all = await state.list();
    expect(all.id).toBe('1234abcd');
    expect(typeof all.started_at).toBe('string');
  });

  test('JSON null in a session file falls through to a clean session rather than crashing later reads', async () => {
    const stateDir = tempDir('json-null');
    writeFileSync(join(stateDir, 'session_1234abcd.json'), 'null', 'utf-8');

    const state = kvState({ stateDir, sessionId: '1234abcd' });
    const all = await state.list();
    expect(all.id).toBe('1234abcd');
  });
});
