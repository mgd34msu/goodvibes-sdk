/**
 * The shared fold policy: one row per folded block, and the exact rules the
 * TUI and Agent renderers both read. These tests pin the decisions the two
 * products previously each carried a copy of — the copies drifted four times;
 * the policy lives here now so a change is visible to every consumer at once.
 */
import { describe, expect, test } from 'bun:test';
import {
  FOLDED_SHORT_CONTENT_CHARS,
  FOLD_PREVIEW_MIN_COLS,
  foldedToolResult,
  foldPreviewText,
  trailingBlankAfterRow,
} from '../packages/terminal-shell/src/index.ts';

describe('foldedToolResult', () => {
  test('short content with no summary renders expanded', () => {
    expect(foldedToolResult({ contentLength: FOLDED_SHORT_CONTENT_CHARS, hasSummary: false, storedCollapsed: undefined })).toBe(false);
    expect(foldedToolResult({ contentLength: 1, hasSummary: false, storedCollapsed: true })).toBe(false);
  });

  test('a summarizable result folds even when short — the summary is the better row', () => {
    expect(foldedToolResult({ contentLength: 10, hasSummary: true, storedCollapsed: undefined })).toBe(true);
  });

  test('long content defaults to folded; stored state wins either way', () => {
    expect(foldedToolResult({ contentLength: 5000, hasSummary: false, storedCollapsed: undefined })).toBe(true);
    expect(foldedToolResult({ contentLength: 5000, hasSummary: false, storedCollapsed: false })).toBe(false);
    expect(foldedToolResult({ contentLength: 5000, hasSummary: false, storedCollapsed: true })).toBe(true);
  });
});

describe('trailingBlankAfterRow', () => {
  test('branch rows sit tight under their parent — never a blank', () => {
    expect(trailingBlankAfterRow({ nextIsBranchRow: true, nextIsToolMachinery: true, rowRendersFolded: true })).toBe(false);
    expect(trailingBlankAfterRow({ nextIsBranchRow: true, nextIsToolMachinery: false, rowRendersFolded: false })).toBe(false);
  });

  test('consecutive folded tool rows stack with no blank between them', () => {
    expect(trailingBlankAfterRow({ nextIsBranchRow: false, nextIsToolMachinery: true, rowRendersFolded: true })).toBe(false);
  });

  test('a folded row followed by prose keeps its blank — the run separates from the answer', () => {
    expect(trailingBlankAfterRow({ nextIsBranchRow: false, nextIsToolMachinery: false, rowRendersFolded: true })).toBe(true);
  });

  test('an expanded row followed by tool machinery keeps the ordinary unit blank', () => {
    expect(trailingBlankAfterRow({ nextIsBranchRow: false, nextIsToolMachinery: true, rowRendersFolded: false })).toBe(true);
  });
});

describe('foldPreviewText', () => {
  test('whitespace and newlines flatten to one visual run', () => {
    expect(foldPreviewText('a\n  b\t\tc', 80)).toBe('a b c');
  });

  test('below the minimum column budget the preview drops entirely', () => {
    expect(foldPreviewText('plenty of text', FOLD_PREVIEW_MIN_COLS - 1)).toBeNull();
    expect(foldPreviewText('plenty of text', FOLD_PREVIEW_MIN_COLS)).toBe('plenty of text');
  });

  test('empty or whitespace-only content yields no preview row-tail', () => {
    expect(foldPreviewText('   \n \t ', 80)).toBeNull();
    expect(foldPreviewText('', 80)).toBeNull();
  });
});
