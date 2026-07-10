/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * hunk-revert.ts — per-hunk reverse-apply on the live working tree.
 *
 * The comment-on-hunk review surfaces (the TUI's /review, the webui's
 * SessionChanges) hand back a single unified-diff hunk — one `@@ … @@` block
 * copied verbatim out of the SAME diff `checkpoints.diff` / `sessions.changes.get`
 * produced — and ask for exactly that one hunk to be undone. This module reverses
 * ONE hunk against the current file content and nothing else.
 *
 * Two hard rules make it safe to expose as a confirm-gated verb:
 *   1. CLEAN-OR-NOTHING. The reverse patch is applied only when the hunk's
 *      new-side lines (context + additions) still match the file exactly, either
 *      at the header's line or at a single unambiguous location. A file that has
 *      drifted since the diff was taken (a stale hunk) yields a conflict result,
 *      never a partial or fuzzy write. `reverseApplyHunk` is pure — it computes
 *      the next content or a conflict and touches nothing.
 *   2. SNAPSHOT-BEFORE-MUTATE. `applyHunkRevert` takes a whole-tree checkpoint
 *      (the same safety idiom `checkpoints.restore` uses) before it writes, so
 *      the revert is itself reversible — restore that checkpoint to undo it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { WorkspaceCheckpoint } from './checkpoint/types.js';

/** Thrown when a hunk cannot be reverse-applied cleanly (stale/drifted/malformed). */
export class HunkRevertConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HunkRevertConflictError';
  }
}

/** Successful reverse-apply of one hunk: the next file content and what changed. */
export interface RevertHunkSuccess {
  readonly ok: true;
  /** The full file content after the single hunk has been reversed. */
  readonly nextContent: string;
  /** The `@@ … @@` header line of the hunk, echoed back for the receipt. */
  readonly hunkHeader: string;
  /** Count of `+` (added) lines the forward hunk introduced — removed by the revert. */
  readonly addedLinesRemoved: number;
  /** Count of `-` (removed) lines the forward hunk deleted — restored by the revert. */
  readonly removedLinesRestored: number;
  /** 1-based line where the hunk's new-side block matched the current file. */
  readonly matchedAtLine: number;
}

/** A hunk that will not reverse-apply cleanly (never a partial write). */
export interface RevertHunkConflict {
  readonly ok: false;
  readonly reason: string;
}

export type RevertHunkResult = RevertHunkSuccess | RevertHunkConflict;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedHunk {
  readonly header: string;
  readonly newStart: number;
  /** New-side block: context + added lines (what the current file is expected to contain). */
  readonly newBlock: readonly string[];
  /** Old-side block: context + removed lines (what the revert writes back). */
  readonly oldBlock: readonly string[];
  readonly addedCount: number;
  readonly removedCount: number;
}

/**
 * Parse a single unified-diff hunk. Rejects input with zero or more than one
 * `@@` header — this verb reverts exactly one hunk, so a multi-hunk paste is a
 * caller error, not something to partially honor.
 */
function parseSingleHunk(hunk: string): ParsedHunk {
  const lines = hunk.split('\n');
  const headerIdxs = lines
    .map((line, i) => (HUNK_HEADER_RE.test(line) ? i : -1))
    .filter((i) => i >= 0);
  if (headerIdxs.length === 0) {
    throw new HunkRevertConflictError('input is not a unified-diff hunk: no "@@ … @@" header found');
  }
  if (headerIdxs.length > 1) {
    throw new HunkRevertConflictError('input contains more than one hunk; revert exactly one "@@ … @@" hunk at a time');
  }
  const headerIdx = headerIdxs[0]!;
  const header = lines[headerIdx]!;
  const match = HUNK_HEADER_RE.exec(header)!;
  const newStart = Number(match[3]);

  const newBlock: string[] = [];
  const oldBlock: string[] = [];
  let addedCount = 0;
  let removedCount = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    // A trailing empty element from split() (file/hunk ended with a newline) is
    // not a body line; the "\ No newline at end of file" marker is metadata.
    if (raw.length === 0) continue;
    if (raw.startsWith('\\')) continue;
    const prefix = raw[0];
    const body = raw.slice(1);
    if (prefix === ' ') {
      newBlock.push(body);
      oldBlock.push(body);
    } else if (prefix === '+') {
      newBlock.push(body);
      addedCount++;
    } else if (prefix === '-') {
      oldBlock.push(body);
      removedCount++;
    } else {
      throw new HunkRevertConflictError(`malformed hunk body line (expected leading space/+/-): ${JSON.stringify(raw)}`);
    }
  }
  if (addedCount === 0 && removedCount === 0) {
    throw new HunkRevertConflictError('hunk changes nothing (no + or - lines); nothing to revert');
  }
  return { header, newStart, newBlock, oldBlock, addedCount, removedCount };
}

