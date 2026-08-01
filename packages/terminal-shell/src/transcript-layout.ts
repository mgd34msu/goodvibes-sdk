/**
 * transcript-layout.ts — the margin grid every transcript row is measured against.
 *
 * The two terminal front-ends each carried this object verbatim in their own
 * `renderer/layout.ts`. The tree geometry in `conversation-tree.ts` reads
 * LEFT_MARGIN and RIGHT_MARGIN out of it to place branch glyphs, so the numbers
 * have to live wherever that geometry lives or the two drift apart silently —
 * a one-column disagreement between a renderer and the tree it draws into is
 * invisible in review and obvious on screen.
 *
 * Each front-end's `renderer/layout.ts` re-exports this as its `LAYOUT`, so
 * every existing call site keeps its import and there is exactly one definition.
 */

export const TRANSCRIPT_LAYOUT = {
  LEFT_MARGIN: 4,
  RIGHT_MARGIN: 2,
  contentWidth: (termWidth: number) =>
    termWidth - TRANSCRIPT_LAYOUT.LEFT_MARGIN - TRANSCRIPT_LAYOUT.RIGHT_MARGIN,
  /** Used by createMessageBar in ui-factory.ts for user message ghost boxes. */
  USER_BOX_MARGIN: 2,
} as const;
