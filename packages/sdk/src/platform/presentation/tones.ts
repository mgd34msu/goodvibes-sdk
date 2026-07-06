/**
 * tones.ts — the canonical UI tone-token table, hoisted from `goodvibes-tui`
 * src/renderer/ui-primitives.ts (UI_TONES + DIFF_TONES + SPINNER_FRAMES) and
 * src/renderer/theme.ts (resolveUiTones / UI_TONES_LIGHT).
 *
 * TONE_TOKENS mirrors the TUI's UI_TONES shape byte-for-byte (the TUI is the
 * reference, and its dark values are the accepted baseline — this keeps a
 * future TUI swap onto this module a no-op). resolveTones(mode) is the single
 * mode-resolved read path: 'dark' returns TONE_TOKENS itself (so a byte-identity
 * check against the constant is trivially true), 'light' returns the inverted
 * chrome/accent variant tuned for legibility on a light terminal background.
 *
 * This module is PURE data — no fs, no terminal I/O, no process globals.
 * Painting stays renderer-owned; this module owns only the token values and
 * the mode-resolution function.
 */

/** Background mode — dark is the safe default until a caller's own bg-probe lands. */
export type ThemeMode = 'dark' | 'light';

/** The dark-mode (reference) tone-token table. */
export const TONE_TOKENS = {
  fg: {
    primary: '#e2e8f0',
    secondary: '#cbd5e1',
    muted: '#94a3b8',
    dim: '#475569',
    inverse: '#0f172a',
    /** Empty-state / placeholder foreground. */
    empty: '#334155',
  },
  bg: {
    base: '#11131a',
    surface: '#161a22',
    title: '#0f172a',
    section: '#18202b',
    summary: '#1b2430',
    selected: '#223049',
    input: '#1e293b',
    warning: '#2b2116',
    error: '#2a161b',
    success: '#14241b',
    /** Fullscreen/shell footer background. */
    footer: '#111827',
  },
  state: {
    info: '#38bdf8',
    good: '#22c55e',
    warn: '#f59e0b',
    bad: '#ef4444',
    blocked: '#f97316',
    active: '#60a5fa',
    /** Canonical reasoning/thinking purple. */
    reasoning: '#a855f7',
  },
  accent: {
    browser: '#7dd3fc',
    control: '#22d3ee',
    inspector: '#c4b5fd',
    workflow: '#fbbf24',
    conversation: '#93c5fd',
    /** Neon brand accent — header/splash/thinking gradient only. */
    brand: '#00ffff',
    gradientStart: '#00ffff',
    gradientEnd: '#d000ff',
  },
  /** Canonical border stroke color for fullscreen/panel chrome. */
  border: '#64748b',
  /**
   * Persistent-chrome foregrounds — header / footer / live-thinking rows that
   * paint onto the TRANSPARENT terminal background (bg:''), NOT onto the
   * opaque dark modal/panel surfaces that fg.* and state.* serve. In light
   * mode this chrome sits on a light terminal and must invert toward dark to
   * stay legible, which is why it carries its own role instead of reusing
   * fg.muted/fg.dim (tuned light-on-dark for the opaque boxes). Dark values
   * here are byte-identical to the tokens they mirror (fg.muted, fg.dim,
   * state.warn, state.bad), so dark-mode chrome is unchanged by this table
   * existing.
   */
  chrome: {
    /** Secondary chrome text (header conversation title). == fg.muted (dark). */
    label: '#94a3b8',
    /** Faint chrome text (version, provider, header rule, clean git). == fg.dim (dark). */
    faint: '#475569',
    /** Warn accent on terminal bg (dirty git, pending risk). == state.warn (dark). */
    warn: '#f59e0b',
    /** Alert accent on terminal bg (DANGER banner, shell risk). == state.bad (dark). */
    bad: '#ef4444',
    /** Success accent on terminal bg (tool-call checkmark status). == state.good (dark). */
    good: '#22c55e',
    /** Remote-risk accent on terminal bg (risk:remote marker, plain status). */
    remote: '#a78bfa',
  },
} as const;

/**
 * Diff surface accent color shared across diff-rendering surfaces (conversation
 * diff view, file diff panel, git panel inline diff).
 */
export const DIFF_TONES = {
  add: '#00ff88',
  del: '#ff4444',
  hunk: '#88aaff',
} as const;

/** Single spinner-frame source. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Recursively widen the `as const` literal leaves of TONE_TOKENS to `string`
 * so the light variant can assign different colour values without fighting
 * TypeScript's literal-type inference. */
type DeepWidenToString<T> = T extends string ? string : { [K in keyof T]: DeepWidenToString<T[K]> };

/** The mode-resolved shape returned by resolveTones — same keys as TONE_TOKENS,
 * widened from literal string types to `string` so light values can differ. */
export type ToneTokens = DeepWidenToString<typeof TONE_TOKENS>;

//
// Light variant — inverts the chrome group (and the two accents/state roles
// with no light-appropriate dark equivalent: state.info/reasoning,
// accent.brand/gradientStart/gradientEnd) toward dark-on-light legibility.
// Every other role has no light-specific value yet and is carried over from
// TONE_TOKENS unchanged (spread below) — this mirrors the TUI's UI_TONES_LIGHT
// exactly, including which roles it leaves untouched.
//
const TONE_TOKENS_LIGHT: ToneTokens = {
  ...TONE_TOKENS,
  state: {
    ...TONE_TOKENS.state,
    info: '#0369a1',
    reasoning: '#7c3aed',
  },
  accent: {
    ...TONE_TOKENS.accent,
    brand: '#0077aa',
    gradientStart: '#0077aa',
    gradientEnd: '#7c3aed',
  },
  chrome: {
    ...TONE_TOKENS.chrome,
    label: '#64748b',
    faint: '#94a3b8',
    warn: '#b45309',
    bad: '#dc2626',
    good: '#15803d',
    remote: '#6d28d9',
  },
};

Object.freeze(TONE_TOKENS_LIGHT.state);
Object.freeze(TONE_TOKENS_LIGHT.accent);
Object.freeze(TONE_TOKENS_LIGHT.chrome);
Object.freeze(TONE_TOKENS_LIGHT);

/**
 * resolveTones — return the tone-token table for the given background mode.
 * 'dark' returns TONE_TOKENS itself (byte-identical, same object reference) so
 * a consumer that has not wired mode detection can call resolveTones('dark')
 * as the safe default with zero behavior change.
 */
export function resolveTones(mode: ThemeMode): Readonly<ToneTokens> {
  return mode === 'light' ? TONE_TOKENS_LIGHT : TONE_TOKENS;
}
