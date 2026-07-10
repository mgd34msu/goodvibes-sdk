/**
 * UnifiedRewindService — plan/apply over the existing history stores.
 *
 * Covers the dry-run preview + confirm-token gate, the symmetric undo point the
 * apply records (restore-the-restore), honest degradation when a store is not
 * wired, and the receipt events surfaces render.
 */
import { describe, expect, test } from 'bun:test';
import {
  UnifiedRewindService,
  RewindTokenError,
  type RewindAnchor,
  type RewindCheckpointView,
  type RewindConversationPort,
  type RewindRestoreResult,
  type RewindWorkspacePort,
} from '../packages/sdk/src/platform/rewind/index.js';
import type { WorkspaceEvent } from '../packages/sdk/src/events/workspace.js';

function fakeWorkspace(overrides: Partial<{
  checkpoints: RewindCheckpointView[];
  restore: RewindRestoreResult;
  diffFiles: string[];
  restoreCalls: Array<{ id: string; safety: boolean | undefined }>;
}> = {}): RewindWorkspacePort {
  const checkpoints = overrides.checkpoints ?? [
    { id: 'wcp_a', turnId: 'turn-1', createdAt: 100, label: 'turn 1' },
    { id: 'wcp_b', turnId: 'turn-2', createdAt: 200, label: 'turn 2' },
  ];
  const restoreResult = overrides.restore ?? {
    checkpointId: 'wcp_a',
    safetyCheckpointId: 'wcp_safety',
    restoredFiles: ['src/a.ts', 'src/b.ts'],
    removedFiles: ['src/c.ts'],
  };
  const restoreCalls = overrides.restoreCalls ?? [];
  return {
    list: async (filter) => checkpoints.filter((c) => !filter?.sessionId || true),
    diff: async () => ({ files: overrides.diffFiles ?? ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    restore: async (id, opts) => {
      restoreCalls.push({ id, safety: opts?.safetyCheckpoint });
      return { ...restoreResult, checkpointId: id };
    },
  };
}

const fakeConversation: RewindConversationPort = {
  preview: async () => ({ messagesToDrop: 4, messagesRemaining: 10 }),
  rewind: async () => ({ droppedMessages: 4, undoSnapshotId: 'conv_undo_1' }),
};

const anchor: RewindAnchor = { sessionId: 's1', turnId: 'turn-1' };

describe('rewind.plan — dry-run preview + confirm token', () => {
  test('files plan resolves the anchor checkpoint and its affected file count', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    expect(plan.files).toEqual({ available: true, checkpointId: 'wcp_a', checkpointLabel: 'turn 1', affectedFileCount: 3 });
    expect(plan.conversation).toBeNull();
    expect(plan.token).toBeTruthy();
    expect(plan.expiresAt).toBeGreaterThan(0);
    expect(plan.warnings).toHaveLength(0);
  });

  test('conversation is reported unavailable (with a warning) when no store is wired', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'both');
    expect(plan.conversation).toEqual({ available: false, messagesToDrop: 0, messagesRemaining: 0 });
    expect(plan.warnings.join(' ')).toContain('conversation rewind unavailable');
  });

  test('conversation plan uses the wired port', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace(), conversation: fakeConversation });
    const plan = await service.plan(anchor, 'conversation');
    expect(plan.conversation).toEqual({ available: true, messagesToDrop: 4, messagesRemaining: 10 });
    expect(plan.files).toBeNull();
  });

  test('with no turnId, the most-recent checkpoint for the session is chosen', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan({ sessionId: 's1' }, 'files');
    expect(plan.files?.checkpointId).toBe('wcp_b'); // createdAt 200 > 100
  });
});

