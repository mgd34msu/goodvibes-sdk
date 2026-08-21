/**
 * conversation-fold-policy.ts, the ONE statement of what a folded transcript
 * block is, shared by every terminal product.
 *
 * A folded block is exactly ONE row: the block's own header line, with the
 * `▸ N lines` badge as the only statement of size and the head of the content
 * riding the same row. No frame rows, no interior padding row, no separate
 * hidden-count marker, and no blank rows between consecutive folded tool rows.
 *
 * The TUI and the Agent each carry a thin adapter that threads their local
 * render-node types into these predicates. The decisions themselves, the
 * short-content threshold, the fold default, the separator rule, the preview
 * rule, live here and ONLY here. The owner ordered this consolidation after
 * the two renderers drifted apart four separate times; a product that wants a
 * different answer changes this module, where the other product's parity tests
 * will see it, not its own copy, where they will not.
 *
 * Everything here is PURE and structurally typed: no render-node imports, no
 * collapse-state writes.
 */

/**
 * Longest tool-result content that renders expanded on its own merits. A
 * result at or under this size is cheaper to just show than to fold behind a
 * toggle, unless a one-line summary exists, which is the better row, with the
 * raw payload behind the toggle.
 */
export const FOLDED_SHORT_CONTENT_CHARS = 200;

/**
 * Fewer preview columns than this and the preview is dropped entirely rather
 * than rendered as unreadable confetti; the row falls back to label + badge.
 */
export const FOLD_PREVIEW_MIN_COLS = 6;

/**
 * Does a tool-result block render FOLDED (one compact header row with the
 * preview on it) rather than header-plus-expanded-body?
 *
 * - Short content with no summary renders expanded: folding it would trade the
 *   body for a badge that says almost the same thing.
 * - Otherwise the stored collapse state answers; an unset key answers the same
 *   as the default the row itself will store (collapsed), so asking before and
 *   after the row renders give the same answer.
 */
export function foldedToolResult(input: {
  readonly contentLength: number;
  readonly hasSummary: boolean;
  readonly storedCollapsed: boolean | undefined;
}): boolean {
  const isShort = input.contentLength <= FOLDED_SHORT_CONTENT_CHARS && !input.hasSummary;
  if (isShort) return false;
  return input.storedCollapsed ?? true;
}

/**
 * The blank separator that follows a planned transcript row.
 *
 * Branch rows sit tight under their parent, so the blank lands only after the
 * last row of a top-level unit. On top of that, a folded row followed by more
 * tool machinery gets NO blank at all: N consecutive folded results stack as N
 * adjacent single rows. A folded row followed by anything else, prose, a
 * system notice, keeps its blank, so the run still separates from what reads
 * around it.
 */
export function trailingBlankAfterRow(input: {
  /** The next planned row is a branch row (depth > 0) under the same unit. */
  readonly nextIsBranchRow: boolean;
  /** The next planned row is tool machinery: a tool call, or a tool result. */
  readonly nextIsToolMachinery: boolean;
  /** This row renders as exactly one folded tool-result line. */
  readonly rowRendersFolded: boolean;
}): boolean {
  if (input.nextIsBranchRow) return false;
  if (input.nextIsToolMachinery && input.rowRendersFolded) return false;
  return true;
}

/**
 * The preview text that rides a folded row after its badge, or null when it
 * must not render at all.
 *
 * Whitespace (newlines included) flattens to single spaces so the preview is
 * one visual run; below FOLD_PREVIEW_MIN_COLS the preview is dropped rather
 * than truncated into noise. TRUNCATION to the column budget stays with the
 * caller, whose display-width rules (wide glyphs, ANSI) are product-local,
 * but a caller must truncate, never wrap: wrapping would grow the row back
 * into the multi-line shape this policy exists to end.
 */
export function foldPreviewText(raw: string, availableCols: number): string | null {
  if (availableCols < FOLD_PREVIEW_MIN_COLS) return null;
  const flattened = raw.replace(/\s+/g, ' ').trim();
  return flattened.length === 0 ? null : flattened;
}