/** Does `block` occur in `lines` starting exactly at index `at`? */
function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false;
  for (let i = 0; i < block.length; i++) {
    if (lines[at + i] !== block[i]) return false;
  }
  return true;
}

/** Every 0-based index where `block` occurs in `lines`. */
function allMatchOffsets(lines: readonly string[], block: readonly string[]): number[] {
  const offsets: number[] = [];
  if (block.length === 0) return offsets;
  for (let at = 0; at + block.length <= lines.length; at++) {
    if (matchesAt(lines, block, at)) offsets.push(at);
  }
  return offsets;
}

/**
 * Reverse-apply ONE hunk to `fileContent`, pure. Succeeds only when the hunk's
 * new-side block still matches the file — at the header's line, or (if line
 * numbers drifted from unrelated edits) at a single unambiguous location. Any
 * ambiguity or mismatch is a conflict, never a partial write.
 */
export function reverseApplyHunk(fileContent: string, hunk: string): RevertHunkResult {
  let parsed: ParsedHunk;
  try {
    parsed = parseSingleHunk(hunk);
  } catch (err) {
    if (err instanceof HunkRevertConflictError) return { ok: false, reason: err.message };
    throw err;
  }
  const { header, newStart, newBlock, oldBlock, addedCount, removedCount } = parsed;
  if (newBlock.length === 0) {
    // A pure insertion with no surrounding context: nothing anchors the reverse
    // location, so we refuse rather than guess where to delete.
    return { ok: false, reason: 'hunk has no context or unchanged lines to anchor the reverse apply' };
  }
  const lines = fileContent.split('\n');

  const preferred = newStart - 1;
  let at: number;
  if (matchesAt(lines, newBlock, preferred)) {
    at = preferred;
  } else {
    const offsets = allMatchOffsets(lines, newBlock);
    if (offsets.length === 1) {
      at = offsets[0]!;
    } else if (offsets.length === 0) {
      return {
        ok: false,
        reason: 'hunk does not apply: its changed lines are not present in the current file (it changed since the diff was taken)',
      };
    } else {
      return {
        ok: false,
        reason: `hunk is ambiguous: its lines occur ${offsets.length} times in the current file and not at the expected position`,
      };
    }
  }

  const next = [...lines.slice(0, at), ...oldBlock, ...lines.slice(at + newBlock.length)];
  return {
    ok: true,
    nextContent: next.join('\n'),
    hunkHeader: header,
    addedLinesRemoved: addedCount,
    removedLinesRestored: removedCount,
    matchedAtLine: at + 1,
  };
}

/** Resolve `relPath` under `root`, refusing any path that escapes the workspace root. */
function resolveInsideRoot(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new HunkRevertConflictError(`path must be workspace-relative, got absolute path: ${relPath}`);
  }
  const resolved = resolve(root, relPath);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new HunkRevertConflictError(`path escapes the workspace root: ${relPath}`);
  }
  return resolved;
}

/** Read a workspace file's content, mapping a missing file to a conflict (the diff is stale). */
function readWorkspaceFile(root: string, relPath: string): string {
  const abs = resolveInsideRoot(root, relPath);
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    throw new HunkRevertConflictError(`file not found in the workspace: ${relPath} (it may have been moved or deleted since the diff was taken)`);
  }
}

