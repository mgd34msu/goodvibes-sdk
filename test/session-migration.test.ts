/**
 * session-migration.test.ts — the one-time migration from the pre-surface,
 * pre-agents-subdirectory on-disk layout into the SessionSurface-scoped
 * layout (runtime/session-migration.ts), invoked once per surface from
 * createSessionSurface (session-surface.ts).
 *
 * Seeds a full legacy layout (unscoped last-session pointer, flat agent
 * journals + workmaps + a user conversation sitting together in sessions/,
 * a legacy unscoped checkpoints directory with real git content) and proves:
 * the correct session resumes, journals relocate, user conversations are
 * never touched or moved, checkpoints are usable after the move, the
 * migration is idempotent (a second createSessionSurface call is a no-op),
 * and nothing is silently lost.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSessionSurface } from '../packages/sdk/src/platform/runtime/session-surface.js';
import { readLastSessionPointer } from '../packages/sdk/src/platform/runtime/session-persistence.js';
import { SessionManager } from '../packages/sdk/src/platform/sessions/manager.js';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

/** Structured data from the info lines captured by the most recent withCapturedInfo call. */
let capturedInfoData: Array<Record<string, unknown> | undefined> = [];

/** Run `fn` while capturing logger.info messages (the migration's disclosure lines). */
function withCapturedInfo<T>(fn: () => T): { result: T; infos: string[] } {
  const infos: string[] = [];
  capturedInfoData = [];
  const mutableLogger = logger as unknown as { info(message: string, data?: Record<string, unknown>): void };
  const original = mutableLogger.info.bind(logger);
  mutableLogger.info = (message: string, data?: Record<string, unknown>) => {
    infos.push(message);
    capturedInfoData.push(data);
  };
  try {
    return { result: fn(), infos };
  } finally {
    mutableLogger.info = original;
  }
}

const roots: string[] = [];
function tempRoot(): { workingDirectory: string; homeDirectory: string } {
  const base = join(tmpdir(), `gv-migration-${randomUUID()}`);
  const workingDirectory = join(base, 'work');
  const homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(base);
  return { workingDirectory, homeDirectory };
}

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString('utf8') };
}

function markerPathFor(workingDirectory: string, surfaceRoot: string): string {
  return join(workingDirectory, '.goodvibes', surfaceRoot, '.migrated-v1');
}

