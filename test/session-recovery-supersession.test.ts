/**
 * session-recovery-supersession.test.ts — a crash snapshot is judged against
 * ITS OWN session's durable store file, never against the global last-session
 * pointer.
 *
 * Defect class: the offer used to compare a snapshot's mtime against the
 * last-session POINTER's mtime, and that pointer advances on every
 * turn-completion persist of ANY session. So (a) answering "Keep" to the
 * recovery offer and then sending one message in the new session permanently
 * buried the kept snapshot, and (b) a reflexive `--continue` after a crash
 * resumed the store copy, advanced the pointer, and silently dropped the tail
 * of messages only the snapshot held.
 *
 * The rule under test now: offer a snapshot when it is strictly newer than its
 * own session's store file, or when that session has no store file at all.
 * Equal mtimes do not offer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkRecoveryFile,
  checkRecoveryForSession,
  persistConversation,
  readLastSessionPointer,
  saveSession,
  writeRecoveryFile,
  type SessionSnapshot,
} from '../packages/sdk/src/platform/runtime/session-persistence.ts';
import { createSessionSurface, type SessionSurface } from '../packages/sdk/src/platform/runtime/session-surface.ts';
import { resolveSharedDirectory } from '../packages/sdk/src/platform/runtime/surface-root.ts';
import { sanitizeSessionName } from '../packages/sdk/src/platform/sessions/manager.ts';

const roots: string[] = [];

function tempSurface(): { surface: SessionSurface; workingDirectory: string; homeDirectory: string } {
  const base = join(tmpdir(), `gv-supersession-${randomUUID()}`);
  const workingDirectory = join(base, 'work');
  const homeDirectory = join(base, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(base);
  return {
    surface: createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory }),
    workingDirectory,
    homeDirectory,
  };
}

function snapshotOf(text: string): SessionSnapshot {
  return { messages: [{ role: 'user', content: text }], timestamp: Date.now() };
}

/** The durable store file a session's clean saves land in, under this surface. */
function storePath(surface: SessionSurface, sessionId: string): string {
  return join(surface.sessionsDir, `${sanitizeSessionName(sessionId)}.jsonl`);
}

