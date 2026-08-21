/**
 * session-recovery-per-session.test.ts, crash snapshots are per-session.
 *
 * Defect class: a single shared `recovery.jsonl` meant two concurrent sessions
 * crashing (or snapshotting) at once clobbered each other, which is exactly why
 * the consuming surface grew a `.preserved` collision workaround. Recovery is
 * now `recovery-<sessionId>.jsonl` per session; restore is silent and receipted;
 * no `.preserved` path exists in SDK code.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  autoRestoreRecovery,
  checkRecoveryFile,
  deleteRecoveryFile,
  getRecoveryDir,
  getRecoveryFilePath,
  loadRecoveryConversation,
  writeRecoveryFile,
  type SessionSnapshot,
} from '../packages/sdk/src/platform/runtime/session-persistence.ts';

const roots: string[] = [];

function tempRoot(): { workingDirectory: string; homeDirectory: string } {
  const base = join(tmpdir(), `gv-recovery-${randomUUID()}`);
  const workingDirectory = join(base, 'work');
  const homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(base);
  return { workingDirectory, homeDirectory };
}

function snapshotOf(text: string): SessionSnapshot {
  return { messages: [{ role: 'user', content: text }], timestamp: Date.now() };
}

/**
 * Stamp a snapshot far enough in the past that the boot offer stops reading it
 * as one a running process is still rewriting. `secondsBefore` orders two aged
 * snapshots against each other. Tests that assert a snapshot IS offered have to
 * do this: a file written this instant genuinely does look like live state.
 */