/** A read-only preview of whether one hunk would reverse-apply cleanly right now. */
export interface HunkRevertPreview {
  readonly path: string;
  readonly applies: boolean;
  readonly conflict: string | null;
  readonly hunkHeader: string | null;
  readonly addedLinesRemoved: number;
  readonly removedLinesRestored: number;
  readonly matchedAtLine: number | null;
}

/** Compute, WITHOUT mutating anything, whether reverting `hunk` in `path` would apply cleanly. */
export function previewHunkRevert(workspaceRoot: string, path: string, hunk: string): HunkRevertPreview {
  let content: string;
  try {
    content = readWorkspaceFile(workspaceRoot, path);
  } catch (err) {
    if (err instanceof HunkRevertConflictError) {
      return { path, applies: false, conflict: err.message, hunkHeader: null, addedLinesRemoved: 0, removedLinesRestored: 0, matchedAtLine: null };
    }
    throw err;
  }
  const result = reverseApplyHunk(content, hunk);
  if (!result.ok) {
    return { path, applies: false, conflict: result.reason, hunkHeader: null, addedLinesRemoved: 0, removedLinesRestored: 0, matchedAtLine: null };
  }
  return {
    path,
    applies: true,
    conflict: null,
    hunkHeader: result.hunkHeader,
    addedLinesRemoved: result.addedLinesRemoved,
    removedLinesRestored: result.removedLinesRestored,
    matchedAtLine: result.matchedAtLine,
  };
}

/** The workspace surface `applyHunkRevert` needs: where files live, and the safety-snapshot idiom. */
export interface HunkRevertWorkspace {
  readonly workspaceRoot: string;
  /** Take a whole-tree snapshot; returns null when the tree is unchanged since the last checkpoint. */
  create(opts: { kind: 'manual'; label: string }): Promise<WorkspaceCheckpoint | null>;
}

/** Receipt of a single applied hunk revert — reversible via the safety checkpoint. */
export interface HunkRevertReceipt {
  readonly reverted: boolean;
  readonly path: string;
  readonly hunkHeader: string;
  readonly addedLinesRemoved: number;
  readonly removedLinesRestored: number;
  /** The pre-revert whole-tree checkpoint; restore it to undo. Null only when the tree was already identical to the latest checkpoint. */
  readonly safetyCheckpointId: string | null;
  readonly undo: { readonly restoreCheckpointId: string } | null;
}

/**
 * Reverse-apply one hunk to a workspace file, snapshotting first. Re-reads and
 * re-validates the current file (a hunk that went stale between preview and here
 * is a conflict, never a partial write), takes a whole-tree safety checkpoint as
 * the undo point, then writes the reversed content.
 */
export async function applyHunkRevert(
  workspace: HunkRevertWorkspace,
  path: string,
  hunk: string,
): Promise<HunkRevertReceipt> {
  const content = readWorkspaceFile(workspace.workspaceRoot, path);
  const result = reverseApplyHunk(content, hunk);
  if (!result.ok) {
    throw new HunkRevertConflictError(result.reason);
  }
  // Snapshot BEFORE mutating so the revert is itself reversible (restore this
  // checkpoint to undo). A null return means the tree already matched the latest
  // checkpoint — the pre-revert state is already captured, so there is nothing to
  // undo-point beyond it.
  const safety = await workspace.create({ kind: 'manual', label: `pre-revertHunk: ${path}` });
  const abs = resolveInsideRoot(workspace.workspaceRoot, path);
  writeFileSync(abs, result.nextContent, 'utf8');
  return {
    reverted: true,
    path,
    hunkHeader: result.hunkHeader,
    addedLinesRemoved: result.addedLinesRemoved,
    removedLinesRestored: result.removedLinesRestored,
    safetyCheckpointId: safety?.id ?? null,
    undo: safety ? { restoreCheckpointId: safety.id } : null,
  };
}
