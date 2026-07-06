/**
 * thinking-phrases.ts — the rotating "thinking" phrase pool, hoisted from
 * `goodvibes-tui` src/renderer/ui-factory.ts (THINKING_PHRASES). Verbatim
 * identical to the agent's copy today (per the W4-R1 parity audit) — a pure
 * move, no reconciliation needed.
 *
 * Vaporwave / good-vibes themed; shown by waitingPhrase()'s 'thinking' case
 * while a turn is genuinely producing tokens at a normal cadence (see
 * waiting-wording.ts).
 */
export const THINKING_PHRASES = [
  'Thinking...',
  'Vibing...',
  'Manifesting...',
  'Channeling energy...',
  'Tuning frequencies...',
  'Riding the wave...',
  'Aligning chakras...',
  'Entering flow state...',
  'Consulting the void...',
  'Absorbing aesthetics...',
  'Synthesizing vibes...',
  'Transcending...',
  'Dreaming in neon...',
  'Parsing the cosmos...',
  'Loading good vibes...',
  'Meditating...',
  'Catching a vibe...',
  'Harmonizing...',
  'Feeling it...',
  'In the zone...',
] as const;