/** Pin a file's mtime exactly, so "newer / older / equal" is not a race. */
function setMtime(path: string, at: Date): void {
  utimesSync(path, at, at);
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('recovery offer: supersession is per-session, not the global pointer', () => {
  test('a kept snapshot survives another session sending a message (the pointer advancing does NOT bury it)', () => {
    // The shipping "Keep" flow: the user declines to restore, keeps the
    // snapshot, and then works in a brand new session. Every turn of that new
    // session advances the last-session pointer.
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('unsaved crash tail'), 'sess-kept', 'Kept Work', { surface });
    const keptSnapshot = surface.recoveryFile('sess-kept');
    setMtime(keptSnapshot, new Date(Date.now() - 120_000));

    // A different session persists a turn: its store is written and the
    // pointer moves to it, both strictly newer than the kept snapshot.
    persistConversation('sess-other', snapshotOf('a message in a new session'), 'm', 'p', 'Other', { surface });

    // The pointer really did advance — this is exactly the state that used to
    // bury the kept snapshot.
    expect(readLastSessionPointer({ surface })).toBe('sess-other');
    expect(statSync(surface.lastSessionPointer).mtimeMs).toBeGreaterThan(statSync(keptSnapshot).mtimeMs);

    // ...and the kept snapshot is still offered, because ITS session
    // ('sess-kept') never saved anything.
    const offered = checkRecoveryFile({ surface });
    expect(offered?.sessionId).toBe('sess-kept');
    expect(offered?.title).toBe('Kept Work');
    expect(existsSync(keptSnapshot)).toBe(true);
  });

  test('a session\'s OWN clean save supersedes its snapshot', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('older tail'), 'sess-own', 'Own', { surface });
    saveSession('sess-own', snapshotOf('the saved conversation'), 'm', 'p', 'Own', { surface });

    setMtime(surface.recoveryFile('sess-own'), new Date(Date.now() - 60_000));
    setMtime(storePath(surface, 'sess-own'), new Date());

    expect(checkRecoveryFile({ surface })).toBeNull();
  });

  test('no store file for the snapshot\'s session → offered', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('never saved'), 'sess-nostore', 'No Store', { surface });
    expect(existsSync(storePath(surface, 'sess-nostore'))).toBe(false);

    expect(checkRecoveryFile({ surface })?.sessionId).toBe('sess-nostore');
  });

  test('equal mtimes → not offered (the tie goes to the durable copy)', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('same instant'), 'sess-tie', 'Tie', { surface });
    saveSession('sess-tie', snapshotOf('same instant'), 'm', 'p', 'Tie', { surface });

    const sameInstant = new Date(Date.now() - 10_000);
    setMtime(surface.recoveryFile('sess-tie'), sameInstant);
    setMtime(storePath(surface, 'sess-tie'), sameInstant);
    expect(statSync(surface.recoveryFile('sess-tie')).mtimeMs).toBe(statSync(storePath(surface, 'sess-tie')).mtimeMs);

    expect(checkRecoveryFile({ surface })).toBeNull();
  });

  test('a snapshot strictly newer than its own store IS offered', () => {
    const { surface } = tempSurface();
    saveSession('sess-tail', snapshotOf('what the store has'), 'm', 'p', 'Tail', { surface });
    writeRecoveryFile(snapshotOf('what only the snapshot has'), 'sess-tail', 'Tail', { surface });

    setMtime(storePath(surface, 'sess-tail'), new Date(Date.now() - 60_000));
    setMtime(surface.recoveryFile('sess-tail'), new Date());

    expect(checkRecoveryFile({ surface })?.sessionId).toBe('sess-tail');
  });

  test('an UNRELATED session\'s newer store never supersedes this session\'s snapshot', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('mine'), 'sess-mine', 'Mine', { surface });
    saveSession('sess-theirs', snapshotOf('theirs'), 'm', 'p', 'Theirs', { surface });

    setMtime(surface.recoveryFile('sess-mine'), new Date(Date.now() - 60_000));
    setMtime(storePath(surface, 'sess-theirs'), new Date());

    expect(checkRecoveryFile({ surface })?.sessionId).toBe('sess-mine');
  });

  test('the newest non-superseded snapshot wins: a superseded newer one is skipped, not returned', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('live'), 'sess-live', 'Live', { surface });
    writeRecoveryFile(snapshotOf('dead'), 'sess-dead', 'Dead', { surface });
    saveSession('sess-dead', snapshotOf('dead, saved'), 'm', 'p', 'Dead', { surface });

    // The superseded one is the NEWEST file on disk, so a scan that stopped at
    // the newest candidate would return it.
    setMtime(surface.recoveryFile('sess-live'), new Date(Date.now() - 60_000));
    setMtime(surface.recoveryFile('sess-dead'), new Date(Date.now() - 30_000));
    setMtime(storePath(surface, 'sess-dead'), new Date());

    expect(checkRecoveryFile({ surface })?.sessionId).toBe('sess-live');
  });

  test('the legacy (non-surface) option form follows the same per-session rule', () => {
    const { workingDirectory, homeDirectory } = tempSurface();
    const options = { workingDirectory, homeDirectory };

    writeRecoveryFile(snapshotOf('legacy tail'), 'legacyid', 'Legacy', options);
    // Nothing saved yet → offered.
    expect(checkRecoveryFile(options)?.sessionId).toBe('legacyid');

    saveSession('legacyid', snapshotOf('legacy saved'), 'm', 'p', 'Legacy', options);
    const legacyStore = join(resolveSharedDirectory(workingDirectory, 'sessions'), 'legacyid.jsonl');
    expect(existsSync(legacyStore)).toBe(true);
    setMtime(join(resolveSharedDirectory(homeDirectory, 'recovery'), 'recovery-legacyid.jsonl'), new Date(Date.now() - 60_000));
    setMtime(legacyStore, new Date());

    // Its own clean save superseded it.
    expect(checkRecoveryFile(options)).toBeNull();
  });
});