describe('rewind.apply — confirm gate', () => {
  test('an unconfirmed apply returns a non-error refusal naming rewind.plan', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const result = await service.apply(anchor, 'files', {});
    expect(result.refused).toBe(true);
    expect(result.receipt).toBeNull();
    expect(result.refusal?.planMethod).toBe('rewind.plan');
    expect(result.refusal?.options).toEqual(['confirm', 'confirmToken']);
  });

  test('a valid confirm token authorizes the apply and is single-use', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    const first = await service.apply(anchor, 'files', { confirmToken: plan.token });
    expect(first.refused).toBe(false);
    expect(first.receipt?.files?.restored).toBe(true);
    // Token is spent — a replay is rejected.
    await expect(service.apply(anchor, 'files', { confirmToken: plan.token })).rejects.toBeInstanceOf(RewindTokenError);
  });

  test('a token minted for one scope does not authorize a different scope', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const plan = await service.plan(anchor, 'files');
    await expect(service.apply(anchor, 'both', { confirmToken: plan.token })).rejects.toBeInstanceOf(RewindTokenError);
  });

  test('confirm:true bypasses the token', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace() });
    const result = await service.apply(anchor, 'files', { confirm: true });
    expect(result.refused).toBe(false);
    expect(result.receipt?.files?.restored).toBe(true);
  });
});

describe('rewind.apply — symmetric undo point (restore-the-restore)', () => {
  test('applying files records the pre-restore safety checkpoint as the undo point', async () => {
    const restoreCalls: Array<{ id: string; safety: boolean | undefined }> = [];
    const service = new UnifiedRewindService({ workspace: fakeWorkspace({ restoreCalls }) });
    const receipt = (await service.apply(anchor, 'files', { confirm: true })).receipt!;
    // The workspace restore was asked to take a safety checkpoint.
    expect(restoreCalls).toEqual([{ id: 'wcp_a', safety: true }]);
    expect(receipt.files?.safetyCheckpointId).toBe('wcp_safety');
    // The receipt's undo block points back at that safety checkpoint — reversing the rewind.
    expect(receipt.undo.files).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(receipt.files?.restoredFileCount).toBe(2);
    expect(receipt.files?.removedFileCount).toBe(1);
  });

  test('both scope records undo points for files and conversation', async () => {
    const service = new UnifiedRewindService({ workspace: fakeWorkspace(), conversation: fakeConversation });
    const receipt = (await service.apply(anchor, 'both', { confirm: true })).receipt!;
    expect(receipt.undo.files).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(receipt.undo.conversation).toEqual({ undoSnapshotId: 'conv_undo_1' });
    expect(receipt.conversation?.droppedMessages).toBe(4);
  });

  test('a no-op safety checkpoint (null) yields no files undo point', async () => {
    const service = new UnifiedRewindService({
      workspace: fakeWorkspace({ restore: { checkpointId: 'wcp_a', safetyCheckpointId: null, restoredFiles: [], removedFiles: [] } }),
    });
    const receipt = (await service.apply(anchor, 'files', { confirm: true })).receipt!;
    expect(receipt.undo.files).toBeNull();
  });
});

describe('rewind — receipt events', () => {
  test('plan emits REWIND_PLANNED and apply emits REWIND_APPLIED', async () => {
    const events: Array<{ event: WorkspaceEvent; sessionId: string }> = [];
    const service = new UnifiedRewindService({
      workspace: fakeWorkspace(),
      conversation: fakeConversation,
      emit: (event, sessionId) => events.push({ event, sessionId }),
    });
    const plan = await service.plan(anchor, 'both');
    await service.apply(anchor, 'both', { confirmToken: plan.token });
    const types = events.map((e) => e.event.type);
    expect(types).toEqual(['REWIND_PLANNED', 'REWIND_APPLIED']);
    const applied = events[1]!.event;
    if (applied.type === 'REWIND_APPLIED') {
      expect(applied.filesRestored).toBe(true);
      expect(applied.conversationRewound).toBe(true);
      expect(applied.undoAvailable).toBe(true);
      expect(applied.scope).toBe('both');
    }
    expect(events[0]!.sessionId).toBe('s1');
  });
});