function ageOut(path: string, secondsBefore = 0): void {
  const at = new Date(Date.now() - 600_000 - secondsBefore * 1000);
  execFileSync('touch', ['-d', at.toISOString(), path]);
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('per-session recovery snapshots', () => {
  test('two concurrent sessions snapshot without clobbering', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const opts = { workingDirectory, homeDirectory };

    writeRecoveryFile(snapshotOf('from session A'), 'aaaa1111', 'Session A', opts);
    writeRecoveryFile(snapshotOf('from session B'), 'bbbb2222', 'Session B', opts);

    // Both per-session files exist side by side.
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'aaaa1111'))).toBe(true);
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'bbbb2222'))).toBe(true);
    const files = readdirSync(getRecoveryDir(homeDirectory)).filter((n) => n.startsWith('recovery-'));
    expect(files.length).toBe(2);

    // Each loads back its own conversation.
    const a = loadRecoveryConversation(opts, 'aaaa1111');
    const b = loadRecoveryConversation(opts, 'bbbb2222');
    expect(a?.messages[0]?.content).toBe('from session A');
    expect(b?.messages[0]?.content).toBe('from session B');
    expect(a?.title).toBe('Session A');
    expect(b?.title).toBe('Session B');
  });

  test('restore is silent and enqueues exactly one receipt', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const opts = { workingDirectory, homeDirectory };
    writeRecoveryFile(snapshotOf('interrupted work'), 'cccc3333', 'My Task', opts);
    ageOut(getRecoveryFilePath(homeDirectory, 'cccc3333'));

    const recorded: Array<{ id: string; text?: string }> = [];
    const sink = {
      record(id: string, text?: string): boolean {
        // Exactly-once semantics, mirroring FeatureAnnouncementStore.record.
        if (recorded.some((r) => r.id === id)) return false;
        recorded.push({ id, ...(text !== undefined ? { text } : {}) });
        return true;
      },
    };

    const result = autoRestoreRecovery(opts, sink);
    expect(result).not.toBeNull();
    expect(result?.snapshot.messages[0]?.content).toBe('interrupted work');
    // One receipt line, addressed to this session.
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.id).toBe('session-recovery-restored:cccc3333');
    expect(recorded[0]?.text).toContain('My Task');
    expect(recorded[0]?.text).toContain('1 message');
    // The snapshot is cleared after restore, so it is not re-offered.
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'cccc3333'))).toBe(false);
    expect(checkRecoveryFile(opts)).toBeNull();
  });

  test('auto-restore retires ONLY the snapshot it restored, even when that snapshot has no session id', () => {
    // A snapshot whose meta carries no sessionId used to fall through to the
    // keyless full-reset delete, taking every other session's untouched crash
    // snapshot with it. The restore now deletes exactly the file it read.
    const { workingDirectory, homeDirectory } = tempRoot();
    const opts = { workingDirectory, homeDirectory };
    writeRecoveryFile(snapshotOf('bystander work'), 'dddd4444', 'Bystander', opts);
    const bystanderPath = getRecoveryFilePath(homeDirectory, 'dddd4444');
    ageOut(bystanderPath, 60);

    // A snapshot with an empty session id, written later so it is the newest.
    const idlessPath = join(getRecoveryDir(homeDirectory), 'recovery-idless.jsonl');
    writeFileSync(
      idlessPath,
      [
        JSON.stringify({ type: 'meta', sessionId: '', title: 'No Id', timestamp: Date.now() }),
        JSON.stringify({ type: 'message', role: 'user', content: 'restore me' }),
      ].join('\n') + '\n',
      'utf-8',
    );
    ageOut(idlessPath);

    const result = autoRestoreRecovery(opts);
    expect(result?.snapshot.messages[0]?.content).toBe('restore me');
    expect(existsSync(idlessPath)).toBe(false);
    // The unrelated session's snapshot is untouched.
    expect(existsSync(bystanderPath)).toBe(true);
  });

  test('checkRecoveryFile offers the newest live crash snapshot', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const opts = { workingDirectory, homeDirectory };
    writeRecoveryFile(snapshotOf('older'), 'old00000', 'Older', opts);
    writeRecoveryFile(snapshotOf('newer'), 'new11111', 'Newer', opts);
    // Distinct mtimes, both old enough that no live writer is implied.
    ageOut(getRecoveryFilePath(homeDirectory, 'old00000'), 60);
    ageOut(getRecoveryFilePath(homeDirectory, 'new11111'));

    const offered = checkRecoveryFile(opts);
    expect(offered?.sessionId).toBe('new11111');
    expect(offered?.title).toBe('Newer');
  });

  test('deleteRecoveryFile clears one session or all', () => {
    const { workingDirectory, homeDirectory } = tempRoot();
    const opts = { workingDirectory, homeDirectory };
    writeRecoveryFile(snapshotOf('a'), 'sess-a', '', opts);
    writeRecoveryFile(snapshotOf('b'), 'sess-b', '', opts);

    deleteRecoveryFile(opts, 'sess-a');
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'sess-a'))).toBe(false);
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'sess-b'))).toBe(true);

    deleteRecoveryFile(opts);
    expect(existsSync(getRecoveryFilePath(homeDirectory, 'sess-b'))).toBe(false);
  });
});

describe('no .preserved collision machinery in SDK code', () => {
  test('the SDK source tree contains no recovery .preserved path suffix', () => {
    // The `.preserved` file-suffix workaround was a consumer-side response to
    // the shared recovery file colliding. A `.preserved` used as a path suffix
    // (a string literal boundary follows it) must never exist in SDK code.
    // (`.preservedCommit`, a worktree property name, is deliberately not a
    // match, a letter, not a string boundary, follows it.)
    // grep exits 1 (no matches) → clean; exits 0 with a file list → matches found.
    let matched = '';
    try {
      matched = execFileSync(
        'grep',
        ['-rIlE', '--include=*.ts', String.raw`\.preserved['"` + '`' + String.raw`/]`, 'packages/sdk/src'],
        { encoding: 'utf-8', cwd: join(import.meta.dir, '..') },
      ).trim();
    } catch (err) {
      const status = (err as { status?: number }).status;
      // status 1 = grep found nothing (the passing case). Anything else is a
      // real failure to surface.
      if (status !== 1) throw err;
      matched = '';
    }
    expect(matched).toBe('');
  });
});
