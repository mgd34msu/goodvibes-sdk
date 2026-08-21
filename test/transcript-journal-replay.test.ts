/**
 * Tests for folding a transcript journal back into a live conversation.
 *
 * Real file I/O in concurrency-safe temp directories, against a real
 * ConversationManager, the seam's whole job is what the conversation holds
 * afterwards, so a stub conversation would prove nothing.
 *
 * Scenarios covered:
 *   - e2e replay: post-snapshot records applied, snapshot persisted, journal rotated.
 *   - Nothing newer than the snapshot: silent rotate, conversation untouched.
 *   - Corrupt header and unknown schemaVersion: quarantined, nothing applied.
 *   - Partial corrupt tail: good records applied, hadCorruptTail flagged.
 *   - Session identity (title/titleSource) survives replay.
 *   - Authoritative-record selection by newest ts, ties broken by highest seq.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import {
  JOURNAL_SCHEMA_VERSION,
  journalPathFor,
  openTranscriptJournal,
} from '../packages/sdk/src/platform/runtime/transcript-journal.ts';
import {
  replayJournalForSession,
  replayJournalIntoConversation,
} from '../packages/sdk/src/platform/runtime/transcript-journal-replay.ts';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.ts';
import { makeTestSurface } from './_helpers/session-surface.ts';

type MsgStub = { role: string; content: string };

function makeMessages(count: number): MsgStub[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
  }));
}

/** Append `recordCount` records to a journal, all post-dating the snapshot. */
function writeJournalWithRecords(journalPath: string, sessionId: string, recordCount: number): void {
  const dir = join(journalPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const journal = openTranscriptJournal(journalPath, sessionId);
  for (let i = 0; i < recordCount; i++) {
    journal.appendRecord(
      i === recordCount - 1 ? 'assistant_turn' : 'user_message',
      makeMessages(i + 2) as never,
    );
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-journal-replay-test');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('replayJournalIntoConversation', () => {
  test('e2e: replays journal records onto conversation, writes snapshot, rotates journal', () => {
    const journalPath = join(tmpDir, 'transcript-e2e.journal');
    const sessionId = 'ses-e2e-test';
    const snapshotTimestamp = Date.now() - 5000; // snapshot taken 5s ago

    // Build journal with two post-snapshot records. Each record carries
    // the full conversation at that moment. The last record is authoritative.
    const earlyMessages = makeMessages(2);
    const latestMessages = makeMessages(4); // most recent, 4 messages
    const journal = openTranscriptJournal(journalPath, sessionId);
    journal.appendRecord('user_message', earlyMessages as never);
    journal.appendRecord('assistant_turn', latestMessages as never);

    const conversation = new ConversationManager();
    let persistCalled = false;
    let persistedMessages: unknown[] = [];

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: (msgs) => {
        persistCalled = true;
        persistedMessages = msgs as unknown[];
      },
    });

    // Replayed 2 records.
    expect(result.replayed).toBe(2);
    expect(result.hadCorruptTail).toBe(false);

    // Conversation now reflects the last (most recent) journal record.
    expect(conversation.getMessageCount()).toBe(latestMessages.length);

    // persistSnapshot was called with the final record's messages.
    expect(persistCalled).toBe(true);
    expect(persistedMessages).toHaveLength(latestMessages.length);

    // Journal is rotated (deleted) after successful replay.
    expect(existsSync(journalPath)).toBe(false);
  });

  test('edge: all journal records older than snapshot — silent rotate, conversation unchanged', () => {
    const journalPath = join(tmpDir, 'transcript-old.journal');
    const sessionId = 'ses-old-test';
    const futureSnapshot = Date.now() + 100_000; // snapshot far in the future

    const journal = openTranscriptJournal(journalPath, sessionId);
    journal.appendRecord('user_message', makeMessages(2) as never);
    journal.appendRecord('assistant_turn', makeMessages(3) as never);

    const conversation = new ConversationManager();
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: futureSnapshot,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed, all records pre-date the snapshot timestamp.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(false);

    // Conversation is empty (nothing was applied).
    expect(conversation.getMessageCount()).toBe(0);

    // persistSnapshot was NOT called.
    expect(persistCalled).toBe(false);

    // Journal is rotated (stale gap-filler deleted).
    expect(existsSync(journalPath)).toBe(false);
  });

  test('edge: journal corrupt from line 1 (bad JSON header) — quarantine, snapshot unchanged', () => {
    const journalPath = join(tmpDir, 'transcript-corrupt-header.journal');
    const sessionId = 'ses-corrupt-test';

    // Write a completely malformed journal.
    writeFileSync(journalPath, '{not valid json at all\n', 'utf-8');

    const conversation = new ConversationManager();
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed due to corrupt header.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation unchanged.
    expect(conversation.getMessageCount()).toBe(0);

    // persistSnapshot NOT called.
    expect(persistCalled).toBe(false);

    // File was quarantined.
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('edge: journal schemaVersion mismatch — quarantine, no replay', () => {
    const journalPath = join(tmpDir, 'transcript-ver-mismatch.journal');
    const sessionId = 'ses-ver-test';

    // Write a journal with an unrecognised version.
    const badHeader = JSON.stringify({ version: 99, sessionId, createdAt: Date.now() });
    const validRecord = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: makeMessages(2) });
    writeFileSync(journalPath, `${badHeader}\n${validRecord}\n`, 'utf-8');

    const conversation = new ConversationManager();
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed, version gate quarantined the file.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation unchanged, persistSnapshot not called.
    expect(conversation.getMessageCount()).toBe(0);
    expect(persistCalled).toBe(false);

    // File quarantined.
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('e2e: partial corrupt tail — replays good records, flags hadCorruptTail', () => {
    const journalPath = join(tmpDir, 'transcript-partial-corrupt.journal');
    const sessionId = 'ses-partial-test';
    const snapshotTimestamp = Date.now() - 5000;

    // Write a valid header + one good record + truncated third line.
    const header = JSON.stringify({ version: JOURNAL_SCHEMA_VERSION, sessionId, createdAt: Date.now() });
    const goodRecord = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: makeMessages(3) });
    writeFileSync(journalPath, `${header}\n${goodRecord}\n{"type":"assis`, 'utf-8');

    const conversation = new ConversationManager();
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // 1 good record replayed, corrupt tail flagged.
    expect(result.replayed).toBe(1);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation has the 3 messages from the good record.
    expect(conversation.getMessageCount()).toBe(3);

    // persistSnapshot called (we had records to replay).
    expect(persistCalled).toBe(true);

    // Journal file quarantined (renamed) by replayJournal.
    expect(existsSync(journalPath)).toBe(false);
  });

  test('a conversation with no rendered history to rebuild replays the same', () => {
    const journalPath = join(tmpDir, 'transcript-headless.journal');
    const sessionId = 'ses-headless';
    writeJournalWithRecords(journalPath, sessionId, 2);

    const conversation = new ConversationManager();
    // `rebuildHistory` is deliberately absent from the base conversation; the
    // seam must not require it.
    expect((conversation as { rebuildHistory?: unknown }).rebuildHistory).toBeUndefined();

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBe(2);
    expect(conversation.getMessageCount()).toBe(3);
  });

  test('a rendering surface gets its history rebuilt after the messages change', () => {
    const journalPath = join(tmpDir, 'transcript-rendering.journal');
    const sessionId = 'ses-rendering';
    writeJournalWithRecords(journalPath, sessionId, 1);

    let rebuiltWith = -1;
    const base = new ConversationManager();
    const conversation = Object.assign(base, {
      rebuildHistory: () => {
        rebuiltWith = base.getMessageCount();
      },
    });

    replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    // Rebuilt AFTER the replayed messages were applied, never before.
    expect(rebuiltWith).toBe(2);
  });
});