describe('session-migration: full legacy layout', () => {
  function seedLegacyLayout(workingDirectory: string): { legacySessionsDir: string; legacyCheckpointsDir: string } {
    // 1. Legacy UNSCOPED last-session pointer (no surfaceRoot segment at all).
    const legacySessionsDir = join(workingDirectory, '.goodvibes', 'sessions');
    mkdirSync(legacySessionsDir, { recursive: true });
    writeFileSync(
      join(legacySessionsDir, 'last-session.json'),
      JSON.stringify({ sessionId: 'resume-me', timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );

    // 2. Legacy layout for the SCOPED sessions dir: a flat agent journal, a
    // flat WRFC workmap, and a genuine user conversation file sitting
    // together (pre-repoint, before agents/session.ts moved to sessions/agents/).
    const scopedSessionsDir = join(workingDirectory, '.goodvibes', 'tui', 'sessions');
    mkdirSync(scopedSessionsDir, { recursive: true });
    writeFileSync(join(scopedSessionsDir, 'agent-deadbeef.jsonl'), JSON.stringify({ type: 'meta', agentId: 'agent-deadbeef' }) + '\n', 'utf-8');
    writeFileSync(join(scopedSessionsDir, 'sess1_workmap.jsonl'), JSON.stringify({ ts: 'x', wrfcId: 'sess1', event: 'chain_passed' }) + '\n', 'utf-8');
    writeFileSync(
      join(scopedSessionsDir, 'resume-me.jsonl'),
      [
        JSON.stringify({ type: 'meta', schemaVersion: 1, timestamp: Date.now(), title: 'My saved chat', model: 'm', provider: 'p', saveSource: 'user' }),
        JSON.stringify({ type: 'message', role: 'user', content: 'hello there' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 3. Legacy unscoped checkpoints dir — populated with real git content by
    // the caller (a WorkspaceCheckpointManager pointed at workingDirectory
    // with no surface, before any surface exists).
    const legacyCheckpointsDir = join(workingDirectory, '.goodvibes', 'checkpoints');
    return { legacySessionsDir, legacyCheckpointsDir };
  }

  test('resumes the correct session, relocates journals, leaves user conversations untouched, and checkpoints stay usable after the move', async () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    seedLegacyLayout(workingDirectory);

    // Seed a real checkpoint via a manager pointed at the legacy path BEFORE
    // any surface exists, so there is genuine git content to move.
    const legacyManager = new WorkspaceCheckpointManager({ workspaceRoot: workingDirectory, autoRetention: false });
    writeFileSync(join(workingDirectory, 'file.txt'), 'v1\n');
    const seededCheckpoint = await legacyManager.create({ kind: 'manual', label: 'pre-migration' });
    expect(seededCheckpoint).not.toBeNull();
    const legacyCheckpointsDir = join(workingDirectory, '.goodvibes', 'checkpoints');
    expect(existsSync(join(legacyCheckpointsDir, 'git', 'HEAD'))).toBe(true);

    // Now construct the surface — this is what triggers migration.
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });

    // Last-session pointer resumed from the legacy unscoped file.
    expect(readLastSessionPointer({ surface })).toBe('resume-me');
    expect(existsSync(surface.lastSessionPointer)).toBe(true);
    // Legacy unscoped pointer file is left in place (one-release grace).
    expect(existsSync(join(workingDirectory, '.goodvibes', 'sessions', 'last-session.json'))).toBe(true);

    // Journals relocated into sessions/agents/.
    expect(existsSync(join(surface.agentJournalsDir, 'agent-deadbeef.jsonl'))).toBe(true);
    expect(existsSync(join(surface.agentJournalsDir, 'sess1_workmap.jsonl'))).toBe(true);
    // ...and are GONE from the flat sessions/ dir (moved, not copied).
    expect(existsSync(join(surface.sessionsDir, 'agent-deadbeef.jsonl'))).toBe(false);
    expect(existsSync(join(surface.sessionsDir, 'sess1_workmap.jsonl'))).toBe(false);

    // The user conversation file is untouched: still in sessions/, never
    // moved into sessions/agents/, content unchanged.
    expect(existsSync(join(surface.sessionsDir, 'resume-me.jsonl'))).toBe(true);
    expect(existsSync(join(surface.agentJournalsDir, 'resume-me.jsonl'))).toBe(false);
    const conversationRaw = readFileSync(join(surface.sessionsDir, 'resume-me.jsonl'), 'utf-8');
    expect(conversationRaw).toContain('hello there');
    expect(conversationRaw).toContain('My saved chat');

    // Checkpoints moved wholesale into the surface-scoped location...
    expect(existsSync(join(surface.checkpointsDir, 'git', 'HEAD'))).toBe(true);
    // ...and the legacy path is gone (a real move, not a copy).
    expect(existsSync(legacyCheckpointsDir)).toBe(false);

    // Checkpoints remain fully usable after the move: a fresh
    // surface-constructed manager sees the pre-migration checkpoint and can
    // create new ones and restore.
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: workingDirectory, surface, autoRetention: false });
    const existing = await manager.list();
    expect(existing.map((c) => c.id)).toContain(seededCheckpoint!.id);

    writeFileSync(join(workingDirectory, 'file.txt'), 'v2\n');
    const cp2 = await manager.create({ kind: 'manual', label: 'post-migration' });
    expect(cp2).not.toBeNull();

    await manager.restore(seededCheckpoint!.id, { safetyCheckpoint: false });
    expect(readFileSync(join(workingDirectory, 'file.txt'), 'utf-8')).toBe('v1\n');

    const gitDir = join(surface.checkpointsDir, 'git');
    const fsck = runGit(workingDirectory, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);
  });

  test('is idempotent: a second createSessionSurface call does nothing further (marker guards it)', async () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    seedLegacyLayout(workingDirectory);

    const surfaceA = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    const markerPath = markerPathFor(workingDirectory, 'tui');
    expect(existsSync(markerPath)).toBe(true);
    const markerMtimeAfterFirst = statSync(markerPath).mtimeMs;

    // Modify the (already-migrated) canonical last-session pointer to a
    // DIFFERENT session id, and re-create the (already-gone) legacy unscoped
    // pointer pointing at yet another id — if migration re-ran, it could
    // clobber the canonical value; idempotency means it must not.
    writeFileSync(surfaceA.lastSessionPointer, JSON.stringify({ sessionId: 'post-migration-value', timestamp: new Date().toISOString() }) + '\n', 'utf-8');
    const legacyPointer = join(workingDirectory, '.goodvibes', 'sessions', 'last-session.json');
    const future = new Date(Date.now() + 60_000);
    writeFileSync(legacyPointer, JSON.stringify({ sessionId: 'should-not-win', timestamp: new Date().toISOString() }) + '\n', 'utf-8');
    utimesSync(legacyPointer, future, future);

    const surfaceB = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    expect(readLastSessionPointer({ surface: surfaceB })).toBe('post-migration-value');
    // Marker untouched (migration did not run a second time).
    expect(statSync(markerPath).mtimeMs).toBe(markerMtimeAfterFirst);
  });

  test('a fresh surface with no legacy data at all migrates cleanly (no-op, no errors)', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    expect(existsSync(markerPathFor(workingDirectory, 'tui'))).toBe(true);
    expect(readLastSessionPointer({ surface })).toBeNull();
  });

  test('R4: a user-saved session whose name looks like an agent journal is NEVER moved out of the session list', () => {
    // Reproduction: the journal move matched on filename alone, and
    // SessionManager.sanitizeName keeps the `agent-` prefix — so a
    // conversation the user saved as "agent-deadbeef" was relocated into
    // sessions/agents/ by the upgrade and vanished from list().
    const { workingDirectory, homeDirectory } = tempRoot();
    const mgr = new SessionManager(workingDirectory, { surfaceRoot: 'tui' });
    const { filePath } = mgr.save(
      'agent-deadbeef',
      [{ role: 'user', content: 'user conversation' }],
      { title: 'Agent-DEADBEEF debugging notes', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' },
    );
    const workmapNamed = mgr.save(
      'release_workmap',
      [{ role: 'user', content: 'also a conversation' }],
      { title: 'Release workmap notes', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' },
    ).filePath;

    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(workmapNamed)).toBe(true);
    expect(existsSync(join(surface.agentJournalsDir, 'agent-deadbeef.jsonl'))).toBe(false);
    expect(existsSync(join(surface.agentJournalsDir, 'release_workmap.jsonl'))).toBe(false);
    expect(mgr.list().map((s) => s.name).sort()).toEqual(['agent-deadbeef', 'release_workmap']);
  });
});

