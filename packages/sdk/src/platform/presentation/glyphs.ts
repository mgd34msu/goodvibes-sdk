/**
 * glyphs.ts — the canonical glyph registry for status/frame/navigation/meter
 * rendering, hoisted from `goodvibes-tui` src/renderer/ui-primitives.ts (GLYPHS)
 * and src/renderer/status-glyphs.ts (STATE_GLYPHS).
 *
 * This is one of the four genuinely-duplicated presentation tables named by the
 * W4-R1 renderer/input parity audit (both the TUI and the agent shipped a near-twin
 * copy). The TUI is the reference: it is the more-complete, more-recently-fixed
 * copy, and per the presentation-contract decision record its `status` group is
 * the one both renderers converge on.
 *
 * Reconciliation (the one real content choice this hoist makes): the TUI and
 * agent status groups disagreed —
 *   - TUI:   idle = '◌' (U+25CC), info = '○' (U+25CB), warn = '⚠' present
 *   - agent: idle = '○' (U+25CB), info = '•' (U+2022), no `warn` key
 * GLYPHS.status below is the TUI's values verbatim. Consumers that previously
 * carried the agent's values will see idle/info visibly change when they adopt
 * this module — an intentional convergence, not a regression (see the decision
 * record's divergence ruling).
 */

/** The full glyph registry — frame/surface/navigation/status/meter groups. */
export const GLYPHS = {
  frame: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    teeLeft: '├',
    teeRight: '┤',
    teeTop: '┬',
    teeBottom: '┴',
    cross: '┼',
  },
  surface: {
    top: '▄',
    bottom: '▀',
    cursor: '█',
    altCursor: '▌',
  },
  navigation: {
    selected: '▸',
    collapsed: '▸',
    expanded: '▾',
    up: '↑',
    down: '↓',
    moreAbove: '▲',
    moreBelow: '▼',
    next: '→',
    back: '←',
    pipeSeparator: '│',
  },
  status: {
    success: '✓',
    failure: '✕',
    pending: '•',
    active: '●',
    idle: '◌',
    info: '○',
    warn: '⚠',
    blocked: '⊘',
    skipped: '◇',
    review: '◈',
    retry: '↻',
    handoff: '⇢',
    reference: '↗',
    partial: '◐',
    dualPane: '◆',
    star: '★',
  },
  meter: {
    filled: '█',
    medium: '▓',
    light: '▒',
    empty: '░',
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  },
} as const;

/** The four semantic status states STATE_GLYPHS maps onto. */
export type StatusState = 'good' | 'warn' | 'bad' | 'info';

/**
 * STATE_GLYPHS — the 4-state semantic alias map, aliased to GLYPHS.status (the
 * TUI's mechanism). The agent's twin (status-glyphs.ts) hardcoded its own
 * literals ('✓'/'⚠'/'✕'/'○') instead of aliasing a shared registry; hoisting
 * the TUI's alias pattern here means there is exactly one place these four
 * glyphs are spelled out, and STATUS_GLYPHS/GLYPHS.status can never drift
 * apart again.
 */
export const STATE_GLYPHS: Record<StatusState, string> = {
  good: GLYPHS.status.success, // ✓
  warn: GLYPHS.status.warn,    // ⚠
  bad:  GLYPHS.status.failure, // ✕
  info: GLYPHS.status.info,    // ○
};