describe('replayJournalForSession', () => {
  test('resolves the journal off the surface and replays it', () => {
    const sessionId = 'seam1-basic';
    const surface = makeTestSurface(tmpDir);
    writeJournalWithRecords(journalPathFor(surface, sessionId), sessionId, 2);

    const conversation = new ConversationManager();
    const result = replayJournalForSession({
      surface,
      sessionId,
      snapshotTimestamp: 0,
      conversation,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBe(2);
    expect(conversation.getMessageCount()).toBe(3);
  });

  test('no-op when no journal exists for the session', () => {
    const conversation = new ConversationManager();
    let persistCalled = false;
    const result = replayJournalForSession({
      surface: makeTestSurface(tmpDir),
      sessionId: 'seam1-absent',
      snapshotTimestamp: 0,
      conversation,
      persistSnapshot: () => { persistCalled = true; },
    });

    expect(result.replayed).toBe(0);
    expect(conversation.getMessageCount()).toBe(0);
    expect(persistCalled).toBe(false);
  });

  test('session title survives journal replay', () => {
    // Journal records carry messages only; a bare fromJSON({ messages }) would
    // wipe the title the resume seam just restored.
    const sessionId = 'seam1-title-survival';
    const surface = makeTestSurface(tmpDir);
    writeJournalWithRecords(journalPathFor(surface, sessionId), sessionId, 1);

    const conversation = new ConversationManager();
    conversation.fromJSON({ messages: [] as never[], title: 'My Important Session', titleSource: 'user' });
    expect(conversation.title).toBe('My Important Session');

    const result = replayJournalForSession({
      surface,
      sessionId,
      snapshotTimestamp: 0,
      conversation,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBeGreaterThan(0);
    expect(conversation.title).toBe('My Important Session');
  });
});

describe('session identity preservation', () => {
  test('post-snapshot replay preserves the seam-restored title and titleSource', () => {
    const sessionId = 'seam-title-ses';
    const surface = makeTestSurface(tmpDir);
    const journalPath = journalPathFor(surface, sessionId);
    writeJournalWithRecords(journalPath, sessionId, 2);

    // The resume seam hydrates session identity (title + titleSource) onto the
    // live conversation BEFORE replay runs. Simulate that hydration.
    const conversation = new ConversationManager();
    conversation.fromJSON({
      messages: [],
      title: 'Restored Session Title',
      titleSource: 'user',
    });
    expect(conversation.title).toBe('Restored Session Title');
    expect(conversation.getTitleSource()).toBe('user');

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    // Records were replayed (messages applied)...
    expect(result.replayed).toBeGreaterThan(0);
    expect(conversation.getMessageCount()).toBeGreaterThan(0);

    // ...but the toJSON-spread fromJSON preserved the seam-restored identity.
    // A bare fromJSON({ messages }) would have blanked the title and reset
    // titleSource to the system default.
    expect(conversation.title).toBe('Restored Session Title');
    expect(conversation.getTitleSource()).toBe('user');
  });
});

describe('authoritative-record selection', () => {
  test('newest-ts append wins over a stale high-seq tail from a non-rotated journal', () => {
    const sessionId = 'seam-seqcollision';
    const journalPath = journalPathFor(makeTestSurface(tmpDir), sessionId);
    const snapshotTimestamp = Date.now() - 10_000;
    const base = Date.now() - 5000;

    // A prior process left this journal WITHOUT rotating: old records
    // (seq 0..2, earlier ts, STALE 10-message snapshots) are followed by a
    // fresh process's appends that restart at seq 0 (NEWER ts, CURRENT
    // 3-message snapshot). Sorting by seq alone leaves the stale seq-2 record
    // last, recovery must instead pick the record with the newest ts.
    const dir = join(journalPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      version: JOURNAL_SCHEMA_VERSION,
      sessionId,
      createdAt: base,
    });
    const stale = (seq: number, ts: number) =>
      JSON.stringify({ type: 'assistant_turn', seq, ts, messages: makeMessages(10) });
    const fresh = (seq: number, ts: number, count: number) =>
      JSON.stringify({ type: 'assistant_turn', seq, ts, messages: makeMessages(count) });
    writeFileSync(
      journalPath,
      [
        header,
        stale(0, base + 100),
        stale(1, base + 200),
        stale(2, base + 300), // sorts LAST by seq, but is STALE
        fresh(0, base + 1000, 2),
        fresh(1, base + 1100, 3), // NEWEST ts — authoritative
        '',
      ].join('\n'),
      'utf-8',
    );

    const conversation = new ConversationManager();
    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    // All five records post-date the snapshot.
    expect(result.replayed).toBe(5);
    // Authoritative record is the newest-ts append (3 messages), NOT the stale
    // seq-2 record (10 messages) that the seq-sort leaves last.
    expect(conversation.getMessageCount()).toBe(3);
  });

  test('ties on ts are broken by the highest seq', () => {
    const sessionId = 'seam-seqtie';
    const journalPath = journalPathFor(makeTestSurface(tmpDir), sessionId);
    const snapshotTimestamp = Date.now() - 10_000;
    const sameTs = Date.now() - 1000;

    const dir = join(journalPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      version: JOURNAL_SCHEMA_VERSION,
      sessionId,
      createdAt: sameTs,
    });
    // Two records share the max ts; the higher seq carries the current state.
    const r0 = JSON.stringify({ type: 'assistant_turn', seq: 0, ts: sameTs, messages: makeMessages(7) });
    const r1 = JSON.stringify({ type: 'assistant_turn', seq: 1, ts: sameTs, messages: makeMessages(4) });
    writeFileSync(journalPath, [header, r0, r1, ''].join('\n'), 'utf-8');

    const conversation = new ConversationManager();
    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBe(2);
    // Tie on ts → highest seq (r1, 4 messages) wins.
    expect(conversation.getMessageCount()).toBe(4);
  });
});
