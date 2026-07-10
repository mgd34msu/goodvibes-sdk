/**
 * Per-hunk reverse-apply on the working tree (checkpoints.revertHunk).
 *
 * Covers the pure reverse-applier (clean apply, line-drift relocation, stale +
 * ambiguous + malformed conflicts, single-hunk enforcement) and the workspace
 * orchestrator (snapshot-before-write undo point, conflict-throws-without-write,
 * path-escape refusal).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyHunkRevert,
  HunkRevertConflictError,
  previewHunkRevert,
  reverseApplyHunk,
  type HunkRevertWorkspace,
} from '../packages/sdk/src/platform/workspace/hunk-revert.js';
import type { WorkspaceCheckpoint } from '../packages/sdk/src/platform/workspace/checkpoint/types.js';
import {
  createCheckpointsRevertHunkHandler,
  createCheckpointsRevertHunkPreviewHandler,
  type CheckpointsEventSink,
  type CheckpointsGatewayManager,
} from '../packages/sdk/src/platform/control-plane/routes/checkpoints.js';
import { RestoreTokenStore } from '../packages/sdk/src/platform/control-plane/routes/checkpoint-restore-tokens.js';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.js';
import type { WorkspaceEvent } from '../packages/sdk/src/events/workspace.js';

// A file that went from three lines to four (one line changed, one added).
const FORWARD_HUNK = [
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 20;',
  '+const c = 3;',
  ' const d = 4;',
].join('\n');

const NEW_CONTENT = ['const a = 1;', 'const b = 20;', 'const c = 3;', 'const d = 4;', ''].join('\n');
const OLD_CONTENT = ['const a = 1;', 'const b = 2;', 'const d = 4;', ''].join('\n');

describe('reverseApplyHunk (pure)', () => {
  test('reverses one hunk cleanly, restoring the old side', () => {
    const result = reverseApplyHunk(NEW_CONTENT, FORWARD_HUNK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextContent).toBe(OLD_CONTENT);
    expect(result.addedLinesRemoved).toBe(2);
    expect(result.removedLinesRestored).toBe(1);
    expect(result.hunkHeader).toBe('@@ -1,3 +1,4 @@');
    expect(result.matchedAtLine).toBe(1);
  });

  test('relocates by content when line numbers drifted from an unrelated earlier edit', () => {
    // Prepend two unrelated lines: the header says line 1 but the block is at 3.
    const drifted = ['// header', '// header2', ...NEW_CONTENT.split('\n')].join('\n');
    const result = reverseApplyHunk(drifted, FORWARD_HUNK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedAtLine).toBe(3);
    expect(result.nextContent).toBe(['// header', '// header2', ...OLD_CONTENT.split('\n')].join('\n'));
  });

  test('stale hunk (new side absent) is a conflict, not a write', () => {
    const result = reverseApplyHunk(OLD_CONTENT, FORWARD_HUNK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('does not apply');
  });

  test('ambiguous match (new side occurs twice, not at header line) is a conflict', () => {
    // Header says line 1, but line 1 does not match, and the new-side block
    // occurs at two other locations — genuinely ambiguous.
    const block = NEW_CONTENT.split('\n').filter((l) => l !== '');
    const twice = ['// unrelated', ...block, '// gap', ...block, ''].join('\n');
    const result = reverseApplyHunk(twice, FORWARD_HUNK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ambiguous');
  });

  test('more than one hunk is rejected (revert exactly one)', () => {
    const two = FORWARD_HUNK + '\n' + FORWARD_HUNK;
    const result = reverseApplyHunk(NEW_CONTENT, two);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('more than one hunk');
  });

  test('input that is not a hunk is a conflict', () => {
    const result = reverseApplyHunk(NEW_CONTENT, 'not a diff at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not a unified-diff hunk');
  });
});

describe('applyHunkRevert / previewHunkRevert (workspace)', () => {
  let root: string;
  const created: Array<{ kind: string; label: string }> = [];

  function fakeWorkspace(snapshot: WorkspaceCheckpoint | null): HunkRevertWorkspace {
    return {
      workspaceRoot: root,
      create: async (opts) => {
        created.push({ kind: opts.kind, label: opts.label });
        return snapshot;
      },
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hunk-revert-'));
    created.length = 0;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('preview reports a clean hunk applies without mutating the file', () => {
    writeFileSync(join(root, 'f.ts'), NEW_CONTENT, 'utf8');
    const preview = previewHunkRevert(root, 'f.ts', FORWARD_HUNK);
    expect(preview.applies).toBe(true);
    expect(preview.conflict).toBeNull();
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(NEW_CONTENT);
  });

  test('apply snapshots first (undo point) then writes the reversed content', async () => {
    writeFileSync(join(root, 'f.ts'), NEW_CONTENT, 'utf8');
    const snapshot = { id: 'wcp_safety', kind: 'manual', label: '', createdAt: 1, parentId: null, retentionClass: 'standard', commit: 'abc', sizeBytes: 1 } as WorkspaceCheckpoint;
    const receipt = await applyHunkRevert(fakeWorkspace(snapshot), 'f.ts', FORWARD_HUNK);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('manual');
    expect(receipt.safetyCheckpointId).toBe('wcp_safety');
    expect(receipt.undo).toEqual({ restoreCheckpointId: 'wcp_safety' });
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(OLD_CONTENT);
  });

  test('a stale hunk throws a conflict and never writes', async () => {
    writeFileSync(join(root, 'f.ts'), OLD_CONTENT, 'utf8');
    await expect(applyHunkRevert(fakeWorkspace(null), 'f.ts', FORWARD_HUNK)).rejects.toBeInstanceOf(HunkRevertConflictError);
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(OLD_CONTENT);
    expect(created).toHaveLength(0);
  });

  test('a path escaping the workspace root is refused', () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    const preview = previewHunkRevert(root, '../escape.ts', FORWARD_HUNK);
    expect(preview.applies).toBe(false);
    expect(preview.conflict).toContain('escapes the workspace root');
  });
});

describe('checkpoints.revertHunk handlers (confirm gate)', () => {
  let root: string;

  function manager(): CheckpointsGatewayManager {
    const stub = {
      workspaceRoot: root,
      create: async () => ({ id: 'wcp_safety', kind: 'manual', label: '', createdAt: 1, parentId: null, retentionClass: 'standard', commit: 'c', sizeBytes: 1 } as WorkspaceCheckpoint),
    };
    return stub as unknown as CheckpointsGatewayManager;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hunk-revert-h-'));
    writeFileSync(join(root, 'f.ts'), NEW_CONTENT, 'utf8');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('unconfirmed apply returns a non-error refusal and writes nothing', async () => {
    const apply = createCheckpointsRevertHunkHandler(manager(), new RestoreTokenStore());
    const res = (await apply({ body: { path: 'f.ts', hunk: FORWARD_HUNK } })) as { receipt: unknown; refused: boolean; refusal: { previewMethod: string } };
    expect(res.refused).toBe(true);
    expect(res.receipt).toBeNull();
    expect(res.refusal.previewMethod).toBe('checkpoints.revertHunkPreview');
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(NEW_CONTENT);
  });

  test('a preview token authorizes exactly one apply, then is spent', async () => {
    const tokens = new RestoreTokenStore();
    const preview = createCheckpointsRevertHunkPreviewHandler(manager(), tokens);
    const p = (await preview({ body: { path: 'f.ts', hunk: FORWARD_HUNK } })) as { applies: boolean; token: string };
    expect(p.applies).toBe(true);
    expect(typeof p.token).toBe('string');

    const events: WorkspaceEvent[] = [];
    const emit: CheckpointsEventSink = (e) => events.push(e);
    const apply = createCheckpointsRevertHunkHandler(manager(), tokens, emit);
    const ok = (await apply({ body: { path: 'f.ts', hunk: FORWARD_HUNK, confirmToken: p.token } })) as { receipt: { reverted: boolean }; refused: boolean };
    expect(ok.refused).toBe(false);
    expect(ok.receipt.reverted).toBe(true);
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(OLD_CONTENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('HUNK_REVERTED');

    // Token is single-use: a second apply with the same token is a 400.
    await expect(apply({ body: { path: 'f.ts', hunk: FORWARD_HUNK, confirmToken: p.token } })).rejects.toBeInstanceOf(GatewayVerbError);
  });

  test('a stale hunk under confirm:true is a 409 conflict', async () => {
    writeFileSync(join(root, 'f.ts'), OLD_CONTENT, 'utf8');
    const apply = createCheckpointsRevertHunkHandler(manager(), new RestoreTokenStore());
    try {
      await apply({ body: { path: 'f.ts', hunk: FORWARD_HUNK, confirm: true } });
      throw new Error('expected a conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayVerbError);
      expect((err as GatewayVerbError).status).toBe(409);
    }
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(OLD_CONTENT);
  });
});
