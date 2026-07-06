/**
 * @pellux/goodvibes-sdk/platform/presentation
 *
 * The presentation contract — the four genuinely-duplicated presentation
 * tables named by the renderer/input parity audit (see CHANGELOG 1.0.0; goodvibes-tui vs
 * goodvibes-agent), hoisted into one pure, dependency-free module per Mike's
 * SDK-boundary rule (machinery needed by 2+ surfaces => SDK):
 *
 *  - GLYPHS / STATE_GLYPHS  — the glyph registry + semantic status-glyph alias.
 *  - TONE_TOKENS / resolveTones / DIFF_TONES / SPINNER_FRAMES — the chrome
 *    tone-token table and its dark/light mode resolution.
 *  - THINKING_PHRASES       — the rotating thinking-phrase pool.
 *  - WaitingState / waitingPhrase — the honest waiting-state wording contract.
 *
 * The TUI is the reference for every value here; dark stays byte-identical to
 * today's TUI. See docs/decisions/2026-07-05-presentation-contract-sdk-extraction.md
 * for the full decision record, including the GLYPHS status-group reconciliation
 * ruling and the consumption plan (the agent picks this up via R4; the TUI swap is
 * deferred to a future coherence pass).
 *
 * PURE — no fs, no terminal I/O, no process globals. Painting stays
 * renderer-owned; this module owns only tokens and pure wording functions.
 */

export { GLYPHS, STATE_GLYPHS, type StatusState } from './glyphs.js';

export {
  TONE_TOKENS,
  resolveTones,
  DIFF_TONES,
  SPINNER_FRAMES,
  type ThemeMode,
  type ToneTokens,
} from './tones.js';

export { THINKING_PHRASES } from './thinking-phrases.js';

export {
  waitingPhrase,
  type WaitingState,
  type WaitingPhraseContext,
} from './waiting-wording.js';