describe('recovery offer: legacy shared directory under the per-session rule', () => {
  function writeLegacySharedRecovery(surface: SessionSurface, sessionId: string, text: string, title: string): string {
    const dir = resolveSharedDirectory(surface.homeDirectory, 'recovery');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `recovery-${sessionId}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'meta', sessionId, title, timestamp: Date.now() }),
        JSON.stringify({ type: 'message', role: 'user', content: text }),
      ].join('\n') + '\n',
      'utf-8',
    );
    return path;
  }

  test('a legacy shared snapshot whose session has no store in this scope is offered', () => {
    const { surface } = tempSurface();
    writeLegacySharedRecovery(surface, 'pre-upgrade', 'from before scoping', 'Pre-Upgrade');
    // Unrelated activity that used to advance the pointer past it.
    persistConversation('sess-current', snapshotOf('current work'), 'm', 'p', 'Current', { surface });

    expect(checkRecoveryFile({ surface })?.sessionId).toBe('pre-upgrade');
  });

  test('a legacy shared snapshot IS superseded by its own session\'s store in this scope', () => {
    const { surface } = tempSurface();
    const legacyPath = writeLegacySharedRecovery(surface, 'shared-id', 'stale legacy body', 'Stale');
    saveSession('shared-id', snapshotOf('saved under the surface'), 'm', 'p', 'Stale', { surface });
    setMtime(legacyPath, new Date(Date.now() - 60_000));
    setMtime(storePath(surface, 'shared-id'), new Date());

    expect(checkRecoveryFile({ surface })).toBeNull();
  });
});

describe('checkRecoveryForSession: the --continue probe', () => {
  test('reports a snapshot newer than that session\'s store', () => {
    const { surface } = tempSurface();
    saveSession('sess-probe', snapshotOf('store copy'), 'm', 'p', 'Probe', { surface });
    writeRecoveryFile(snapshotOf('snapshot tail'), 'sess-probe', 'Probe', { surface });
    setMtime(storePath(surface, 'sess-probe'), new Date(Date.now() - 60_000));
    setMtime(surface.recoveryFile('sess-probe'), new Date());

    const info = checkRecoveryForSession(surface, 'sess-probe');
    expect(info?.sessionId).toBe('sess-probe');
    expect(info?.title).toBe('Probe');
    // Probing is read-only: nothing is retired by asking.
    expect(existsSync(surface.recoveryFile('sess-probe'))).toBe(true);
  });

  test('reports nothing when that session\'s store is newer than its snapshot', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('older tail'), 'sess-saved', 'Saved', { surface });
    saveSession('sess-saved', snapshotOf('store copy'), 'm', 'p', 'Saved', { surface });
    setMtime(surface.recoveryFile('sess-saved'), new Date(Date.now() - 60_000));
    setMtime(storePath(surface, 'sess-saved'), new Date());

    expect(checkRecoveryForSession(surface, 'sess-saved')).toBeNull();
  });

  test('reports a snapshot for a session that never saved a store file', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('never saved'), 'sess-fresh', 'Fresh', { surface });
    expect(checkRecoveryForSession(surface, 'sess-fresh')?.sessionId).toBe('sess-fresh');
  });

  test('reports nothing for a session with no snapshot at all', () => {
    const { surface } = tempSurface();
    saveSession('sess-clean', snapshotOf('store copy'), 'm', 'p', 'Clean', { surface });
    expect(checkRecoveryForSession(surface, 'sess-clean')).toBeNull();
    expect(checkRecoveryForSession(surface, 'never-existed')).toBeNull();
  });

  test('answers about the NAMED session, not whichever snapshot happens to be newest', () => {
    const { surface } = tempSurface();
    writeRecoveryFile(snapshotOf('someone else'), 'sess-noisy', 'Noisy', { surface });
    saveSession('sess-quiet', snapshotOf('quiet store'), 'm', 'p', 'Quiet', { surface });
    setMtime(storePath(surface, 'sess-quiet'), new Date());
    setMtime(surface.recoveryFile('sess-noisy'), new Date(Date.now() + 60_000));

    // A newer, unrelated snapshot exists — the probe still answers "no unsaved
    // crash data" for the session actually being resumed.
    expect(checkRecoveryForSession(surface, 'sess-quiet')).toBeNull();
    expect(checkRecoveryForSession(surface, 'sess-noisy')?.sessionId).toBe('sess-noisy');
  });

  test('finds a snapshot that only lives in the legacy shared directory', () => {
    const { surface } = tempSurface();
    const dir = resolveSharedDirectory(surface.homeDirectory, 'recovery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'recovery-legacy-probe.jsonl'),
      [
        JSON.stringify({ type: 'meta', sessionId: 'legacy-probe', title: 'Legacy Probe', timestamp: Date.now() }),
        JSON.stringify({ type: 'message', role: 'user', content: 'legacy body' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(checkRecoveryForSession(surface, 'legacy-probe')?.title).toBe('Legacy Probe');
  });
});
