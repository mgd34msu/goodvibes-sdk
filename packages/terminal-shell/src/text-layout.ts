/**
 * text-layout.ts — column-arithmetic helpers for laying text out in a
 * fixed-width terminal.
 *
 * Both helpers measure in DISPLAY cells, not code units: the SDK's
 * `getDisplayWidth` accounts for wide (CJK/emoji) glyphs and zero-width
 * sequences, so a line that fits by `.length` can still overflow the column
 * budget. Everything here goes through it.
 */
import { getDisplayWidth, truncateDisplay, wrapText } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Wrap `text` to `width` display columns, prefixing every line after the first
 * with `indent` (a hanging indent). Continuation lines are truncated to the
 * width that remains after the indent, so an indented line never exceeds the
 * same budget as the first.
 *
 * `width` floors at 1: a zero or negative budget would make the continuation
 * truncation width negative and drop content silently.
 *
 * @param maxLines - When set, keep at most this many lines (no ellipsis is
 *   appended — the caller decides how to signal the elision).
 */
export function wrapWithHangingIndent(
  text: string,
  width: number,
  indent: string,
  maxLines?: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const indentWidth = getDisplayWidth(indent);
  const wrapped = wrapText(text, safeWidth);
  const lines = wrapped.map((line, index) => {
    if (index === 0) return truncateDisplay(line, safeWidth);
    return `${indent}${truncateDisplay(line, Math.max(1, safeWidth - indentWidth))}`;
  });
  return typeof maxLines === 'number' ? lines.slice(0, maxLines) : lines;
}

/**
 * Split a total column budget into a label column and a detail column with a
 * two-column gutter between them.
 *
 * The label column is clamped to at least 10 columns (below that a label is
 * unreadable) and at most `totalWidth - 2` (the gutter must survive), which
 * means the detail column can legitimately collapse to 0 on a very narrow
 * terminal — callers should treat a 0 detail width as "omit the detail".
 */
export function fitLabelDetailColumns(
  label: string,
  detail: string,
  totalWidth: number,
  labelRatio = 0.55,
): { labelWidth: number; detailWidth: number } {
  const safeWidth = Math.max(8, totalWidth);
  const labelWidth = Math.max(10, Math.min(safeWidth - 2, Math.floor(safeWidth * labelRatio)));
  return {
    labelWidth,
    detailWidth: Math.max(0, safeWidth - labelWidth - 2),
  };
}