describe('session-migration: the marker only appears when every step completed', () => {
  test('a failed step leaves the marker unwritten so the next start retries — and the retry finishes the job', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const scopedSessionsDir = join(workingDirectory, '.goodvibes', 'tui', 'sessions');
    mkdirSync(scopedSessionsDir, { recursive: true });
    const journal = join(scopedSessionsDir, 'agent-deadbeef.jsonl');
    writeFileSync(journal, JSON.stringify({ type: 'meta', agentId: 'agent-deadbeef' }) + '\n', 'utf-8');
    // sessions/agents exists as a FILE: the journal move's mkdirSync throws,
    // so the step genuinely fails (nothing is moved, nothing is lost).
    const blocker = join(scopedSessionsDir, 'agents');
    writeFileSync(blocker, 'not a directory\n', 'utf-8');

    createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    expect(existsSync(markerPathFor(workingDirectory, 'tui'))).toBe(false);
    // The journal is exactly where it was — a failed step moves nothing.
    expect(existsSync(journal)).toBe(true);

    // Clear the obstruction: the next start retries the whole (idempotent)
    // pass and this time completes and marks it.
    rmSync(blocker);
    const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
    expect(existsSync(markerPathFor(workingDirectory, 'tui'))).toBe(true);
    expect(existsSync(join(surface.agentJournalsDir, 'agent-deadbeef.jsonl'))).toBe(true);
    expect(existsSync(journal)).toBe(false);
  });
});

describe('session-migration: the shared legacy checkpoint store is never claimed silently', () => {
  test('adopting the legacy store leaves a findable marker at the old location and logs the adoption', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const legacyCheckpointsDir = join(workingDirectory, '.goodvibes', 'checkpoints');
    mkdirSync(join(legacyCheckpointsDir, 'git'), { recursive: true });
    writeFileSync(join(legacyCheckpointsDir, 'git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');

    const { result: surface, infos } = withCapturedInfo(() =>
      createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory }),
    );

    // The store moved...
    expect(existsSync(join(surface.checkpointsDir, 'git', 'HEAD'))).toBe(true);
    expect(existsSync(legacyCheckpointsDir)).toBe(false);
    // ...and said so.
    expect(infos.some((m) => m.includes('adopted the shared legacy checkpoint store'))).toBe(true);

    // A second product working in this directory finds a trace, not a void.
    const markerPath = join(workingDirectory, '.goodvibes', 'checkpoints-moved.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      movedTo?: string; surfaceRoot?: string; date?: string;
    };
    expect(marker.movedTo).toBe(surface.checkpointsDir);
    expect(marker.surfaceRoot).toBe('tui');
    expect(typeof marker.date).toBe('string');
  });

  test('when the scoped store already exists, the stranded legacy store is disclosed by name and never deleted', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    // Scoped store first (this surface already has its own history)...
    const scopedCheckpointsDir = join(workingDirectory, '.goodvibes', 'tui', 'checkpoints');
    mkdirSync(join(scopedCheckpointsDir, 'git'), { recursive: true });
    writeFileSync(join(scopedCheckpointsDir, 'git', 'HEAD'), 'ref: refs/heads/scoped\n', 'utf-8');
    // ...alongside an older shared legacy store that nothing else reclaims.
    const legacyCheckpointsDir = join(workingDirectory, '.goodvibes', 'checkpoints');
    mkdirSync(join(legacyCheckpointsDir, 'git'), { recursive: true });
    writeFileSync(join(legacyCheckpointsDir, 'git', 'HEAD'), 'ref: refs/heads/legacy\n', 'utf-8');

    const { infos } = withCapturedInfo(() =>
      createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory }),
    );

    // Untouched — a git store that may hold real history is never auto-deleted.
    expect(readFileSync(join(legacyCheckpointsDir, 'git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/legacy\n');
    expect(readFileSync(join(scopedCheckpointsDir, 'git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/scoped\n');
    // ...but disclosed by name, so it is findable rather than silently orphaned.
    expect(infos.some((m) => m.includes('legacy checkpoint store left in place'))).toBe(true);
    expect(capturedInfoData.some((d) => d?.strandedLegacyCheckpoints === legacyCheckpointsDir)).toBe(true);
    // Nothing was adopted, so no adoption marker is written.
    expect(existsSync(join(workingDirectory, '.goodvibes', 'checkpoints-moved.json'))).toBe(false);
  });
});
