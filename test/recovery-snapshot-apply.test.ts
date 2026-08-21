/**
 * recovery-snapshot-apply.test.ts
 *
 * The prompted crash-restore mechanism: a snapshot the user explicitly asked
 * for goes onto the live conversation, the journal tail goes on top of it, and
 * the snapshot file is retired by the same call that applied it.
 *
 * The two rules this exists to make structural, asserted rather than described:
 *   - nothing applies without a confirmation token, and the only source of one
 *     is a user's answer;
 *   - applying and retiring are one operation, so a caller cannot leave a
 *     restored snapshot on disk to be offered again next launch.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyRecoverySnapshot,
  confirmRecoveryRestore,
} from '../packages/sdk/src/platform/runtime/recovery-snapshot-apply.ts';
import type { ConversationTitleSource } from '../packages/sdk/src/platform/core/conversation.ts';
import {
  createSessionSurface,
  type SessionSurface,
} from '../packages/sdk/src/platform/runtime/session-surface.ts';
import { writeRecoveryFile } from '../packages/sdk/src/platform/runtime/session-recovery.ts';
import {
  journalPathFor,
  openTranscriptJournal,
} from '../packages/sdk/src/platform/runtime/transcript-journal.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempSurface(): SessionSurface {
  const root = join(tmpdir(), `gv-recovery-apply-${randomUUID()}`);
  const workingDirectory = join(root, 'work');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  roots.push(root);
  return createSessionSurface({ surfaceRoot: 'tui', workingDirectory, homeDirectory });
}

/** A minimal conversation that records what was done to it. */
class TestConversation {
  messages: Array<Record<string, unknown>> = [];
  resets = 0;
  rebuilds = 0;
  title = '';
  /** When true, fromJSON throws, the "the conversation refused the restore" case. */
  rejectRestore = false;

  resetAll(): void {
    this.resets += 1;
    this.messages = [];
  }

  toJSON(): object {
    return { messages: this.messages, title: this.title, titleSource: 'system' };
  }

  fromJSON(data: { messages: unknown[]; title?: string | undefined }): void {
    if (this.rejectRestore) throw new Error('conversation refused');
    this.messages = data.messages as Array<Record<string, unknown>>;
    if (typeof data.title === 'string') this.title = data.title;
  }

  rebuildHistory(): void {
    this.rebuilds += 1;
  }

  getTitleSource(): ConversationTitleSource {
    return 'system';
  }

  getMessageCount(): number {
    return this.messages.length;
  }
}

function makeConversation(): TestConversation {
  return new TestConversation();
}

function messages(count: number, tag = 'snap'): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${tag}-${index}`,
  }));
}

const yes = confirmRecoveryRestore(true)!;

describe('the confirmation token', () => {
  test('exists only for a yes', () => {
    expect(confirmRecoveryRestore(true)).not.toBeNull();
    expect(confirmRecoveryRestore(false)).toBeNull();
  });
});

describe('applying a snapshot the user asked for', () => {
  test('restores the messages and reports the count', () => {
    const surface = tempSurface();
    writeRecoveryFile({ messages: messages(4) }, 'sess-a', 'Crashed session', { surface });

    const conversation = makeConversation();
    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-a',
      conversation,
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(true);
    expect(result.messageCount).toBe(4);
    expect(conversation.messages.map((m) => m['content'])).toEqual([
      'snap-0', 'snap-1', 'snap-2', 'snap-3',
    ]);
    // The same reset/fromJSON/rebuild sequence a normal resume runs.
    expect(conversation.resets).toBe(1);
    expect(conversation.rebuilds).toBeGreaterThanOrEqual(1);
    expect(conversation.title).toBe('Crashed session');
  });

  test('retires the snapshot file — applying and retiring are one operation', () => {
    const surface = tempSurface();
    writeRecoveryFile({ messages: messages(2) }, 'sess-b', '', { surface });
    expect(existsSync(surface.recoveryFile('sess-b'))).toBe(true);

    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-b',
      conversation: makeConversation(),
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(true);
    expect(result.retired).toBe(true);
    expect(existsSync(surface.recoveryFile('sess-b'))).toBe(false);
  });

  test('folds journal records newer than the snapshot on top of it', () => {
    const surface = tempSurface();
    writeRecoveryFile({ messages: messages(2) }, 'sess-c', '', { surface });

    // A journal tail written after the snapshot: the crash lost these from the
    // snapshot but not from the journal.
    const journal = openTranscriptJournal(journalPathFor(surface, 'sess-c'), 'sess-c');
    journal.appendRecord('assistant_turn', messages(5, 'journal') as never[]);

    const conversation = makeConversation();
    const persisted: unknown[][] = [];
    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-c',
      conversation,
      persistSnapshot: (m) => { persisted.push(m); },
      confirmation: yes,
    });

    expect(result.applied).toBe(true);
    expect(result.journalReplay.replayed).toBe(1);
    // The journal record's fuller message list won, not the snapshot's.
    expect(result.messageCount).toBe(5);
    expect(persisted).toHaveLength(1);
  });

  test('a session with no journal tail keeps exactly the snapshot', () => {
    const surface = tempSurface();
    writeRecoveryFile({ messages: messages(3) }, 'sess-d', '', { surface });

    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-d',
      conversation: makeConversation(),
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(result.journalReplay.replayed).toBe(0);
  });
});

describe('refusals say what happened', () => {
  test('no snapshot on disk applies nothing and retires nothing', () => {
    const surface = tempSurface();
    const conversation = makeConversation();

    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'never-existed',
      conversation,
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(false);
    expect(result.refusal).toBe('no-snapshot');
    expect(result.retired).toBe(false);
    expect(result.messageCount).toBe(0);
    // Critically: the live conversation was not touched on the way to finding out.
    expect(conversation.resets).toBe(0);
  });

  test('a truncated snapshot is refused rather than applied as an empty conversation', () => {
    const surface = tempSurface();
    // A meta line and nothing else, what a snapshot looks like when the
    // process died mid-write. The parser yields zero messages for it.
    mkdirSync(surface.recoveryDir, { recursive: true });
    writeFileSync(
      surface.recoveryFile('sess-truncated'),
      JSON.stringify({ type: 'meta', sessionId: 'sess-truncated', title: '', timestamp: Date.now() }) + '\n',
      'utf-8',
    );

    const conversation = makeConversation();
    conversation.messages = messages(7, 'live');

    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-truncated',
      conversation,
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(false);
    expect(result.refusal).toBe('unusable-snapshot');
    // The whole point: the live conversation still holds its messages. Applying
    // an empty snapshot here would have destroyed what the user asked to keep.
    expect(conversation.resets).toBe(0);
    expect(conversation.messages).toHaveLength(7);
  });

  test('a conversation that rejects the restore reports it instead of throwing', () => {
    const surface = tempSurface();
    writeRecoveryFile({ messages: messages(2) }, 'sess-e', '', { surface });

    const conversation = makeConversation();
    conversation.rejectRestore = true;

    const result = applyRecoverySnapshot({
      surface,
      sessionId: 'sess-e',
      conversation,
      persistSnapshot: () => {},
      confirmation: yes,
    });

    expect(result.applied).toBe(false);
    expect(result.refusal).toBe('apply-failed');
    // The load already retired it, reported honestly rather than claimed otherwise.
    expect(result.retired).toBe(true);
  });
});
